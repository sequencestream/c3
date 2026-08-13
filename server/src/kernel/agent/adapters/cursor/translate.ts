/**
 * `cursor-agent` NDJSON stream → {@link CanonicalMessage} normalization (ADR-0011/0013).
 *
 * `Run.stream()` yields the SDK's own `SDKMessage` union:
 *   `system`      — the run's identity (`agent_id` / `run_id`), model and tools.
 *   `user`        — the prompt c3 just sent, echoed back.
 *   `assistant`   — a **text delta**, not a whole message: the SDK builds this
 *                   frame from its internal `text-delta` update.
 *   `thinking`    — a reasoning delta; the span's closing frame carries empty
 *                   text plus `thinking_duration_ms`.
 *   `tool_call`   — a tool at `running` / `completed` / `error`, correlated by a
 *                   stable `call_id` and carrying `args` and later `result`.
 *   `status`      — the run's lifecycle state (`RUNNING` … `ERROR`).
 *   `task`        — the runtime's own summarization bookkeeping.
 *   `usage`       — per-turn token usage, emitted once at turn end.
 *
 * One property of c3's transcript shapes everything here: across every vendor a
 * single canonical text block carries a WHOLE span of prose, never a fragment of
 * one. Claude and Codex both hand their adapters complete blocks, and every
 * downstream consumer — the browser's chat bubbles, the automation completion
 * judge, the discussion write-back — reads one emitted text as one message.
 * Cursor is the only vendor whose stream is token-level, so forwarding its deltas
 * as they arrive would shatter a single reply into dozens of transcript entries
 * and hand those consumers a lone token where a paragraph belongs. This
 * translator therefore accumulates a span and emits it ONCE, when the span ends.
 *
 * Span boundaries, in the order the wire model requires:
 *  - Text accumulates until something ends it (a tool call, a reasoning span, the
 *    turn's end) and is emitted at that point as one block. The next delta opens
 *    a NEW block, so text that follows a tool call is never retro-appended in
 *    front of it and the transcript keeps the order the model produced.
 *  - Tool frames carry a stable `call_id`, identical on the running and the
 *    completed frame, so results are back-filled onto the same `tool_use` block
 *    by that id. Frames are never paired by arrival order, which would
 *    mis-associate concurrent calls.
 *  - A completion whose `call_id` was never opened is not force-fitted onto some
 *    other tool: it opens its own block, flagged as orphaned.
 *
 * Anything the canonical model cannot express — native tool argument shapes,
 * usage, the runtime's summarization frames, unknown frame types — is preserved
 * under `vendorExtra` rather than dropped or flattened into a lie. `thinking`
 * blocks are produced **only** from native `thinking` frames; no heuristic ever
 * infers reasoning from message text or event names.
 */
import type { CanonicalBlock, CanonicalMessage, CanonicalToolResult } from '../types.js'
import { cursorToolCategory } from './tools.js'

/**
 * A structurally-narrowed SDK message. The SDK's own union is not imported here:
 * ADR-0009 keeps vendor SDK types out of the neutral surface, and a stream frame
 * is untrusted input regardless of what the published types promise, so every
 * field is read defensively and an unmodelled shape is preserved rather than
 * assumed.
 */
export interface CursorEvent {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  agent_id?: unknown
  run_id?: unknown
  call_id?: unknown
  tool_call?: unknown
  name?: unknown
  status?: unknown
  args?: unknown
  result?: unknown
  is_error?: unknown
  message?: unknown
  text?: unknown
  usage?: unknown
  thinking_duration_ms?: unknown
  [key: string]: unknown
}

/** What the driver should do with a frame beyond emitting messages. */
export interface CursorTranslation {
  /** Canonical messages to publish, in order. */
  messages: CanonicalMessage[]
  /** The native session (agent) id, present on frames that report it. */
  sessionId?: string
  /** Set when the frame terminates the turn. */
  ended?: { isError: boolean; errorMessage?: string }
}

const EMPTY: CursorTranslation = { messages: [] }

/** Read a string field, treating blank strings as absent. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Flatten the SDK's `{ role, content: [{ type:'text', text }] }` message shape. */
function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? str((part as { text?: unknown }).text)
        : undefined,
    )
    .filter((text): text is string => Boolean(text))
    .join('')
}

/**
 * Flatten a native result payload to a human-readable display string without
 * `JSON.stringify` (banned in kernel/, ADR-0009 R2 — and a serialized blob is not
 * a useful tool result anyway). Prefers the text-bearing field a tool actually
 * carries (`content`/`text`/`message`/`output`/`stdout`), recursing through the
 * nested shapes Cursor uses (e.g. an MCP `content: [{ text: { text } }]`). The
 * complete native payload is still preserved on the result's `vendorExtra`.
 */
function flattenToText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 4) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['content', 'text', 'message', 'output', 'stdout']) {
      if (record[key] !== undefined) return flattenToText(record[key], depth + 1)
    }
    return Object.values(record)
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

/**
 * Collapse a native tool result into the canonical flat display string. The SDK
 * nests a result as `{ success: … }` or `{ error: … }`, and a tool that reports
 * neither is taken at face value. The whole native object is kept on the result's
 * own `vendorExtra` while a readable rendering is flattened out for display; the
 * frame's `status` decides error-ness when the payload does not say.
 */
function toolResult(raw: unknown, isErrorStatus: boolean): CanonicalToolResult | undefined {
  if (raw === undefined || raw === null) {
    // An errored call with no payload still has to render as a failed result,
    // otherwise the block would sit forever as if it were still running.
    return isErrorStatus ? { content: '', isError: true } : undefined
  }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if ('error' in record) {
      return { content: flattenToText(record.error), isError: true, vendorExtra: { native: raw } }
    }
    if ('success' in record) {
      return {
        content: flattenToText(record.success),
        isError: isErrorStatus,
        vendorExtra: { native: raw },
      }
    }
  }
  return { content: flattenToText(raw), isError: isErrorStatus, vendorExtra: { native: raw } }
}

/** Run statuses that end the turn, and whether each is a failure. */
const TERMINAL_STATUS: Readonly<Record<string, { isError: boolean; message: string }>> = {
  FINISHED: { isError: false, message: '' },
  ERROR: { isError: true, message: 'cursor run failed' },
  CANCELLED: { isError: false, message: '' },
  EXPIRED: { isError: true, message: 'cursor run expired' },
}

/** The suffix every arm of the native tool-call union carries. */
const TOOL_CALL_SUFFIX = 'ToolCall'

/**
 * Unwrap a `tool_call` payload.
 *
 * The frame nests its tool under a single discriminant key naming the tool plus a
 * `ToolCall` suffix — `{ editToolCall: { args, result } }` — so the tool's
 * identity is the key, not a field. Stripping the suffix yields exactly the names
 * {@link cursorToolCategory} is keyed by. Returns `undefined` for a payload with
 * no such arm, leaving the caller to fall back rather than inventing a name.
 */
function cursorToolPayload(
  raw: unknown,
): { name: string; args?: unknown; result?: unknown } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.endsWith(TOOL_CALL_SUFFIX)) continue
    const name = key.slice(0, -TOOL_CALL_SUFFIX.length)
    if (!name) continue
    const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return { name, args: payload.args, result: payload.result }
  }
  return undefined
}

/**
 * Stateful normalizer for one Cursor run.
 *
 * State exists for three reasons the stream forces on us: text arrives as deltas
 * that must be joined into one block before anything sees them, reasoning arrives
 * the same way, and tool results arrive in separate frames that must find their
 * originating call by id.
 */
export class CursorStreamTranslator {
  private sessionId: string
  /** Reasoning accumulated for the open thinking span, emitted when it ends. */
  private thinking = ''
  /** Id of the open thinking span; cleared when the span completes. */
  private thinkingId: string | null = null
  /** Text accumulated for the open assistant span, emitted when it ends. */
  private assistant = ''
  /** Id of the open assistant span; cleared when something interrupts it. */
  private assistantId: string | null = null
  /** Tool calls opened so far, so a completion can find its own block. */
  private readonly openTools = new Map<string, { name: string; input: unknown }>()
  /** Monotonic counters giving every synthesized id a unique, deterministic name. */
  private assistantSeq = 0
  private thinkingSeq = 0
  private synthesized = 0

  constructor(sessionId = '') {
    this.sessionId = sessionId
  }

  /** The native session id observed so far (empty until a frame reports one). */
  get currentSessionId(): string {
    return this.sessionId
  }

  /**
   * Emit whatever span is still open. The driver calls this once the stream is
   * exhausted: a turn whose last frame is prose — no closing tool call, no
   * terminal `status` frame on the stream — would otherwise leave its final
   * paragraph accumulated and never emitted. Idempotent: with nothing open it
   * yields nothing.
   */
  flush(): CursorTranslation {
    return { messages: [...this.closeThinking(), ...this.closeAssistant()] }
  }

  /**
   * Emit the open prose span, if any, and close it. Called at every boundary —
   * the next delta must open a new block rather than extend a span the model has
   * already moved past.
   */
  private closeAssistant(): CanonicalMessage[] {
    const text = this.assistant
    const id = this.assistantId
    this.assistant = ''
    this.assistantId = null
    if (!id || !text) return []
    return [this.envelope('assistant', [{ type: 'text', text, id }])]
  }

  /** Emit the open reasoning span, if any, and close it. */
  private closeThinking(): CanonicalMessage[] {
    const thinking = this.thinking
    const id = this.thinkingId
    this.thinking = ''
    this.thinkingId = null
    if (!id || !thinking) return []
    return [this.envelope('assistant', [{ type: 'thinking', thinking, id }])]
  }

  /** Translate one frame. Frames that carry no canonical meaning yield nothing. */
  consume(event: CursorEvent): CursorTranslation {
    // The run's identity is reported under `session_id`; `agent_id` is the same
    // fact under the name an earlier frame vocabulary used. Reading both keeps a
    // stream that still speaks the older name from losing its identity entirely.
    const sid = str(event.session_id) ?? str(event.agent_id)
    if (sid) this.sessionId = sid

    const type = str(event.type)
    if (!type) return this.unknown(event, 'missing-type')

    switch (type) {
      case 'system':
        // Carries the run's identity (already captured above) and its metadata;
        // the metadata is not a message, so nothing is emitted for it.
        return sid ? { messages: [], sessionId: sid } : EMPTY

      case 'user':
        // c3 already knows the prompt it sent; echoing it back as a canonical
        // message would double it in the transcript.
        return EMPTY

      case 'thinking':
        return this.onThinking(event)

      case 'assistant':
        return this.onAssistant(event)

      case 'tool_call':
        return this.onToolCall(event)

      case 'status':
        return this.onStatus(event)

      case 'result':
        return this.onResult(event)

      case 'task':
      case 'usage':
      case 'request':
        // Runtime bookkeeping with no canonical analogue. Preserved verbatim so
        // nothing is silently lost, without inventing transcript content for it.
        return { messages: [this.envelope('assistant', [], { vendorExtra: { native: event } })] }

      default:
        return this.unknown(event, 'unknown-type')
    }
  }

  /**
   * Native reasoning. Deltas accumulate into a single block, emitted whole when
   * the span ends. The closing frame carries no text (only a duration), so it is
   * what ends the span rather than extending it.
   */
  private onThinking(event: CursorEvent): CursorTranslation {
    const delta = str(event.text)
    // Empty text closes the span — the SDK's `thinking-completed` shape.
    if (!delta) return { messages: this.closeThinking() }

    // Reasoning ends any open prose span: what the model said before it reasoned
    // is a finished paragraph, and the next text delta starts its own block.
    const messages = this.closeAssistant()

    this.thinkingId ??= `thinking-${this.thinkingSeq++}`
    this.thinking += delta

    return { messages }
  }

  /**
   * An assistant text delta. Accumulated under one id and emitted once, at the
   * boundary that ends the span; a new span begins after every such boundary.
   */
  private onAssistant(event: CursorEvent): CursorTranslation {
    const text = messageText(event.message)
    if (!text) return EMPTY

    // Prose ends any open reasoning span, so a later reasoning delta opens a new
    // block instead of appending to one the model has already left behind.
    const messages = this.closeThinking()

    this.assistantId ??= `assistant-${this.assistantSeq++}`
    this.assistant += text

    return { messages }
  }

  /** A tool frame, correlated by the stable native `call_id`. */
  private onToolCall(event: CursorEvent): CursorTranslation {
    // A tool call ends the open prose and reasoning spans: they are emitted here,
    // ahead of the call, so whatever the model says next lands after it rather
    // than merged into what came before.
    const pending = [...this.closeThinking(), ...this.closeAssistant()]

    // The lifecycle is reported as `subtype`; `status` is the same fact under the
    // name an earlier frame vocabulary used.
    const status = str(event.subtype) ?? str(event.status)
    const finished = status === 'completed' || status === 'error'

    let id = str(event.call_id)
    let idSource: string | undefined
    if (!id) {
      id = `tool-synth-${this.synthesized++}`
      idSource = 'synthesized-deterministic'
    }

    const prior = this.openTools.get(id)
    const orphanCompletion = finished && !prior
    // The tool, its arguments and its result all live inside the discriminated
    // `tool_call` payload; the flat fields are the older shape of the same three.
    const native = cursorToolPayload(event.tool_call)
    const name = str(event.name) ?? native?.name ?? prior?.name ?? 'unknown'
    // The running frame carries the arguments; the completed one need not repeat
    // them, so the opening call's input is what the block keeps.
    const input = prior?.input ?? native?.args ?? event.args ?? {}
    if (!prior) this.openTools.set(id, { name, input })

    const result = finished
      ? toolResult(native?.result ?? event.result, status === 'error')
      : undefined

    const block: CanonicalBlock = {
      type: 'tool_use',
      id,
      name,
      input,
      ...(result ? { result } : {}),
      vendorExtra: {
        category: cursorToolCategory(name) ?? 'unknown',
        ...(status ? { status } : {}),
        ...(idSource ? { idSource } : {}),
        // A completion for a call c3 never saw opened: surfaced as its own block
        // rather than guessed onto a neighbouring tool.
        ...(orphanCompletion ? { orphanCompletion: true } : {}),
      },
    }

    return {
      messages: [
        ...pending,
        this.envelope('assistant', [block], {
          // Cursor's permission decision is made once at launch; no per-call c3
          // or human ruling exists, so every tool is recorded as pre-approved.
          preApproved: true,
        }),
      ],
    }
  }

  /**
   * The run's lifecycle state. Only the terminal states matter to the driver;
   * `CREATING`/`RUNNING` are progress notices with no canonical analogue.
   */
  private onStatus(event: CursorEvent): CursorTranslation {
    const status = str(event.status)
    if (!status) return EMPTY
    const terminal = TERMINAL_STATUS[status]
    if (!terminal) return EMPTY
    const message = str(event.message)
    return {
      // The turn is over, so the last span is closed and emitted here — the
      // driver's own flush then has nothing left to do.
      messages: this.flush().messages,
      ended: {
        isError: terminal.isError,
        ...(terminal.isError ? { errorMessage: message ?? terminal.message } : {}),
      },
    }
  }

  /**
   * The turn's outcome frame — the terminal truth for a run.
   *
   * This is the only frame that reliably ends a turn, so it must close the open
   * span the way a terminal `status` does: a reply whose last paragraph is still
   * accumulating would otherwise never reach the transcript. Failure is read from
   * `is_error` when present, and inferred from a non-success `subtype` otherwise,
   * so an outcome c3 has not seen before is treated as a failure rather than
   * quietly passing as success.
   */
  private onResult(event: CursorEvent): CursorTranslation {
    const subtype = str(event.subtype)
    const isError =
      typeof event.is_error === 'boolean'
        ? event.is_error
        : subtype !== undefined && subtype !== 'success'
    return {
      messages: this.flush().messages,
      ended: {
        isError,
        ...(isError
          ? { errorMessage: str(event.message) ?? `cursor run ended: ${subtype ?? 'unknown'}` }
          : {}),
      },
    }
  }

  /**
   * A frame this translator does not model. It is preserved verbatim under
   * `vendorExtra` on an empty-block envelope so nothing is silently lost, while
   * still refusing to invent canonical content for it.
   */
  private unknown(event: CursorEvent, reason: string): CursorTranslation {
    return {
      messages: [this.envelope('assistant', [], { vendorExtra: { unhandled: { reason, event } } })],
    }
  }

  /** Wrap blocks in the canonical envelope for this run. */
  private envelope(
    role: CanonicalMessage['role'],
    blocks: CanonicalBlock[],
    extra?: { preApproved?: boolean; vendorExtra?: Record<string, unknown> },
  ): CanonicalMessage {
    return {
      vendor: 'cursor',
      sessionId: this.sessionId,
      role,
      blocks,
      ts: Date.now(),
      ...(extra?.preApproved ? { preApproved: true } : {}),
      ...(extra?.vendorExtra ? { vendorExtra: extra.vendorExtra } : {}),
    }
  }
}
