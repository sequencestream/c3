/**
 * Cursor stream → {@link CanonicalMessage} normalization (ADR-0011/0013).
 *
 * The CLI emits NDJSON frames of these shapes:
 *   `system/init`            — the run's `session_id`, cwd, model, permissionMode.
 *   `user`                   — the prompt c3 just sent, echoed back.
 *   `thinking/delta`         — a chunk of native reasoning; `thinking/completed`
 *                              closes the current reasoning span.
 *   `assistant`              — a whole assistant message (not a delta), optionally
 *                              tagged with the `model_call_id` it belongs to.
 *   `tool_call/started`      — a tool began; `tool_call/completed` finishes it.
 *   `result/success|error`   — the turn's terminal frame, with usage and timing.
 *
 * Two properties of the wire consumer shape everything here. First, blocks are
 * append-with-**id-upsert**, so a block that revises an earlier one must reuse
 * its id. Second, the consumer emits only the *new suffix* of a text block, so
 * text carried under a stable id must always be **cumulative**, never a delta —
 * emitting deltas under one id would truncate the visible output. This
 * translator therefore accumulates text itself and re-emits the whole span.
 *
 * Correlation rules, in the order the spec requires:
 *  - Tool frames carry a stable `call_id`, identical on `started` and `completed`,
 *    so results are back-filled onto the same `tool_use` block by that id. Frames
 *    are never paired by arrival order, which would mis-associate concurrent calls.
 *  - When a frame arrives without a usable `call_id`, a deterministic id is
 *    synthesized from the turn, the native event kind and a per-kind sequence
 *    number, and the block records that degradation in `vendorExtra`.
 *  - A completion whose `call_id` was never opened is not force-fitted onto some
 *    other tool: it opens its own block, flagged as orphaned.
 *
 * Anything the canonical model cannot express — native tool argument shapes, the
 * raw wrapper key, usage, request ids, unknown frame types — is preserved under
 * `vendorExtra` rather than dropped or flattened into a lie. `thinking` blocks
 * are produced **only** from native `thinking` frames; no heuristic ever infers
 * reasoning from message text or event names.
 */
import type { CanonicalBlock, CanonicalMessage, CanonicalToolResult } from '../types.js'
import { cursorToolCategory, cursorToolDisplayName } from './tools.js'

/** A parsed NDJSON frame. Unknown shapes are tolerated, never assumed. */
export interface CursorEvent {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  call_id?: unknown
  model_call_id?: unknown
  message?: unknown
  text?: unknown
  tool_call?: unknown
  timestamp_ms?: unknown
  [key: string]: unknown
}

/** What the driver should do with a frame beyond emitting messages. */
export interface CursorTranslation {
  /** Canonical messages to publish, in order. */
  messages: CanonicalMessage[]
  /** The native session id, present on the frame that first reports it. */
  sessionId?: string
  /** Set when the frame terminates the turn. */
  ended?: { isError: boolean; errorMessage?: string }
}

const EMPTY: CursorTranslation = { messages: [] }

/** Read a string field, treating blank strings as absent. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Flatten Cursor's `{ role, content: [{type:'text', text}] }` message shape. */
function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' ? str((part as { text?: unknown }).text) : undefined,
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
 * Collapse a native tool result into the canonical flat display string. Cursor
 * nests results as `{ success: {...} }` or `{ error: {...} }`; the whole native
 * object is kept on the result's own `vendorExtra` while a readable rendering is
 * flattened out for display.
 */
function toolResult(raw: unknown): CanonicalToolResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const isError = 'error' in record
  const payload = isError ? record.error : record.success
  if (payload === undefined) return undefined
  return { content: flattenToText(payload), isError, vendorExtra: { native: payload } }
}

/**
 * Stateful normalizer for one Cursor run.
 *
 * State exists for three reasons the stream forces on us: text arrives as spans
 * that must be re-emitted cumulatively, reasoning arrives as deltas that must be
 * joined into one block, and tool results arrive in separate frames that must
 * find their originating call by id.
 */
export class CursorStreamTranslator {
  private sessionId: string
  /** Monotonic counter making every synthesized id unique within the turn. */
  private synthesized = 0
  /** Reasoning accumulated for the open thinking span. */
  private thinking = ''
  /** Id of the open thinking span; cleared when the span completes. */
  private thinkingId: string | null = null
  /** Assistant text accumulated per block id, so re-emits stay cumulative. */
  private readonly assistantText = new Map<string, string>()
  /** Tool calls opened so far, so a completion can find its own block. */
  private readonly openTools = new Map<
    string,
    { name: string; wrapperKey: string; input: unknown }
  >()
  /** Assistant messages seen, giving anonymous frames a stable ordinal id. */
  private assistantSeq = 0
  /** Thinking spans seen, giving each its own stable id. */
  private thinkingSeq = 0

  constructor(sessionId = '') {
    this.sessionId = sessionId
  }

  /** The native session id observed so far (empty until `system/init`). */
  get currentSessionId(): string {
    return this.sessionId
  }

  /** Translate one frame. Frames that carry no canonical meaning yield nothing. */
  consume(event: CursorEvent): CursorTranslation {
    const sid = str(event.session_id)
    if (sid) this.sessionId = sid

    const type = str(event.type)
    if (!type) return this.unknown(event, 'missing-type')

    switch (type) {
      case 'system':
        // Carries the session id (already captured above) and run metadata; the
        // metadata is not a message, so nothing is emitted for it.
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

      case 'result':
        return this.onResult(event)

      default:
        return this.unknown(event, 'unknown-type')
    }
  }

  /**
   * Native reasoning. Deltas accumulate into a single block re-emitted in full,
   * which is what keeps the consumer's suffix-diffing correct.
   */
  private onThinking(event: CursorEvent): CursorTranslation {
    const subtype = str(event.subtype)
    if (subtype === 'completed') {
      this.thinking = ''
      this.thinkingId = null
      return EMPTY
    }

    const delta = str(event.text)
    if (!delta) return EMPTY

    this.thinkingId ??= `thinking-${this.thinkingSeq++}`
    this.thinking += delta

    return {
      messages: [
        this.envelope('assistant', [
          {
            type: 'thinking',
            thinking: this.thinking,
            id: this.thinkingId,
          },
        ]),
      ],
    }
  }

  /**
   * A whole assistant message. Cursor sends complete text (not deltas) and may
   * repeat a `model_call_id` across frames of the same model turn, so text is
   * accumulated per id and always re-emitted in full.
   */
  private onAssistant(event: CursorEvent): CursorTranslation {
    const text = messageText(event.message)
    if (!text) return EMPTY

    // A `model_call_id` groups frames of one model turn; without it each frame is
    // its own span, numbered deterministically rather than merged by guesswork.
    const id = str(event.model_call_id) ?? `assistant-${this.assistantSeq++}`
    const merged = (this.assistantText.get(id) ?? '') + text
    this.assistantText.set(id, merged)

    return {
      messages: [
        this.envelope('assistant', [
          {
            type: 'text',
            text: merged,
            id,
            ...(str(event.model_call_id)
              ? {}
              : { vendorExtra: { idSource: 'synthesized-ordinal' } }),
          },
        ]),
      ],
    }
  }

  /** A tool start or completion, correlated by the stable native `call_id`. */
  private onToolCall(event: CursorEvent): CursorTranslation {
    const wrapper = event.tool_call
    if (!wrapper || typeof wrapper !== 'object')
      return this.unknown(event, 'tool-call-without-payload')

    // The tool's identity is the wrapper key; `hookAdditionalContexts` and the
    // bookkeeping fields alongside it are not tools.
    const record = wrapper as Record<string, unknown>
    const wrapperKey = Object.keys(record).find((key) => key.endsWith('ToolCall'))
    if (!wrapperKey) return this.unknown(event, 'tool-call-without-kind')

    const payload = (record[wrapperKey] ?? {}) as Record<string, unknown>
    const completed = str(event.subtype) === 'completed'

    // `call_id` is stable across started/completed. It may embed a newline, so it
    // is used verbatim as a map key and never parsed or split.
    let id = str(event.call_id) ?? str(record.toolCallId)
    let idSource: string | undefined
    if (!id) {
      id = `${wrapperKey}-synth-${this.synthesized++}`
      idSource = 'synthesized-deterministic'
    }

    const prior = this.openTools.get(id)
    const orphanCompletion = completed && !prior
    const name = prior?.name ?? cursorToolDisplayName(wrapperKey)
    const input = prior?.input ?? payload.args ?? {}
    if (!prior) this.openTools.set(id, { name, wrapperKey, input })

    const result = completed ? toolResult(payload.result) : undefined

    const block: CanonicalBlock = {
      type: 'tool_use',
      id,
      name,
      input,
      ...(result ? { result } : {}),
      vendorExtra: {
        wrapperKey,
        category: cursorToolCategory(wrapperKey) ?? 'unknown',
        ...(idSource ? { idSource } : {}),
        // A completion for a call c3 never saw opened: surfaced as its own block
        // rather than guessed onto a neighbouring tool.
        ...(orphanCompletion ? { orphanCompletion: true } : {}),
        ...(str(event.model_call_id) ? { modelCallId: event.model_call_id } : {}),
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

  /** The turn's terminal frame. */
  private onResult(event: CursorEvent): CursorTranslation {
    const isError = event.is_error === true || str(event.subtype) === 'error'
    const errorMessage = isError
      ? (str(event.result) ?? str(event.error) ?? 'cursor run failed')
      : undefined
    return { messages: [], ended: { isError, ...(errorMessage ? { errorMessage } : {}) } }
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
