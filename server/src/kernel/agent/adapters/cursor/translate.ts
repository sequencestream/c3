/**
 * Cursor SDK stream → {@link CanonicalMessage} normalization (ADR-0011/0013).
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
 * Two properties of c3's wire consumer shape everything here. First, blocks are
 * append-with-**id-upsert**, so a block that revises an earlier one must reuse
 * its id. Second, the consumer emits only the *new suffix* of a text block, so
 * text carried under a stable id must always be **cumulative**, never a delta —
 * forwarding the SDK's deltas verbatim under one id would truncate the visible
 * output. This translator therefore accumulates text itself and re-emits the
 * whole span.
 *
 * Span boundaries, in the order the wire model requires:
 *  - Text accumulates into one open block until something interrupts it (a tool
 *    call, a reasoning span, the turn's end). The next delta then opens a NEW
 *    block, so text that follows a tool call is never retro-appended in front of
 *    it and the transcript keeps the order the model produced.
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
  agent_id?: unknown
  run_id?: unknown
  call_id?: unknown
  name?: unknown
  status?: unknown
  args?: unknown
  result?: unknown
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

/**
 * Stateful normalizer for one Cursor run.
 *
 * State exists for three reasons the stream forces on us: text arrives as deltas
 * that must be re-emitted cumulatively under one id, reasoning arrives the same
 * way and must be joined into one block, and tool results arrive in separate
 * frames that must find their originating call by id.
 */
export class CursorStreamTranslator {
  private sessionId: string
  /** Reasoning accumulated for the open thinking span. */
  private thinking = ''
  /** Id of the open thinking span; cleared when the span completes. */
  private thinkingId: string | null = null
  /** Text accumulated for the open assistant span. */
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

  /** Translate one frame. Frames that carry no canonical meaning yield nothing. */
  consume(event: CursorEvent): CursorTranslation {
    const sid = str(event.agent_id)
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
   * Native reasoning. Deltas accumulate into a single block re-emitted in full,
   * which is what keeps the consumer's suffix-diffing correct. The closing frame
   * carries no text (only a duration), so it ends the span rather than extending it.
   */
  private onThinking(event: CursorEvent): CursorTranslation {
    const delta = str(event.text)
    if (!delta) {
      // Empty text closes the span — the SDK's `thinking-completed` shape.
      this.thinking = ''
      this.thinkingId = null
      return EMPTY
    }

    // Reasoning interrupts any open prose span: the next text delta must start
    // its own block rather than reopening one the model has moved past.
    this.assistantId = null
    this.assistant = ''

    this.thinkingId ??= `thinking-${this.thinkingSeq++}`
    this.thinking += delta

    return {
      messages: [
        this.envelope('assistant', [
          { type: 'thinking', thinking: this.thinking, id: this.thinkingId },
        ]),
      ],
    }
  }

  /**
   * An assistant text delta. Accumulated under one id and always re-emitted in
   * full; a new span begins whenever the previous one was interrupted.
   */
  private onAssistant(event: CursorEvent): CursorTranslation {
    const text = messageText(event.message)
    if (!text) return EMPTY

    // Prose ends any open reasoning span, so a later reasoning delta opens a new
    // block instead of appending to one the model has already left behind.
    this.thinkingId = null
    this.thinking = ''

    if (this.assistantId === null) {
      this.assistantId = `assistant-${this.assistantSeq++}`
      this.assistant = ''
    }
    this.assistant += text

    return {
      messages: [
        this.envelope('assistant', [{ type: 'text', text: this.assistant, id: this.assistantId }]),
      ],
    }
  }

  /** A tool frame, correlated by the stable native `call_id`. */
  private onToolCall(event: CursorEvent): CursorTranslation {
    // A tool call ends the open prose and reasoning spans: whatever the model
    // says next belongs after the call, not merged into what came before it.
    this.assistantId = null
    this.assistant = ''
    this.thinkingId = null
    this.thinking = ''

    const status = str(event.status)
    const finished = status === 'completed' || status === 'error'

    let id = str(event.call_id)
    let idSource: string | undefined
    if (!id) {
      id = `tool-synth-${this.synthesized++}`
      idSource = 'synthesized-deterministic'
    }

    const prior = this.openTools.get(id)
    const orphanCompletion = finished && !prior
    const name = str(event.name) ?? prior?.name ?? 'unknown'
    // The running frame carries the arguments; the completed one need not repeat
    // them, so the opening call's input is what the block keeps.
    const input = prior?.input ?? event.args ?? {}
    if (!prior) this.openTools.set(id, { name, input })

    const result = finished ? toolResult(event.result, status === 'error') : undefined

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
      messages: [],
      ended: {
        isError: terminal.isError,
        ...(terminal.isError ? { errorMessage: message ?? terminal.message } : {}),
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
