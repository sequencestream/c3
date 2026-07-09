/**
 * Automation execution dispatcher.
 *
 * Routes execution to the appropriate handler based on automation type:
 * - `command` → child_process.spawn with hard timeout + optional retry
 * - `llm` → SDK query() with wall-clock timeout + output schema validation
 *
 * Both handlers share the same update-log callback pattern: the caller
 * (scheduler) owns the `updateLog` closure that persists execution results.
 */

import { spawn } from 'node:child_process'
// C-SEC exception (annotated): the automation dispatcher runs UNATTENDED scheduled
// agents with its OWN three-tier MCP security model (read-only / sandboxed /
// full-access), a deliberately separate path from the interactive
// `kernel/permission` gateway. It therefore drives `query` + its own
// `canUseTool` directly — the only feature allowed to, and only for this purpose.
// eslint-disable-next-line no-restricted-imports
import { query } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentConfig,
  CodexPolicy,
  ModeToken,
  Automation,
  SessionKind,
  VendorId,
} from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { launchForAgent, setAgentEnabled } from '../../kernel/agent-config/index.js'
import { buildChildEnv, findClaudeExecutable } from '../../kernel/infra/child-env.js'
import { loadSettings } from '../../kernel/config/index.js'
import { createCodexAdapter } from '../../kernel/agent/adapters/codex/index.js'
import { codexPolicyToGrid } from '../../kernel/agent/adapters/codex/driver.js'
import { resolveCodexGhTokenEnv } from '../../kernel/agent/adapters/codex/gh-token.js'
import { getWorkspaceMcpConfig, isAgentQuotaRecoveryConfig } from './store.js'
import { freezeTools, hasSelectedC3McpTool, matchesFrozenTool, isWriteTool } from './mcp-freeze.js'
import type { FrozenToolSet } from './mcp-freeze.js'
import { createAutomationMcpServer } from './c3-mcp.js'
import type { ServedAutomationMcp } from '../../transport/automation-mcp/index.js'
import { upsertAutomationExecutionRow } from '../sessions/session-metadata-store.js'
import { setAutomationRunning, clearAutomationRunning } from '../../runs.js'

// ---------------------------------------------------------------------------
// Codex automation c3 MCP route (driver-path twin of the Claude in-process
// server). Injected by the composition root at startup — the dispatcher runs off
// the kernel run bus, so it holds the served route as a module-level handle it
// `bind()`s per Codex execution, mirroring the `configureAutomationMcp` singleton.
// ---------------------------------------------------------------------------

let automationHttpMcp: ServedAutomationMcp | null = null

/** Inject (or clear, in tests) the loopback HTTP MCP route for Codex automations. */
export function setAutomationHttpMcp(served: ServedAutomationMcp | null): void {
  automationHttpMcp = served
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The dispatcher's SessionKind: a scheduled run is launched by the scheduler with
 * NO socket and does NOT go through the run bus. Tagged `'automation'` so logs/audit
 * mark it as scheduler-originated. NOTE: this is the scheduler's *own* run; a
 * automation that is merely *triggered* by a user session does not change that
 * session's `'work'` kind — `'automation'` identifies the trigger source here. (Its
 * execution form is `runKind: 'headless'`.)
 */
const SESSION_KIND: SessionKind = 'automation'

export type UpdateLogFn = (id: string, patch: Record<string, unknown>) => void

interface CommandConfig {
  command: string
  maxRetries?: number // default 0
}

interface LlmConfig {
  prompt: string
  outputSchema?: Record<string, unknown> // JSON Schema
}

const DEFAULT_COMMAND_MAX_WALL_CLOCK_MS = 30_000
const DEFAULT_LLM_MAX_WALL_CLOCK_MS = 60_000
const CLAUDE_AUTOMATION_MODES = [
  'default',
  'auto',
  'plan',
  'acceptEdits',
  'bypassPermissions',
] as const
type ClaudeAutomationMode = (typeof CLAUDE_AUTOMATION_MODES)[number]

function maxWallClockMsFor(automation: Automation): number {
  return (
    automation.maxWallClockMs ??
    (automation.type === 'command'
      ? DEFAULT_COMMAND_MAX_WALL_CLOCK_MS
      : DEFAULT_LLM_MAX_WALL_CLOCK_MS)
  )
}

function claudeModeForAutomation(mode: ModeToken | CodexPolicy): ClaudeAutomationMode {
  if (typeof mode === 'string') {
    const matched = CLAUDE_AUTOMATION_MODES.find((candidate) => candidate === mode)
    if (matched) return matched
  }
  return 'default'
}

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

/**
 * Execute a automation's task and call `updateLog` with the result.
 *
 * The function:
 * 1. Dispatches to `executeCommand` or `executeLlmPrompt` based on automation.type.
 * 2. Both handlers write the final status back via `updateLog`.
 * 3. Throws only on unexpected errors (db failures, etc.) — execution errors
 *    (non-zero exit, timeout, schema mismatch) are captured in the log record.
 */
export async function execute(
  automation: Automation,
  executionLogId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  // A workspace can be removed after a automation is persisted but before its
  // queued execution starts. Do not pass an undefined cwd/path into a runner.
  if (!resolveWorkspaceRoot(automation.workspaceId)) {
    updateLog(executionLogId, {
      finishedAt: Date.now(),
      status: 'failed',
      error: 'automation_workspace_not_found',
    })
    return
  }
  if (isAgentQuotaRecoveryConfig(automation.config)) {
    executeAgentQuotaRecovery(automation, executionLogId, updateLog)
    return
  }
  if (automation.type === 'command') {
    await executeCommand(automation, executionLogId, updateLog)
  } else {
    await executeLlmPrompt(automation, executionLogId, updateLog)
  }
}

function executeAgentQuotaRecovery(
  automation: Automation,
  logId: string,
  updateLog: UpdateLogFn,
): void {
  const config = isAgentQuotaRecoveryConfig(automation.config) ? automation.config : null
  if (!config) {
    updateLog(logId, {
      finishedAt: Date.now(),
      exitCode: null,
      output: '',
      status: 'failed',
      error: 'invalid_agent_recovery_config',
    })
    return
  }
  const now = Date.now()
  const ok = setAgentEnabled(config.agentId, true)
  updateLog(logId, {
    finishedAt: now,
    exitCode: null,
    output: ok
      ? `agent ${config.agentId} re-enabled after quota reset`
      : `agent ${config.agentId} not found`,
    status: ok ? 'success' : 'failed',
    error: ok ? null : 'agent_not_found',
  })
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function spawnWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })

    let output = ''
    const maxOutput = 1_000_000

    const appendOutput = (chunk: string) => {
      if (output.length < maxOutput) {
        output += chunk.slice(0, maxOutput - output.length)
      }
    }

    child.stdout?.on('data', (data: Buffer) => appendOutput(data.toString('utf-8')))
    child.stderr?.on('data', (data: Buffer) => appendOutput(data.toString('utf-8')))

    let settled = false

    const onTimeout = () => {
      if (settled) return
      settled = true
      // Kill the entire process group
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(new Error('timeout'))
    }

    const timeoutTimer = setTimeout(onTimeout, timeoutMs)
    // Unref so it doesn't keep the process alive if the child finishes before timeout
    timeoutTimer.unref()

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      reject(err)
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      // If killed by our timeout signal, treat as timeout
      if (signal === 'SIGKILL') {
        reject(new Error('timeout'))
      } else {
        resolve({ exitCode: code, output })
      }
    })
  })
}

async function executeCommand(
  automation: Automation,
  logId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  const config = (automation.config ?? {}) as CommandConfig
  const raw = config.command ?? ''
  const command = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const deadline = Date.now() + maxWallClockMsFor(automation)
  const maxRetries =
    typeof config.maxRetries === 'number' && config.maxRetries >= 0 ? config.maxRetries : 0

  let lastError: Error | null = null
  let lastExitCode: number | null = null
  let lastOutput = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = deadline - Date.now()
    if (timeout <= 0) {
      lastError = new Error('timeout')
      break
    }
    if (attempt > 0) {
      console.log(
        '[dispatcher] command retry %d/%d for automation %s',
        attempt,
        maxRetries,
        automation.id,
      )
    }
    try {
      const result = await spawnWithTimeout(
        command,
        resolveWorkspaceRoot(automation.workspaceId)!,
        timeout,
      )
      lastExitCode = result.exitCode
      lastOutput = result.output

      if (result.exitCode === 0) {
        // Success
        const now = Date.now()
        updateLog(logId, {
          finishedAt: now,
          exitCode: 0,
          output: result.output,
          status: 'success',
        })
        console.log('[dispatcher] command success for automation %s (exit=0)', automation.id)
        return
      } else {
        // Non-zero exit — record and retry if possible
        lastError = new Error(`exit_code_${result.exitCode}`)
        console.warn(
          '[dispatcher] command exit %d for automation %s (attempt %d)',
          result.exitCode,
          automation.id,
          attempt,
        )
        if (attempt < maxRetries) continue
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(
        '[dispatcher] command error for automation %s (attempt %d): %s',
        automation.id,
        attempt,
        lastError.message,
      )
      if (attempt < maxRetries) continue
    }
  }

  // All retries exhausted
  const now = Date.now()
  updateLog(logId, {
    finishedAt: now,
    exitCode: lastExitCode,
    output: lastOutput,
    status: 'failed',
    error: lastError?.message ?? 'unknown_error',
  })
  console.error(
    '[dispatcher] command failed for automation %s after %d retries: %s',
    automation.id,
    maxRetries,
    lastError?.message ?? 'unknown_error',
  )
}

// ---------------------------------------------------------------------------
// LLM prompt execution
// ---------------------------------------------------------------------------

/**
 * Create a context-aware permission handler for LLM prompt automation execution.
 *
 * Uses the frozen tool set for allowlist/denylist enforcement. Permission mode
 * is determined by vendor + mode (replacing the old three-way McpMode):
 * - Claude: `'plan'` token denies all writes; all other tokens allow
 *   reads but deny writes (automations run unattended — write permissions must be
 *   pre-configured via toolAllowlist / toolDenylist).
 * - Codex: `CodexPolicy.sandboxMode === 'read-only'` denies all writes;
 *   `'workspace-write'` allows reads but denies writes.
 *
 * Legacy McpMode values ('read-only', 'sandboxed', 'full-access') stored in the
 * `mode` column by the v7 migration are also handled: 'read-only' maps to the
 * read-only path; 'sandboxed'/'full-access' go through the same deny-write path.
 */
function createPermissionHandler(
  automationId: string,
  workspacePath: string,
  frozenTools: FrozenToolSet,
  vendor: VendorId,
  mode: ModeToken | CodexPolicy,
): CanUseTool {
  return async (toolName, _input) => {
    // Step 1: Check if tool is in the frozen tool set
    if (!matchesFrozenTool(toolName, frozenTools)) {
      return { behavior: 'deny', message: `tool "${toolName}" is not in the frozen allowlist` }
    }

    // Step 2: Determine if this mode is read-only based on vendor + mode.
    // Legacy McpMode values from the v7 migration are also recognised.
    const readOnly = isReadOnlyMode(vendor, mode)

    if (readOnly) {
      return { behavior: 'deny', message: 'automation execution identity: read-only' }
    }

    // Step 3: Writes require both an allowlist match (step 1) and a mode that
    // explicitly authorizes unattended edits. Other modes retain deny-by-default.
    const writeAllowed =
      vendor === 'claude' && (mode === 'acceptEdits' || mode === 'bypassPermissions')
    if (!isWriteTool(toolName, frozenTools) || writeAllowed) {
      return { behavior: 'allow' }
    }
    return {
      behavior: 'deny',
      message: 'automation execution: write tool requires pre-approved permission',
    }
  }
}

/** Determine whether a vendor's permission mode denies all writes (read-only only). */
function isReadOnlyMode(vendor: VendorId, mode: ModeToken | CodexPolicy): boolean {
  // Legacy McpMode values from v7 migration
  if (mode === 'read-only') return true
  if (mode === 'sandboxed' || mode === 'full-access') return false

  if (vendor === 'codex') {
    const policy = mode as CodexPolicy
    return policy.sandboxMode === 'read-only'
  }
  // claude
  return (mode as ModeToken) === 'plan'
}

/**
 * Minimal JSON Schema validation — checks top-level type and required properties.
 * Extend this as schema intents grow.
 */
function validateOutput(
  output: string,
  schema: Record<string, unknown>,
): { valid: boolean; error?: string } {
  const schemaType = schema.type
  if (schemaType === 'object') {
    const required = (schema.required as string[]) ?? []
    try {
      const parsed = JSON.parse(output)
      if (typeof parsed !== 'object' || parsed === null) {
        return { valid: false, error: 'expected object, got non-object' }
      }
      for (const key of required) {
        if (!(key in parsed)) {
          return { valid: false, error: `missing required field: ${key}` }
        }
      }
      return { valid: true }
    } catch {
      return { valid: false, error: 'invalid JSON for object schema' }
    }
  }
  if (schemaType === 'array') {
    try {
      const parsed = JSON.parse(output)
      if (!Array.isArray(parsed)) {
        return { valid: false, error: 'expected array, got non-array' }
      }
      return { valid: true }
    } catch {
      return { valid: false, error: 'invalid JSON for array schema' }
    }
  }
  // For string/number/boolean or unknown schema types — accept any text output
  return { valid: true }
}

function upsertAutomationSessionProjection(automation: Automation, sessionId: string): void {
  try {
    upsertAutomationExecutionRow({
      automation,
      sessionId,
      workspacePath: resolveWorkspaceRoot(automation.workspaceId)!,
    })
  } catch (err) {
    console.error('[c3:automations] failed to upsert automation session projection:', err)
  }
  // Register the real agent session as running in the same phase we bind it to the
  // projection, so the 「自动化」tab row shows the running dot for the duration. The
  // matching clear lives in each executor's terminal cleanup (idempotent).
  setAutomationRunning(sessionId)
}

async function executeLlmPrompt(
  automation: Automation,
  logId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  const config = (automation.config ?? {}) as LlmConfig
  const prompt = typeof config.prompt === 'string' ? config.prompt : ''
  if (!prompt.trim()) {
    const now = Date.now()
    updateLog(logId, {
      finishedAt: now,
      status: 'failed',
      error: 'empty_prompt',
    })
    return
  }

  console.log(
    `[c3:automations] (${SESSION_KIND}) llm run ${automation.id} @ ${resolveWorkspaceRoot(automation.workspaceId)!}`,
  )

  const maxWallClockMs = maxWallClockMsFor(automation)
  const outputSchema: Record<string, unknown> | undefined =
    config.outputSchema && typeof config.outputSchema === 'object'
      ? (config.outputSchema as Record<string, unknown>)
      : undefined

  const abortController = new AbortController()
  const timeoutTimer = setTimeout(() => {
    abortController.abort()
  }, maxWallClockMs)
  timeoutTimer.unref()

  const launchAgent = automation.agentId
    ? loadSettings().agents.find((agent) => agent.id === automation.agentId)
    : undefined
  if (!launchAgent || launchAgent.enabled === false || launchAgent.vendor !== automation.vendor) {
    clearTimeout(timeoutTimer)
    updateLog(logId, {
      finishedAt: Date.now(),
      status: 'failed',
      error: !automation.agentId
        ? 'automation_agent_required'
        : !launchAgent
          ? 'automation_agent_not_found'
          : launchAgent.enabled === false
            ? 'automation_agent_disabled'
            : 'automation_agent_vendor_mismatch',
    })
    return
  }
  const { model, envOverrides } = launchForAgent(launchAgent)

  if (automation.vendor === 'codex') {
    await executeCodexLlmPrompt(automation, logId, updateLog, prompt, abortController, launchAgent)
    clearTimeout(timeoutTimer)
    return
  }

  const claudePath = findClaudeExecutable()

  // Resolve workspace-level MCP configuration and freeze the tool list.
  const workspaceMcpConfig = getWorkspaceMcpConfig(resolveWorkspaceRoot(automation.workspaceId)!)
  const frozenTools = freezeTools(
    automation.toolAllowlist ?? [],
    automation.toolDenylist ?? [],
    workspaceMcpConfig,
  )
  const permissionHandler = createPermissionHandler(
    automation.id,
    resolveWorkspaceRoot(automation.workspaceId)!,
    frozenTools,
    automation.vendor,
    automation.mode,
  )

  // The c3 MCP server is opt-in: only an explicit c3 entry in this automation's
  // allowlist mounts it. Templates can preselect these entries; an empty
  // allowlist does not implicitly grant c3 capabilities. It intentionally
  // replaces a user-configured server named `c3`; other workspace MCP servers
  // remain available.
  const selectedC3Mcp = hasSelectedC3McpTool(automation.toolAllowlist ?? [])
  const mcpServers = selectedC3Mcp
    ? {
        ...workspaceMcpConfig.mcpServers,
        ...createAutomationMcpServer(resolveWorkspaceRoot(automation.workspaceId)!, logId),
      }
    : workspaceMcpConfig.mcpServers
  const hasMcpServers = Object.keys(mcpServers).length > 0

  // The real agent session registered as running (via the projection helper) once
  // the first SDK message carries a `session_id`; cleared in `finally` on every
  // terminal path — success, schema-fail, timeout, or thrown error.
  let runningSessionId: string | null = null

  try {
    const q = query({
      prompt,
      options: {
        cwd: resolveWorkspaceRoot(automation.workspaceId)!,
        settingSources: ['user', 'project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        disallowedTools: [],
        permissionMode: claudeModeForAutomation(automation.mode),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        ...(hasMcpServers ? { mcpServers } : {}),
        env: buildChildEnv(envOverrides),
        ...(model ? { model } : {}),
        abortController,
        canUseTool: permissionHandler,
      },
    })

    let text = ''
    let sessionId = ''

    for await (const m of q) {
      if (abortController.signal.aborted) break
      // Capture the agent session id from the first event that carries it and
      // persist it immediately, so the transcript stays reachable even if the
      // run later times out or fails before reaching a terminal update.
      if (!sessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          sessionId = sid
          updateLog(logId, { sessionId })
          upsertAutomationSessionProjection(automation, sessionId)
          runningSessionId = sessionId
        }
      }
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') {
              text += b.text
            }
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }

    clearTimeout(timeoutTimer)

    const now = Date.now()
    const output = text.trim()
    const wasAborted = abortController.signal.aborted

    if (wasAborted) {
      updateLog(logId, {
        finishedAt: now,
        status: 'failed',
        output,
        error: 'wall_clock_timeout',
      })
      return
    }

    // Schema validation
    if (outputSchema && Object.keys(outputSchema).length > 0) {
      const validation = validateOutput(output, outputSchema)
      if (!validation.valid) {
        updateLog(logId, {
          finishedAt: now,
          status: 'failed',
          output,
          error: `schema_validation_failed: ${validation.error}`,
        })
        return
      }
    }

    updateLog(logId, {
      finishedAt: now,
      status: 'success',
      output,
    })
  } catch (err) {
    clearTimeout(timeoutTimer)
    const now = Date.now()
    const message = err instanceof Error ? err.message : String(err)
    updateLog(logId, {
      finishedAt: now,
      status: 'failed',
      error: message,
    })
  } finally {
    if (runningSessionId) clearAutomationRunning(runningSessionId)
  }
}

async function executeCodexLlmPrompt(
  automation: Automation,
  logId: string,
  updateLog: UpdateLogFn,
  prompt: string,
  abortController: AbortController,
  agent: AgentConfig,
): Promise<void> {
  const policy: CodexPolicy =
    typeof automation.mode === 'object'
      ? automation.mode
      : {
          sandboxMode: automation.mode === 'read-only' ? 'read-only' : 'workspace-write',
          approvalPolicy: 'never',
        }
  const { actionMode, toolGate } = codexPolicyToGrid(policy)
  const { model, baseUrl, apiKey, wireApi, envOverrides } = launchForAgent(agent)
  // Bridge the host `gh` keyring credential into the codex sandbox as `GH_TOKEN`
  // so PR review/comment/merge shell commands authenticate; network access stays
  // orthogonal, governed by this automation's sandbox/toolAllowlist settings.
  const driverEnvOverrides = await resolveCodexGhTokenEnv(envOverrides)
  // The c3 MCP route is opt-in: only an explicit c3 entry in this automation's
  // allowlist mounts it (an empty allowlist does not implicitly grant c3). When
  // selected, bind the loopback HTTP MCP for THIS execution and hand codex the c3
  // descriptor; the token is disposed in `finally` on every terminal path so no
  // execution can call the tools after it ends. The read/write authorization rules
  // are unchanged — this only makes the tools visible to codex.
  const selectedC3Mcp = hasSelectedC3McpTool(automation.toolAllowlist ?? [])
  const c3Binding =
    selectedC3Mcp && automationHttpMcp
      ? automationHttpMcp.bind({
          workspacePath: resolveWorkspaceRoot(automation.workspaceId)!,
          executionId: logId,
        })
      : null
  // Cleared in `finally` on every terminal path (success, timeout, thrown error).
  let runningSessionId: string | null = null
  try {
    const run = await createCodexAdapter().driver.start({
      prompt,
      cwd: resolveWorkspaceRoot(automation.workspaceId)!,
      signal: abortController.signal,
      actionMode,
      toolGate,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(wireApi ? { wireApi } : {}),
      ...(driverEnvOverrides ? { envOverrides: driverEnvOverrides } : {}),
      ...(c3Binding ? { mcpServers: c3Binding.servers } : {}),
    })
    const sessionId = await run.sessionId()
    if (sessionId) {
      updateLog(logId, { sessionId })
      upsertAutomationSessionProjection(automation, sessionId)
      runningSessionId = sessionId
    }
    let output = ''
    for await (const message of run.messages()) {
      for (const block of message.blocks) {
        if (block.type === 'text') output = block.text
      }
    }
    updateLog(logId, {
      finishedAt: Date.now(),
      status: abortController.signal.aborted ? 'failed' : 'success',
      output,
      ...(abortController.signal.aborted ? { error: 'wall_clock_timeout' } : {}),
    })
  } catch (err) {
    updateLog(logId, {
      finishedAt: Date.now(),
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (runningSessionId) clearAutomationRunning(runningSessionId)
    // Dispose the per-execution c3 MCP token so the tools cannot be called after
    // this execution ends (idempotent; no-op when c3 was not selected).
    c3Binding?.dispose()
  }
}
