/**
 * PR review / fix relay occupancy — the persistent, owner-safe slot a Review or
 * Fix session holds from the moment the queue claims it until it truly ends.
 *
 * It is the spec phase's occupancy model ({@link isSpecOccupancyAlive}) applied to
 * the relay, and it exists for the same reason: `review_session_id` /
 * `fix_session_id` only carry a REAL session id once the vendor bound one, and
 * between the claim and that bind — vendor cold start, relay queueing, credential
 * handshake — a tick past the 5s cooldown would otherwise start a second agent on
 * the same PR. So the claim itself is the occupancy:
 *
 *   - the launcher writes a `pending:` placeholder into the phase's session field
 *     inside the SAME conditional update that sets `pending` and (for a fix) the
 *     round counter, so a phase, its session and its budget can never disagree;
 *   - the dispatcher's bind callback replaces the placeholder with the real
 *     session id, and only while the field still holds THAT placeholder;
 *   - a launch that failed or a settle with no result releases it, again only
 *     while it still holds that placeholder;
 *   - after a restart a `pending:` value with no live run stays occupied until its
 *     projection row ages past the bounded grace window.
 *
 * The two invariants that keep an occupancy from becoming a permanent lock are
 * inherited verbatim from the spec phase: a claim refuses to write the ledger
 * field when the pending projection row could not be written, and a `pending:`
 * value whose projection row is MISSING counts as stale, never as fresh.
 *
 * The ROUND counter is deliberately not rolled back by a release. A fix round the
 * queue claimed stays claimed even if its launch died — recovering a phase must
 * not refund convergence budget, or a crash loop would review forever.
 */
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { IntentFixStatus, IntentReviewStatus, VendorId } from '@ccc/shared/protocol'
import { upsertPendingRow } from '../sessions/session-metadata-store.js'
import {
  claimIntentRelayPhase,
  releaseIntentRelayPhase,
  replaceIntentRelaySession,
} from './store.js'

/** Which half of the relay a call is about. */
export type RelayPhase = 'review' | 'fix'

/** The identity a claim persists into the pending session projection row. */
export interface RelayOccupancyRow {
  workspacePath: string
  /** The vendor chosen ONCE at claim time from the phase's agent role. */
  vendor: VendorId
  /** The agent (or group) reference chosen ONCE at claim time. */
  agentId: string
  title: string
}

/** The facts a claim expects to still find — the kernel's snapshot, re-checked. */
export interface RelayClaimExpectation {
  expectReviewStatus: IntentReviewStatus | null
  expectFixStatus: IntentFixStatus | null
  expectRounds: number
  /** The counter to persist; only a NEW fix round raises it. */
  nextRounds: number
}

export type RelayClaimResult =
  | { ok: true }
  /** Another pass, or a human, moved the phase since the kernel's snapshot. */
  | { ok: false; reason: 'stale' }
  /** The pending projection row could not be written — nothing was claimed. */
  | { ok: false; reason: 'projection-write-failed' }

/** Mint a fresh placeholder id for a relay phase about to be claimed. */
export function newRelayPendingId(): string {
  return `${PENDING_SESSION_PREFIX}${randomUUID()}`
}

/**
 * Claim one relay phase for `pendingId`.
 *
 * The projection row is written FIRST and the ledger field only after it, so a
 * `pending:` value that appears in the ledger always has a row to time its
 * staleness from. When the ledger claim then loses its conditional check the row
 * is left behind harmlessly: it owns no ledger field, so it times out unread.
 */
export function claimRelayOccupancy(
  intentId: string,
  phase: RelayPhase,
  pendingId: string,
  expectation: RelayClaimExpectation,
  row: RelayOccupancyRow,
): RelayClaimResult {
  let rowWritten: boolean
  try {
    rowWritten = upsertPendingRow({
      pendingId,
      workspacePath: row.workspacePath,
      vendor: row.vendor,
      agentId: row.agentId,
      title: row.title,
      ownerKind: 'intent',
      ownerId: intentId,
    })
  } catch (err) {
    console.warn(`[c3:intents] ${phase} 接力占位投影写入失败: ${errMsg(err)}`)
    rowWritten = false
  }
  if (!rowWritten) {
    console.warn(
      `[c3:intents] claimRelayOccupancy 拒绝:${pendingId} 的 pending 投影行不可写,${phase} 阶段未改动`,
    )
    return { ok: false, reason: 'projection-write-failed' }
  }
  const claimed = claimIntentRelayPhase(intentId, {
    phase,
    pendingSessionId: pendingId,
    ...expectation,
  })
  return claimed ? { ok: true } : { ok: false, reason: 'stale' }
}

/**
 * Replace a claimed placeholder with the real session the vendor bound, only
 * while the phase still holds that placeholder. A bind callback that arrives
 * after a newer phase took the slot writes nothing.
 */
export function bindRelayOccupancy(
  intentId: string,
  phase: RelayPhase,
  pendingId: string,
  realSessionId: string,
): boolean {
  if (!realSessionId || realSessionId === pendingId) return false
  return replaceIntentRelaySession(intentId, phase, pendingId, realSessionId)
}

/**
 * Release a phase whose session never produced a conclusion — a refused launch,
 * a crash, an abort, or an exit with no terminal. Clears the placeholder and the
 * transient `pending` marker (never a real terminal that landed meanwhile) and
 * leaves the round counter alone. Owner-safe.
 */
export function releaseRelayOccupancy(
  intentId: string,
  phase: RelayPhase,
  sessionId: string,
): boolean {
  return releaseIntentRelayPhase(intentId, phase, sessionId)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
