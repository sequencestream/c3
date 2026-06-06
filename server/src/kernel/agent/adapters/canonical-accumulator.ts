/**
 * Two-form canonical upsert (ADR-0013). The neutral reducer that lets the two
 * vendor message forms coexist over ONE model:
 *  - **Claude form** — a whole {@link CanonicalMessage} per frame (the full block
 *    set, idempotent re-emit). The Claude translator already produces these.
 *  - **Codex form** — incremental `ItemUpdated` frames that revise an earlier
 *    block in place (same `blockId`, new content).
 *
 * Both collapse to the same rule: a block is keyed by `(sessionId, block.id)` and
 * **upserted**, never blindly appended (011's D3 tool_use→result back-fill is the
 * canonical case of this). Blocks with no `id` (anonymous text/thinking) cannot
 * be correlated, so they always append — the upsert only fires when an id matches.
 *
 * This is a pure, in-memory view builder; it owns no I/O and no SDK type. The
 * approval/permission stream is deliberately NOT modelled here — it rides the
 * {@link ApprovalBridge}, keeping this envelope from becoming a god type.
 */
import type { CanonicalBlock, CanonicalMessage, CanonicalRole } from './types.js'

/** True when both blocks carry the same non-empty correlation id. */
function sameBlock(a: CanonicalBlock, b: CanonicalBlock): boolean {
  return a.id != null && b.id != null && a.id === b.id
}

/**
 * Merge an `incoming` block onto a `prior` one with the same id. Field-wise
 * last-writer-wins with one structural rule: a `tool_use`'s embedded `result` is
 * preserved when the incremental frame omits it (back-fill is monotonic — a
 * later input-only revision never erases a result that already arrived), and
 * filled when present.
 */
function mergeBlock(prior: CanonicalBlock, incoming: CanonicalBlock): CanonicalBlock {
  if (prior.type === 'tool_use' && incoming.type === 'tool_use') {
    return {
      ...prior,
      ...incoming,
      result: incoming.result ?? prior.result,
      vendorExtra: { ...prior.vendorExtra, ...incoming.vendorExtra },
    }
  }
  // text / thinking (or a type flip, which we treat as a full replacement but
  // keep the id): take the incoming content, union the overflow.
  return { ...incoming, vendorExtra: { ...prior.vendorExtra, ...incoming.vendorExtra } }
}

/**
 * Apply one block to a block list by id-upsert. Returns a NEW array (no mutation
 * of the input) so callers can keep prior snapshots. An id hit merges in place
 * (position preserved); a miss appends.
 */
export function upsertBlock(blocks: CanonicalBlock[], incoming: CanonicalBlock): CanonicalBlock[] {
  if (incoming.id != null) {
    const at = blocks.findIndex((b) => sameBlock(b, incoming))
    if (at >= 0) {
      const next = blocks.slice()
      next[at] = mergeBlock(blocks[at], incoming)
      return next
    }
  }
  return [...blocks, incoming]
}

/** The accumulated per-session envelope: a single merged view keyed by sessionId. */
interface SessionView {
  vendor: CanonicalMessage['vendor']
  sessionId: string
  turnId?: string
  role: CanonicalRole
  blocks: CanonicalBlock[]
  ts: number
  /** Sticky once seen: a preApproved frame marks the whole accumulated view (audit). */
  preApproved?: boolean
  vendorExtra?: Record<string, unknown>
}

/**
 * Accumulates canonical messages into one upserted view per session. Feed it
 * either form — a whole Claude message or a Codex incremental frame — and read
 * {@link snapshot} for the current normalized blocks. Newest envelope metadata
 * (role/turnId/ts/vendorExtra) wins; blocks merge by id-upsert.
 */
export class CanonicalAccumulator {
  private readonly views = new Map<string, SessionView>()

  /** Upsert one message (whole-message OR incremental) into its session's view. */
  upsert(msg: CanonicalMessage): void {
    const prior = this.views.get(msg.sessionId)
    if (!prior) {
      // Seed: still upsert block-by-block so an opening frame that repeats an id
      // (rare, but legal) collapses rather than duplicates.
      let blocks: CanonicalBlock[] = []
      for (const b of msg.blocks) blocks = upsertBlock(blocks, b)
      this.views.set(msg.sessionId, {
        vendor: msg.vendor,
        sessionId: msg.sessionId,
        turnId: msg.turnId,
        role: msg.role,
        blocks,
        ts: msg.ts,
        ...(msg.preApproved ? { preApproved: true } : {}),
        vendorExtra: msg.vendorExtra,
      })
      return
    }
    let blocks = prior.blocks
    for (const b of msg.blocks) blocks = upsertBlock(blocks, b)
    this.views.set(msg.sessionId, {
      ...prior,
      // Envelope metadata: newest wins (role can flip user→assistant across frames).
      turnId: msg.turnId ?? prior.turnId,
      role: msg.role,
      ts: msg.ts,
      // Sticky: once any frame is preApproved, the accumulated view stays marked
      // (the auto-allow audit fact never un-happens within a turn).
      preApproved: msg.preApproved || prior.preApproved,
      vendorExtra:
        msg.vendorExtra || prior.vendorExtra
          ? { ...prior.vendorExtra, ...msg.vendorExtra }
          : undefined,
      blocks,
    })
  }

  /** The current normalized blocks for a session (empty when unseen). */
  snapshot(sessionId: string): CanonicalBlock[] {
    return this.views.get(sessionId)?.blocks ?? []
  }

  /** The full normalized message for a session, or null when unseen. */
  message(sessionId: string): CanonicalMessage | null {
    const v = this.views.get(sessionId)
    if (!v) return null
    return {
      vendor: v.vendor,
      sessionId: v.sessionId,
      turnId: v.turnId,
      role: v.role,
      blocks: v.blocks,
      ts: v.ts,
      ...(v.preApproved ? { preApproved: true } : {}),
      vendorExtra: v.vendorExtra,
    }
  }
}
