/**
 * Spec-phase occupancy — the persistent, owner-safe slot an intent's spec
 * AUTHORING or spec REVIEW session holds from the moment it is launched until it
 * truly ends.
 *
 * Why this exists: the queue used to decide "a spec phase is running" only from
 * `alive(intent.specSessionId)`, and `spec_session_id` was only written on
 * `run:bound`. Between launch and bind — vendor cold start, relay queueing,
 * credential handshake — that field was still `null`, so a tick past the 5s
 * cooldown re-launched the same spec session. This module closes that gap by
 * making the occupancy a fact that holds at launch time:
 *
 *   - the launcher writes the pending id into `spec_session_id` /
 *     `spec_review_session_id` (conditionally, before scaffolding or launching);
 *   - the resident `run:bound` subscription replaces it with the real id only
 *     when the field still equals THAT pending id (a late event never clobbers
 *     a newer owner);
 *   - a launch failure / settle-without-bind releases the field (again only
 *     when it still equals the pending id);
 *   - after a process restart a `pending:` value with no live run stays
 *     occupied until its pending projection row ages past a bounded grace
 *     window, then it is released so the queue can re-launch.
 *
 * Two invariants keep the occupancy from ever becoming a permanent lock:
 *
 *   - a claim refuses to write the ledger field when the pending projection row
 *     could not be written — a `pending:` value in the ledger always has a row
 *     to time its staleness from, so a claim that cannot write the row registers
 *     NO occupancy at all (the caller fails, the queue retries on a later tick);
 *   - a `pending:` value whose projection row is MISSING (a pre-fix leftover, or
 *     a crash after the bind deleted the row but before the field was replaced)
 *     is treated as stale, not fresh — it is recoverable and re-claimable,
 *     never a permanent occupancy.
 *
 * Every write here is owner-safe: it reads the CURRENT value and only acts when
 * it still matches the caller's pending id, so an old run can never release a
 * new run's occupancy. All functions are synchronous (better-sqlite3), so a
 * read-check-write is atomic within the process.
 */
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { VendorId } from '@ccc/shared/protocol'
import { isRunning } from '../../runs.js'
import { resolveSessionVendor } from '../../kernel/agent-config/index.js'
import { getByC3Id, updateRowOwner, upsertPendingRow } from '../sessions/session-metadata-store.js'
import { getIntent, setSpecReviewSessionId, setSpecSessionId } from './store.js'

/**
 * How long a `pending:` occupancy may sit with no live run (process restart or
 * a launch that died before it bound) before it is treated as stale and
 * released. During the window the queue prefers to delay a retry rather than
 * risk starting a second spec session on the same document. In-process a live
 * run reports itself through `isRunning`, so this grace only bites after a
 * restart — where the previous process's run can never bind again.
 */
export const SPEC_OCCUPANCY_GRACE_MS = 5 * 60 * 1000

/** The fields a claim persists into the pending session projection row. */
export interface SpecOccupancyRow {
  workspacePath: string
  vendor: VendorId
  agentId: string
  title: string
}

export type SpecOccupancyClaim =
  | { ok: true; owner: null }
  | { ok: false; owner: string }
  | { ok: false; owner: null; reason: 'projection-write-failed' }

/** True when the session-occupancy slot for an id is currently `pending:`-shaped. */
function isPendingId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX)
}

/**
 * Whether the pending projection row for `pendingId` was created recently
 * enough to still count as an active occupancy. A `pending:` value in the
 * intent ledger is written together with its projection row (see the claim
 * functions below), so a row is present on every healthy claim. A MISSING row
 * therefore means the occupancy is broken — a claim whose projection write
 * failed, or a crash after the bind deleted the row but before the ledger field
 * was replaced — and treating it as permanently fresh would lock the intent
 * into a spec phase that can never end. A missing (or anomalously bound) row is
 * treated as NOT fresh, so the slot is recoverable and the queue can re-claim
 * it. The just-claimed microsecond window cannot misfire here: a successful
 * claim's row is written before the ledger field, and a running process cannot
 * be preempted between the two synchronous writes.
 */
function pendingIsFresh(pendingId: string, now: number): boolean {
  const row = getByC3Id(pendingId)
  if (!row || row.bound) return false
  return now - row.stateUpdatedAt < SPEC_OCCUPANCY_GRACE_MS
}

/**
 * Project one spec session id onto "is this spec phase still occupied?" — the
 * fact the queue kernel and the launchers both consume, so neither re-derives
 * the bind timing on its own.
 *
 * - a live run is occupied, whatever the id;
 * - a real (bound) id with no live run is idle (kept for history, resumable);
 * - a `pending:` id is occupied until its projection row ages past the grace.
 */
export function isSpecOccupancyAlive(
  sessionId: string,
  isRunningFn: (sessionId: string) => boolean,
  now: number,
): boolean {
  if (isRunningFn(sessionId)) return true
  if (!isPendingId(sessionId)) return false
  return pendingIsFresh(sessionId, now)
}

/**
 * Whether an intent's spec-AUTHORING slot may be claimed right now. Free when
 * empty, or when it holds a stale `pending:` (the old launch died). A real
 * bound id is never overwritten here — the launcher resumes it instead.
 */
function specSlotFree(current: string | null): boolean {
  if (current === null) return true
  if (!isPendingId(current)) return false
  return !isSpecOccupancyAlive(current, isRunning, Date.now())
}

/**
 * Whether an intent's spec-REVIEW slot may be claimed right now. Free when
 * empty, a stale `pending:`, or a real previous review that is no longer
 * running (a review is one-shot per document version, so a new one replaces
 * it — but never while the old one is live).
 */
function reviewSlotFree(current: string | null): boolean {
  if (current === null) return true
  if (isPendingId(current)) return !isSpecOccupancyAlive(current, isRunning, Date.now())
  return !isRunning(current)
}

/** The intent's CURRENT spec_session_id, re-read from the ledger. */
function currentSpecSessionId(intentId: string): string | null {
  return getIntent(intentId)?.specSessionId ?? null
}

/** The intent's CURRENT spec_review_session_id, re-read from the ledger. */
function currentSpecReviewSessionId(intentId: string): string | null {
  return getIntent(intentId)?.specReviewSessionId ?? null
}

/** De-own a real (bound) spec-REVIEW session the intent no longer links to. */
function deOwnReviewSession(realId: string): void {
  updateRowOwner({
    sessionId: realId,
    vendor: resolveSessionVendor(realId),
    ownerKind: null,
    ownerId: null,
  })
}

/**
 * Write the pending projection row for an occupancy claim. Returns false when
 * the row could not be written (db unavailable, or the statement threw) — the
 * claim must then register NO occupancy rather than leave a ledger value with
 * no row to time its staleness from.
 */
function writePendingRow(
  kind: 'spec' | 'spec review',
  intentId: string,
  pendingId: string,
  row: SpecOccupancyRow,
): boolean {
  try {
    return upsertPendingRow({
      pendingId,
      workspacePath: row.workspacePath,
      vendor: row.vendor,
      agentId: row.agentId,
      title: row.title,
      ownerKind: 'intent',
      ownerId: intentId,
    })
  } catch (err) {
    console.warn(`[c3:intents] ${kind} session projection write failed: ${errMsg(err)}`)
    return false
  }
}

/**
 * Claim the intent's spec-AUTHORING slot for `pendingId`. The claim writes the
 * pending projection row first and ONLY THEN the `spec_session_id` field, so a
 * value that appears in the ledger always has a projection row to time its
 * staleness from. Returns `{ok:false, owner}` when the slot is already held by
 * a live run or a still-valid pending — the caller then attaches to `owner`
 * and scaffolds nothing. Returns `{ok:false, owner:null, reason:
 * 'projection-write-failed'}` when the projection row could not be written —
 * the slot is left untouched and the caller reports a failure (the queue
 * retries on a later tick) instead of registering a permanent occupancy.
 */
export function claimSpecOccupancy(
  intentId: string,
  pendingId: string,
  row: SpecOccupancyRow,
): SpecOccupancyClaim {
  const current = currentSpecSessionId(intentId)
  // `specSlotFree` only returns false when the slot actually holds an owner
  // (it is free when `current === null`), so `current` is non-null here.
  if (!specSlotFree(current)) return { ok: false, owner: current as string }
  if (!writePendingRow('spec', intentId, pendingId, row)) {
    console.warn(
      `[c3:intents] claimSpecOccupancy refused: pending projection row unavailable for ${pendingId}; spec_session_id left unchanged`,
    )
    return { ok: false, owner: null, reason: 'projection-write-failed' }
  }
  setSpecSessionId(intentId, pendingId)
  return { ok: true, owner: null }
}

/**
 * Atomically claim the intent's spec-REVIEW slot for `pendingId`. Same shape as
 * {@link claimSpecOccupancy}, with one extra step: when the slot holds a real
 * (bound) previous review that has ended, that old review is de-owned here
 * (one-shot review semantics), because the ledger column can only carry one
 * value and the new review replaces it before any bind.
 */
export function claimSpecReviewOccupancy(
  intentId: string,
  pendingId: string,
  row: SpecOccupancyRow,
): SpecOccupancyClaim {
  const current = currentSpecReviewSessionId(intentId)
  // `reviewSlotFree` only returns false when the slot actually holds an owner
  // (it is free when `current === null`), so `current` is non-null here.
  if (!reviewSlotFree(current)) return { ok: false, owner: current as string }
  if (current !== null && !isPendingId(current)) deOwnReviewSession(current)
  if (!writePendingRow('spec review', intentId, pendingId, row)) {
    console.warn(
      `[c3:intents] claimSpecReviewOccupancy refused: pending projection row unavailable for ${pendingId}; spec_review_session_id left unchanged`,
    )
    return { ok: false, owner: null, reason: 'projection-write-failed' }
  }
  setSpecReviewSessionId(intentId, pendingId)
  return { ok: true, owner: null }
}

/** Release the intent's spec-AUTHORING occupancy, only when it is still `pendingId`. */
export function releaseSpecOccupancy(intentId: string, pendingId: string): void {
  if (currentSpecSessionId(intentId) !== pendingId) return
  setSpecSessionId(intentId, null)
}

/** Release the intent's spec-REVIEW occupancy, only when it is still `pendingId`. */
export function releaseSpecReviewOccupancy(intentId: string, pendingId: string): void {
  if (currentSpecReviewSessionId(intentId) !== pendingId) return
  setSpecReviewSessionId(intentId, null)
}

/**
 * Replace the intent's spec-AUTHORING occupancy with the real bound id, but
 * ONLY when the field still equals `expectedPending`. A `run:bound` event that
 * arrives after a newer owner took the slot must never clobber that owner.
 */
export function replaceSpecOccupancy(
  intentId: string,
  expectedPending: string,
  realId: string,
): void {
  if (currentSpecSessionId(intentId) !== expectedPending) return
  setSpecSessionId(intentId, realId)
}

/** Same conditional replace for the spec-REVIEW slot. */
export function replaceSpecReviewOccupancy(
  intentId: string,
  expectedPending: string,
  realId: string,
): void {
  if (currentSpecReviewSessionId(intentId) !== expectedPending) return
  setSpecReviewSessionId(intentId, realId)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
