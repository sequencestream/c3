/**
 * Automation viewer stream — the bridge that turns an UNATTENDED automation
 * execution into a live, viewable session on the works page.
 *
 * The dispatcher drives `query()` / the codex driver directly (off the kernel run
 * bus, with its own three-tier MCP security model). Historically it registered
 * only a lightweight running FLAG, so a viewer on the works page saw a static
 * status and a non-updating transcript. This module lets the dispatcher instead
 * register a real {@link SessionRuntime} and translate the SDK/canonical stream
 * into c3 wire events, fanned out via `emit()` to whoever is viewing the session.
 *
 * Two pieces:
 *  - {@link translateClaudeSdkMessage} — a PURE translator (SDK message → wire
 *    events), unit-testable in isolation. The Codex path reuses the driver-path
 *    {@link import('../../kernel/run/run-via-driver.js').WireEmitter} instead
 *    (canonical frames are already append-with-upsert there).
 *  - {@link AutomationViewerStream} — buffers events produced BEFORE the agent
 *    session id is known, then flushes them the moment the runtime is registered,
 *    so a viewer never misses the first few frames (pre-session-id buffering).
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import { stringifyToolResult } from '../../format.js'
import { emit } from '../../runs.js'

/**
 * Translate ONE Claude SDK streaming message into zero or more c3 wire events.
 *
 * Pure — no runtime lookup, no `emit`, no session state — so the caller decides
 * where the events go (buffer before the session id is known, `emit` after). The
 * mapping mirrors the interactive claude run loop (`kernel/agent/index.ts`):
 *  - `assistant` text block  → `assistant_text`
 *  - `assistant` tool_use    → `tool_use`
 *  - `user` tool_result      → `tool_result`
 *  - `result` (turn end)     → `turn_end { reason: 'complete' }`
 *
 * A message that carries none of these (e.g. the `system` init frame) yields `[]`.
 */
export function translateClaudeSdkMessage(m: unknown): ServerToClient[] {
  const events: ServerToClient[] = []
  const type = (m as { type?: unknown }).type
  if (type === 'assistant') {
    const content = (m as { message?: { content?: unknown[] } }).message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as {
          type?: unknown
          text?: unknown
          id?: unknown
          name?: unknown
          input?: unknown
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          events.push({ type: 'assistant_text', text: b.text })
        } else if (
          b.type === 'tool_use' &&
          typeof b.id === 'string' &&
          typeof b.name === 'string'
        ) {
          events.push({ type: 'tool_use', toolUseId: b.id, toolName: b.name, input: b.input ?? {} })
        }
      }
    }
  } else if (type === 'user') {
    const content = (m as { message?: { content?: unknown[] } }).message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as {
          type?: unknown
          tool_use_id?: unknown
          content?: unknown
          is_error?: unknown
        }
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          events.push({
            type: 'tool_result',
            toolUseId: b.tool_use_id,
            content: stringifyToolResult(b.content),
            isError: !!b.is_error,
          })
        }
      }
    }
  } else if (type === 'result') {
    events.push({ type: 'turn_end', reason: 'complete' })
  }
  return events
}

/**
 * Buffers wire events until the agent session id is known, then registers the
 * runtime and flushes the buffer so a viewer sees the full stream from frame one.
 *
 * The dispatcher may produce translated events BEFORE the SDK reports a
 * `session_id` (there is nothing to `emit` to yet — no runtime exists). Those
 * events are parked in {@link preRegister}; {@link bind} replays them the instant
 * the runtime is created. After binding, every {@link push} goes straight to
 * `emit()` (buffer + fan-out + status advance).
 */
export class AutomationViewerStream {
  private sessionId: string | null = null
  private readonly preRegister: ServerToClient[] = []

  /**
   * @param register Registers the {@link SessionRuntime} for `sessionId` (the
   *   dispatcher supplies `ensureRuntime` + `rt.run` wiring + `setStatus('running')`).
   *   Called exactly once, on the first {@link bind}.
   */
  constructor(private readonly register: (sessionId: string) => void) {}

  /** Whether the runtime has been registered (the session id is known). */
  get bound(): boolean {
    return this.sessionId !== null
  }

  /**
   * Bind the real agent session id: register the runtime, then flush every event
   * buffered before this point. Idempotent — a second call is a no-op.
   */
  bind(sessionId: string): void {
    if (this.sessionId) return
    this.sessionId = sessionId
    this.register(sessionId)
    for (const event of this.preRegister) emit(sessionId, event)
    this.preRegister.length = 0
  }

  /** Route one wire event to viewers, or buffer it until {@link bind}. */
  push(event: ServerToClient): void {
    if (this.sessionId) emit(this.sessionId, event)
    else this.preRegister.push(event)
  }

  /** Route a batch of wire events (translator output) in order. */
  pushAll(events: readonly ServerToClient[]): void {
    for (const event of events) this.push(event)
  }
}
