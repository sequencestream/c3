/**
 * OpenCode → canonical translation (ADR-0013, 2026-06-06-003). OpenCode is the
 * *incremental* vendor: it streams `message.part.updated` frames that revise a
 * part in place, and embeds a tool's return inside the same `tool` part's `state`
 * (no standalone result frame) — which is exactly the D3 "tool_use carries its
 * result, upsert by id" shape the canonical model was built around. So a part maps
 * to one {@link CanonicalBlock} keyed by its correlation id, and the upper layer's
 * `CanonicalAccumulator` merges successive revisions.
 *
 * ADR-0009: SDK types (`Message`/`Part`/`ToolState`) are imported here (this is
 * inside `adapters/opencode/`) and narrowed at runtime; only canonical shapes
 * leave this module.
 */
import type { Message, Part, ToolState } from '@opencode-ai/sdk'
import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRole,
  CanonicalToolResult,
} from '../types.js'

/** A tool part's embedded return, or undefined while it is still pending/running. */
function toolStateToResult(state: ToolState): CanonicalToolResult | undefined {
  if (state.status === 'completed') {
    return { content: state.output, isError: false, vendorExtra: { title: state.title } }
  }
  if (state.status === 'error') {
    return { content: state.error, isError: true }
  }
  return undefined // pending / running — no result yet (back-filled on a later frame)
}

/** A tool part's input args, present once the call has them (running/completed/error). */
function toolStateInput(state: ToolState): unknown {
  return 'input' in state ? (state.input ?? {}) : {}
}

/**
 * Map one OpenCode `Part` to a canonical block, or null when the part has no
 * canonical analogue (step-start/finish, files, synthetic/ignored text). Text uses
 * the part `id`; a tool uses its `callID` (cross-frame correlation, ADR-0013).
 */
export function partToBlock(part: Part): CanonicalBlock | null {
  if (part.type === 'text') {
    if (part.synthetic || part.ignored) return null
    return { type: 'text', text: part.text, id: part.id }
  }
  if (part.type === 'tool') {
    return {
      type: 'tool_use',
      id: part.callID,
      name: part.tool,
      input: toolStateInput(part.state),
      ...(toolStateToResult(part.state) ? { result: toolStateToResult(part.state) } : {}),
      vendorExtra: { partId: part.id, messageID: part.messageID, status: part.state.status },
    }
  }
  return null
}

/** Build a whole canonical message from a stored `{ info, parts }` row (session read). */
export function messageToCanonical(info: Message, parts: Part[]): CanonicalMessage {
  const blocks: CanonicalBlock[] = []
  for (const p of parts) {
    const b = partToBlock(p)
    if (b) blocks.push(b)
  }
  return {
    vendor: 'opencode',
    sessionId: info.sessionID,
    role: info.role,
    blocks,
    ts: info.time.created,
  }
}

/**
 * Streaming translator for the live run. OpenCode part frames carry no role (only
 * the message does), so it remembers each message's role from `message.updated`
 * and stamps it onto the part's canonical frame; unknown ⇒ `assistant` (the live
 * stream is overwhelmingly model output). Each translated part is a single-block
 * `CanonicalMessage` the accumulator upserts by block id.
 */
export class OpencodeStreamTranslator {
  private readonly roles = new Map<string, CanonicalRole>()

  /** Record a message's role (from a `message.updated` frame). */
  noteMessage(info: Message): void {
    this.roles.set(info.id, info.role)
  }

  /** Translate one `message.part.updated` part into a canonical frame, or null to skip. */
  translatePart(part: Part, sessionId: string, now: number): CanonicalMessage | null {
    const block = partToBlock(part)
    if (!block) return null
    return {
      vendor: 'opencode',
      sessionId,
      role: this.roles.get(part.messageID) ?? 'assistant',
      blocks: [block],
      ts: now,
    }
  }
}
