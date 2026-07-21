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
import type { GenericEvent } from '@ccc/shared'
import { resolveWorkspaceRoot } from '../../state.js'
import {
  bindClaudeRelay,
  launchForAgent,
  setAgentEnabled,
  unbindRelay,
} from '../../kernel/agent-config/index.js'
import { getRelay } from '../../kernel/relay/runtime.js'
import { buildChildEnv, findClaudeExecutable } from '../../kernel/infra/child-env.js'
import { loadSettings } from '../../kernel/config/index.js'
import { createCodexAdapter } from '../../kernel/agent/adapters/codex/index.js'
import { codexPolicyToGrid } from '../../kernel/agent/adapters/codex/driver.js'
import { resolveCodexGhTokenEnv } from '../../kernel/agent/adapters/codex/gh-token.js'
import { getWorkspaceMcpConfig, isAgentQuotaRecoveryConfig } from './store.js'
import {
  freezeTools,
  hasSelectedC3McpTool,
  hasSelectedNetworkAccess,
  matchesFrozenTool,
  isWriteTool,
} from './mcp-freeze.js'
import type { FrozenToolSet } from './mcp-freeze.js'
import { remoteMcpToClaudeConfig } from '../../kernel/agent/adapters/claude/mcp.js'
import { buildAutomationPrompt, readEmbedEventContext } from './event-prompt.js'
import type { ServedAutomationMcp } from '../../transport/automation-mcp/index.js'
import { upsertAutomationExecutionRow } from '../sessions/session-metadata-store.js'
import { ensureRuntime, emit, getRuntime, setStatus } from '../../runs.js'
import { WireEmitter } from '../../kernel/run/run-via-driver.js'
import { AutomationViewerStream, translateClaudeSdkMessage } from './viewer-stream.js'

// ---------------------------------------------------------------------------
// Automation c3 MCP route (the SINGLE loopback HTTP MCP transport both Claude and
// Codex automations bind). Injected by the composition root at startup — the
// dispatcher runs off the kernel run bus, so it holds the served route as a
// module-level handle it `bind()`s per execution for either vendor.
// ---------------------------------------------------------------------------

let automationHttpMcp: ServedAutomationMcp | null = null

/** Inject (or clear, in tests) the loopback HTTP MCP route for c3 automations. */
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
  /** Event + LLM only: append the triggering event to the prompt at run time. */
  embedEventContext?: boolean
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
 *
 * `triggerEvent` is the immutable, single-execution event supplied only by the
 * event-dispatch path; an LLM task with `config.embedEventContext === true`
 * appends it to its prompt. Command tasks ignore it.
 */
export async function execute(
  automation: Automation,
  executionLogId: string,
  updateLog: UpdateLogFn,
  triggerEvent?: GenericEvent,
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
    await executeLlmPrompt(automation, executionLogId, updateLog, triggerEvent)
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
}

/**
 * Register the real agent session as a live {@link SessionRuntime} for a `llm`
 * automation, so a viewer on the works page sees the fine-grained running status
 * and a transcript that updates in real time (not the old static projection).
 *
 * The runtime is tagged `sessionKind: 'automation'` + `runKind: 'background'` (the
 * first place this combination is created) and its `run` pointer carries the
 * dispatcher's wall-clock `abortController`, so the works-page `stop_run` handler
 * aborts THIS run through `stopRun(id)` → `rt.run.abort.abort()`. `setStatus('running')`
 * broadcasts the status snapshot; `listStatuses()`'s "kernel runtimes win" rule then
 * supersedes the legacy `automationRunning` flag (which llm runs no longer set).
 */
function registerAutomationRuntime(
  automation: Automation,
  sessionId: string,
  abortController: AbortController,
): void {
  const workspacePath = resolveWorkspaceRoot(automation.workspaceId)!
  const codexPolicy = typeof automation.mode === 'object' ? automation.mode : undefined
  const mode: ModeToken = typeof automation.mode === 'string' ? automation.mode : 'auto'
  const rt = ensureRuntime(
    sessionId,
    workspacePath,
    mode,
    [],
    'automation',
    codexPolicy,
    'background',
  )
  rt.run = { abort: abortController, handle: null }
  setStatus(sessionId, 'running')
}

/**
 * Terminal cleanup for a `llm` automation runtime: null the run pointer so the
 * liveness reconciler leaves the runtime alone, emit a single terminal `turn_end`
 * (unless the SDK's own `result` frame already produced one), and settle to `idle`.
 *
 * The runtime is deliberately KEPT (not removed) — same as an ordinary session —
 * so selecting the automation session after it ends replays the full transcript
 * from the buffer. `finalizeRun` is intentionally NOT used: its `onRunEnd` hook
 * would rewrite the projection title from the automation name to the native agent
 * title, sinking the 「自动化」tab's row label.
 *
 * The wire `turn_end` only carries `complete | error`; a user stop / wall-clock
 * timeout maps to `complete` (the viewer converges to idle; the failure itself is
 * recorded in the execution log, not the wire frame).
 */
function settleAutomationRuntime(
  sessionId: string | null,
  reason: 'complete' | 'error',
  error?: string,
): void {
  if (!sessionId) return
  const rt = getRuntime(sessionId)
  if (!rt) return
  rt.run = null
  if (!rt.sawTurnEnd) emit(sessionId, { type: 'turn_end', reason, ...(error ? { error } : {}) })
  setStatus(sessionId, 'idle')
}

async function executeLlmPrompt(
  automation: Automation,
  logId: string,
  updateLog: UpdateLogFn,
  triggerEvent?: GenericEvent,
): Promise<void> {
  const config = (automation.config ?? {}) as LlmConfig
  const basePrompt = typeof config.prompt === 'string' ? config.prompt : ''
  if (!basePrompt.trim()) {
    const now = Date.now()
    updateLog(logId, {
      finishedAt: now,
      status: 'failed',
      error: 'empty_prompt',
    })
    return
  }

  // Build the final prompt AFTER validating the saved prompt is non-empty. When
  // this LLM task opted into embedding and an actual triggering event is present,
  // the normalized event is serialized and appended once inside a fixed frame;
  // otherwise the saved prompt is used verbatim. Both vendor paths reuse this
  // single result so Claude and Codex receive identical text. A degraded
  // serialization tier is logged (never with the event content) and does not
  // fail the execution.
  const embedEvent = readEmbedEventContext(automation.config) && triggerEvent ? triggerEvent : null
  const { prompt, tier } = buildAutomationPrompt(basePrompt, embedEvent)
  if (tier === 'safe' || tier === 'concat') {
    console.warn(
      '[dispatcher] event context serialization degraded to %s for automation %s',
      tier,
      automation.id,
    )
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
  const { model, envOverrides: launchEnv, relayCandidates } = launchForAgent(launchAgent)

  if (automation.vendor === 'codex') {
    await executeCodexLlmPrompt(automation, logId, updateLog, prompt, abortController, launchAgent)
    clearTimeout(timeoutTimer)
    return
  }

  // Route a custom claude provider through the loopback relay (ADR-0029): the SDK
  // connects with a per-run token, the real key stays in the relay. Null ⇒ system
  // mode (own login). Released in the `finally` below.
  const claudeRelay = bindClaudeRelay(relayCandidates)
  const envOverrides = claudeRelay ? { ...launchEnv, ...claudeRelay.envOverrides } : launchEnv

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
  // remain available. Claude now binds the SAME loopback HTTP MCP route Codex uses
  // (no in-process SDK server): bind per execution, translate the neutral
  // descriptors into the Claude SDK HTTP config, and dispose the token in `finally`
  // so the tools cannot be called after this execution ends.
  const selectedC3Mcp = hasSelectedC3McpTool(automation.toolAllowlist ?? [])
  const c3Binding =
    selectedC3Mcp && automationHttpMcp
      ? automationHttpMcp.bind({
          workspacePath: resolveWorkspaceRoot(automation.workspaceId)!,
          executionId: logId,
          metadata: automation.metadata,
        })
      : null
  const mcpServers = c3Binding
    ? { ...workspaceMcpConfig.mcpServers, ...remoteMcpToClaudeConfig(c3Binding.servers) }
    : workspaceMcpConfig.mcpServers
  const hasMcpServers = Object.keys(mcpServers).length > 0

  // The real agent session, bound once the first SDK message carries a `session_id`;
  // used by the `finally` to settle the runtime to idle. Null until bound.
  let runningSessionId: string | null = null
  // Viewer stream: buffers translated wire events until the runtime is registered,
  // then fans them out via `emit()`. The `register` callback wires the runtime's
  // `run` pointer to THIS run's abortController and flips the status to running.
  const viewer = new AutomationViewerStream((sid) =>
    registerAutomationRuntime(automation, sid, abortController),
  )
  let settleReason: 'complete' | 'error' = 'complete'
  let settleError: string | undefined

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
      // run later times out or fails before reaching a terminal update. Binding
      // the viewer registers the runtime and flushes any pre-session-id events.
      if (!sessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          sessionId = sid
          runningSessionId = sessionId
          updateLog(logId, { sessionId })
          upsertAutomationSessionProjection(automation, sessionId)
          viewer.bind(sessionId)
        }
      }
      // Accumulate assistant text for the execution log's `output` + schema check.
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
      }
      // Translate the SDK message into wire events and push them to viewers (or
      // buffer them until the session id binds).
      viewer.pushAll(translateClaudeSdkMessage(m))
      if (m.type === 'result') break
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
    // A user stop / wall-clock abort surfaces to the viewer as a clean `complete`
    // turn_end (the failure is recorded in the execution log, not the wire frame);
    // only a genuine SDK error settles the viewer with `error`.
    if (!abortController.signal.aborted) {
      settleReason = 'error'
      settleError = message
    }
    updateLog(logId, {
      finishedAt: now,
      status: 'failed',
      error: message,
    })
  } finally {
    settleAutomationRuntime(runningSessionId, settleReason, settleError)
    // Dispose the per-execution c3 MCP token so the tools cannot be called after
    // this execution ends (idempotent; no-op when c3 was not selected).
    c3Binding?.dispose()
    if (claudeRelay) unbindRelay(claudeRelay.token)
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
  const { model, relayCandidates, envOverrides } = launchForAgent(agent)
  // Bridge the host `gh` keyring credential into the codex sandbox as `GH_TOKEN`
  // so PR review/comment/merge shell commands authenticate; network access stays
  // orthogonal, governed by this automation's sandbox/toolAllowlist settings.
  const driverEnvOverrides = await resolveCodexGhTokenEnv(envOverrides)
  // Network access is the `network-access` pseudo-entry in the tool allowlist. It
  // only makes sense for the `workspace-write` sandbox (a `read-only` sandbox is
  // network-denied unconditionally), so gate on both. When unselected / read-only,
  // the field is omitted so codex's default (network denied) stands. Claude never
  // reaches this path — it ignores the flag entirely.
  const networkAccess =
    policy.sandboxMode === 'workspace-write' &&
    hasSelectedNetworkAccess(automation.toolAllowlist ?? [])
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
          metadata: automation.metadata,
        })
      : null
  // Bound once the driver reports the real session id; used by `finally` to settle
  // the runtime to idle. Null until bound.
  let runningSessionId: string | null = null
  // Viewer stream + canonical→wire diff. Codex resolves its session id up-front
  // (`await run.sessionId()`), so the pre-session-id buffer is normally empty, but
  // the same path is used for symmetry with the claude executor.
  const viewer = new AutomationViewerStream((sid) =>
    registerAutomationRuntime(automation, sid, abortController),
  )
  const wireEmitter = new WireEmitter((event) => viewer.push(event))
  let settleReason: 'complete' | 'error' = 'complete'
  let settleError: string | undefined
  try {
    const run = await createCodexAdapter(
      undefined,
      undefined,
      getRelay() ?? undefined,
    ).driver.start({
      prompt,
      cwd: resolveWorkspaceRoot(automation.workspaceId)!,
      signal: abortController.signal,
      actionMode,
      toolGate,
      ...(model ? { model } : {}),
      ...(relayCandidates ? { relayCandidates } : {}),
      ...(networkAccess ? { networkAccess: true } : {}),
      ...(driverEnvOverrides ? { envOverrides: driverEnvOverrides } : {}),
      ...(c3Binding ? { mcpServers: c3Binding.servers } : {}),
    })
    const sessionId = await run.sessionId()
    if (sessionId) {
      updateLog(logId, { sessionId })
      upsertAutomationSessionProjection(automation, sessionId)
      runningSessionId = sessionId
      viewer.bind(sessionId)
    }
    let output = ''
    for await (const message of run.messages()) {
      if (abortController.signal.aborted) break
      for (const block of message.blocks) {
        if (block.type === 'text') output = block.text
      }
      // Diff the append-with-upsert canonical frame into incremental wire events
      // (assistant_text deltas + one-shot tool_use / tool_result) for viewers.
      wireEmitter.consume(message)
    }
    updateLog(logId, {
      finishedAt: Date.now(),
      status: abortController.signal.aborted ? 'failed' : 'success',
      output,
      ...(abortController.signal.aborted ? { error: 'wall_clock_timeout' } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Abort (user stop / wall-clock) settles the viewer with `complete`; only a
    // genuine driver error settles with `error` (mirrors the claude executor).
    if (!abortController.signal.aborted) {
      settleReason = 'error'
      settleError = message
    }
    updateLog(logId, {
      finishedAt: Date.now(),
      status: 'failed',
      error: message,
    })
  } finally {
    settleAutomationRuntime(runningSessionId, settleReason, settleError)
    // Dispose the per-execution c3 MCP token so the tools cannot be called after
    // this execution ends (idempotent; no-op when c3 was not selected).
    c3Binding?.dispose()
  }
}
