import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ServerToClient } from '@ccc/shared/protocol'
import { waitForDecision, resolveDecision, type Decision } from './permissions.js'
import { stringifyToolResult } from './format.js'

// In a Bun-compiled binary the SDK's bundled `cli-<platform>` lookup misses
// (no node_modules to walk). Resolve `claude` from the host PATH and hand it
// to the SDK via pathToClaudeCodeExecutable. Override with CLAUDE_PATH.
let cachedClaudePath: string | null | undefined
function findClaudeExecutable(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath ?? undefined
  if (process.env.CLAUDE_PATH) {
    cachedClaudePath = process.env.CLAUDE_PATH
    return cachedClaudePath
  }
  try {
    const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf-8' })
    const found = r.status === 0 ? r.stdout.trim() : ''
    cachedClaudePath = found || null
    return cachedClaudePath ?? undefined
  } catch {
    cachedClaudePath = null
    return undefined
  }
}

export const registerPermissionResolver = {
  resolve(requestId: string, decision: Decision) {
    resolveDecision(requestId, decision)
  },
}

/** Live controls for an in-flight run, handed to the caller via `onStart`. */
export interface RunHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>
}

export interface RunOptions {
  prompt: string
  /** Working directory for this run — the active workspace's path. */
  cwd: string
  signal: AbortSignal
  /** Permission mode to start the query in. */
  permissionMode: PermissionMode
  /**
   * Resume an existing SDK session by id. Omit for the first prompt of a new
   * session; the session id is reported via `onSessionId` once it exists.
   */
  resume?: string
  send: (msg: ServerToClient) => void
  /** Called once the query is created so the caller can drive it mid-run. */
  onStart?: (handle: RunHandle) => void
  /** Called once with the SDK session id (from the `init` system message). */
  onSessionId?: (sessionId: string) => void
}

export async function runClaude(opts: RunOptions): Promise<void> {
  const { prompt, cwd, signal, permissionMode, resume, send, onStart, onSessionId } = opts
  let reportedSessionId = false

  const claudePath = findClaudeExecutable()
  const q = query({
    prompt,
    options: {
      cwd,
      ...(resume ? { resume } : {}),
      // Don't inherit user/project/local settings (hooks, allow rules, etc.).
      // We want every tool to flow through canUseTool below.
      settingSources: [],
      permissionMode,
      // Required by the SDK to permit switching into 'bypassPermissions' at any
      // point (start or via setPermissionMode). c3 remains the permission UI.
      allowDangerouslySkipPermissions: true,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      canUseTool: async (toolName, input, _ctx) => {
        const requestId = randomUUID()
        const req: ServerToClient = {
          type: 'permission_request',
          requestId,
          toolName,
          input,
        }
        send(req)
        const decision = await waitForDecision(requestId)
        if (decision === 'allow') {
          return { behavior: 'allow', updatedInput: input }
        }
        return { behavior: 'deny', message: 'User denied in c3 UI' }
      },
    },
  })

  onStart?.({
    setPermissionMode: (mode) => q.setPermissionMode(mode),
  })

  signal.addEventListener('abort', () => {
    try {
      // interrupt() returns a Promise that rejects asynchronously (e.g.
      // "ProcessTransport is not ready for writing") when the query has already
      // finished or hasn't started streaming. A sync try/catch can't catch that,
      // so the rejection would crash the process — attach a .catch() to swallow it.
      const p = q.interrupt?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* noop */
    }
  })

  try {
    for await (const m of q) {
      if (signal.aborted) break
      // The `init` system message (and `result`) carries the session id. Report
      // it once so the caller can bind a pending session and resume next turn.
      if (!reportedSessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          reportedSessionId = true
          onSessionId?.(sid)
        }
      }
      // Map SDK messages to wire protocol
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as {
              type?: string
              text?: string
              id?: string
              name?: string
              input?: unknown
            }
            if (b.type === 'text' && typeof b.text === 'string') {
              send({ type: 'assistant_text', text: b.text })
            } else if (b.type === 'tool_use' && b.id && b.name) {
              send({
                type: 'tool_use',
                toolUseId: b.id,
                toolName: b.name,
                input: b.input ?? {},
              })
            }
          }
        }
      } else if (m.type === 'user') {
        // user-role messages from SDK include tool_result blocks
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as {
              type?: string
              tool_use_id?: string
              content?: unknown
              is_error?: boolean
            }
            if (b.type === 'tool_result' && b.tool_use_id) {
              send({
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                content: stringifyToolResult(b.content),
                isError: !!b.is_error,
              })
            }
          }
        }
      } else if (m.type === 'result') {
        send({ type: 'session_end', reason: 'complete' })
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      send({
        type: 'session_end',
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
