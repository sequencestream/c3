/**
 * Schedule execution dispatcher.
 *
 * Routes execution to the appropriate handler based on schedule type:
 * - `command` → child_process.spawn with hard timeout + optional retry
 * - `llm` → SDK query() with wall-clock timeout + output schema validation
 *
 * Both handlers share the same update-log callback pattern: the caller
 * (scheduler) owns the `updateLog` closure that persists execution results.
 */

import { spawn } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { McpMode, Schedule } from '@ccc/shared/protocol'
import { findClaudeExecutable } from '../../claude.js'
import { getWorkspaceMcpConfig } from './store.js'
import { freezeTools, matchesFrozenTool, isWriteTool } from './mcp-freeze.js'
import { pendWriteApproval } from './queue.js'
import type { FrozenToolSet } from './mcp-freeze.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateLogFn = (id: string, patch: Record<string, unknown>) => void

interface CommandConfig {
  command: string
  timeout?: number // ms, default 30_000
  maxRetries?: number // default 0
}

interface LlmConfig {
  prompt: string
  maxWallClockMs?: number // ms, default 60_000
  outputSchema?: Record<string, unknown> // JSON Schema
}

/** Diff preview generation helper for write approval display. */
function generateDiffPreview(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>
  if (toolName === 'Write' || toolName === 'Edit') {
    const path = inp?.filePath ?? inp?.file_path ?? 'unknown'
    const content =
      typeof inp?.content === 'string'
        ? inp.content.substring(0, 200)
        : typeof inp?.content === 'object'
          ? JSON.stringify(inp.content).substring(0, 200)
          : ''
    return `File: ${path}\nContent (first 200 chars): ${content}`
  }
  if (toolName === 'Bash') {
    const cmd = typeof inp?.command === 'string' ? inp.command.substring(0, 200) : 'unknown'
    return `Command: ${cmd}`
  }
  if (toolName === 'NotebookEdit') {
    return `Notebook: ${inp?.notebookPath ?? inp?.notebook_path ?? 'unknown'}`
  }
  if (toolName === 'Agent') {
    return `Sub-agent prompt: ${typeof inp?.prompt === 'string' ? inp.prompt.substring(0, 200) : ''}`
  }
  if (toolName.startsWith('mcp__')) {
    return `MCP tool: ${toolName}\nInput: ${JSON.stringify(input).substring(0, 300)}`
  }
  return `Tool: ${toolName}\nInput: ${JSON.stringify(input).substring(0, 200)}`
}

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

/**
 * Execute a schedule's task and call `updateLog` with the result.
 *
 * The function:
 * 1. Dispatches to `executeCommand` or `executeLlmPrompt` based on schedule.type.
 * 2. Both handlers write the final status back via `updateLog`.
 * 3. Throws only on unexpected errors (db failures, etc.) — execution errors
 *    (non-zero exit, timeout, schema mismatch) are captured in the log record.
 */
export async function execute(
  schedule: Schedule,
  executionLogId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  if (schedule.type === 'command') {
    await executeCommand(schedule, executionLogId, updateLog)
  } else {
    await executeLlmPrompt(schedule, executionLogId, updateLog)
  }
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
  schedule: Schedule,
  logId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  const config = (schedule.config ?? {}) as CommandConfig
  const raw = config.command ?? ''
  const command = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const timeout = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : 30_000
  const maxRetries =
    typeof config.maxRetries === 'number' && config.maxRetries >= 0 ? config.maxRetries : 0

  let lastError: Error | null = null
  let lastExitCode: number | null = null
  let lastOutput = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(
        '[dispatcher] command retry %d/%d for schedule %s',
        attempt,
        maxRetries,
        schedule.id,
      )
    }
    try {
      const result = await spawnWithTimeout(command, schedule.workspacePath, timeout)
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
        console.log('[dispatcher] command success for schedule %s (exit=0)', schedule.id)
        return
      } else {
        // Non-zero exit — record and retry if possible
        lastError = new Error(`exit_code_${result.exitCode}`)
        console.warn(
          '[dispatcher] command exit %d for schedule %s (attempt %d)',
          result.exitCode,
          schedule.id,
          attempt,
        )
        if (attempt < maxRetries) continue
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(
        '[dispatcher] command error for schedule %s (attempt %d): %s',
        schedule.id,
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
    '[dispatcher] command failed for schedule %s after %d retries: %s',
    schedule.id,
    maxRetries,
    lastError?.message ?? 'unknown_error',
  )
}

// ---------------------------------------------------------------------------
// LLM prompt execution
// ---------------------------------------------------------------------------

/**
 * Create a context-aware permission handler for LLM prompt schedule execution.
 *
 * Uses the frozen tool set for allowlist/denylist enforcement. For sandboxed
 * and full-access modes, write tool calls go through the approval queue
 * (sandboxed → full queue with timeout; full-access → Owner quick confirm).
 */
function createPermissionHandler(
  scheduleId: string,
  workspacePath: string,
  frozenTools: FrozenToolSet,
  mcpMode: McpMode,
): CanUseTool {
  return async (toolName, input) => {
    // Step 1: Check if tool is in the frozen tool set
    if (!matchesFrozenTool(toolName, frozenTools)) {
      return { behavior: 'deny', message: `tool "${toolName}" is not in the frozen allowlist` }
    }

    // Step 2: Apply mcpMode rules
    switch (mcpMode) {
      case 'read-only':
        return { behavior: 'deny', message: 'schedule execution identity: read-only' }

      case 'full-access': {
        if (!isWriteTool(toolName, frozenTools)) {
          return { behavior: 'allow' }
        }
        const approved = await pendWriteApproval({
          scheduleId,
          workspacePath,
          toolName,
          toolInput: input,
          diffPreview: generateDiffPreview(toolName, input),
          ttlMs: 5 * 60 * 1000,
        })
        if (approved) {
          return { behavior: 'allow' }
        }
        return { behavior: 'deny', message: 'full-access write not approved' }
      }

      case 'sandboxed': {
        if (!isWriteTool(toolName, frozenTools)) {
          return { behavior: 'allow' }
        }
        const approved = await pendWriteApproval({
          scheduleId,
          workspacePath,
          toolName,
          toolInput: input,
          diffPreview: generateDiffPreview(toolName, input),
        })
        if (approved) {
          return { behavior: 'allow' }
        }
        return { behavior: 'deny', message: 'sandboxed write not approved' }
      }

      default:
        return { behavior: 'deny', message: `unknown mcpMode: ${mcpMode}` }
    }
  }
}

/**
 * Minimal JSON Schema validation — checks top-level type and required properties.
 * Extend this as schema requirements grow.
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

async function executeLlmPrompt(
  schedule: Schedule,
  logId: string,
  updateLog: UpdateLogFn,
): Promise<void> {
  const config = (schedule.config ?? {}) as LlmConfig
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

  const maxWallClockMs =
    typeof config.maxWallClockMs === 'number' && config.maxWallClockMs > 0
      ? config.maxWallClockMs
      : 60_000
  const outputSchema: Record<string, unknown> | undefined =
    config.outputSchema && typeof config.outputSchema === 'object'
      ? (config.outputSchema as Record<string, unknown>)
      : undefined

  const abortController = new AbortController()
  const timeoutTimer = setTimeout(() => {
    abortController.abort()
  }, maxWallClockMs)
  timeoutTimer.unref()

  const claudePath = findClaudeExecutable()

  // Resolve workspace-level MCP configuration and freeze the tool list.
  const workspaceMcpConfig = getWorkspaceMcpConfig(schedule.workspacePath)
  const frozenTools = freezeTools(
    schedule.toolAllowlist ?? [],
    schedule.toolDenylist ?? [],
    workspaceMcpConfig,
    schedule.mcpMode,
  )
  const permissionHandler = createPermissionHandler(
    schedule.id,
    schedule.workspacePath,
    frozenTools,
    schedule.mcpMode,
  )

  // Build mcpServers from workspace config (if any)
  const hasMcpServers = Object.keys(workspaceMcpConfig.mcpServers).length > 0
  const mcpServers:
    | Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    | undefined = hasMcpServers ? workspaceMcpConfig.mcpServers : undefined

  try {
    const q = query({
      prompt,
      options: {
        cwd: schedule.workspacePath,
        settingSources: ['user', 'project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        disallowedTools: [],
        permissionMode: 'default',
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        canUseTool: permissionHandler,
      },
    })

    let text = ''
    let result = ''
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
        result = (m as { result?: { status?: string } }).result?.status ?? ''
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
  }
}
