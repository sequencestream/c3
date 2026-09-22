/**
 * The ONE criterion for "may a human start this intent's PR review / fix phase
 * right now", as a pure function.
 *
 * The queue and a human ask the same question — is the relay due for a review,
 * or for a fix — but they do NOT ask it under the same conditions. The queue's
 * `relayEngaged` (kernel) additionally requires `automate`, `status ===
 * 'reviewing'`, `needsReview(impactLevel)`, a cooldown and a concurrency slot,
 * because those gate UNATTENDED dispatch: nobody chose to spend the token, so
 * the scheduler must be conservative about when it may. A human clicking a
 * button HAS chosen; the impact grade is a token-saving policy, the cooldown and
 * the slot cap bound the queue's own fan-out, and neither `automate` nor the
 * intent's `status` says anything about whether a review would be meaningful.
 *
 * What survives that reduction is the PHASE derivation — which half of the relay
 * the ledger's own facts call for next — and that reduction is exactly what this
 * function is. Both readers use it and only it: the web title bar (deciding
 * whether to render 「启动评审」/「启动修复」) and the `start_intent_relay`
 * handler (the backstop against direct WS calls and stale tabs). Sharing it is
 * what makes "the button was there" and "the server accepted it" the same
 * statement — a button that can be clicked and then refused is the failure this
 * single source exists to prevent.
 *
 * In-flight is an INPUT, never re-derived here. The server computes it from the
 * live run registry plus the pending projection's age (the same rule the queue
 * kernel consumes); the web reads the send-time projection field. A `pending`
 * status alone must never be read as "a session is running" — a dead launch
 * leaves exactly that value behind, and treating it as occupied would hide the
 * button forever with no way to recover the round.
 *
 * Data in, verdict out: no I/O, no clock, no store access.
 */
import {
  MAX_REVIEW_FIX_ROUNDS,
  type GitBranchMode,
  type IntentFixStatus,
  type IntentReviewStatus,
} from './protocol.js'

/** An intent reduced to the facts the criterion reads — nothing else is consulted. */
export interface IntentRelayManualTriggerFacts {
  /**
   * The workspace's branch mode. A review reads, and a fix edits and pushes, the
   * PR's head branch, which only exists as a checked-out directory under an
   * intent-level worktree; under `current-branch` there is no such directory, so
   * no phase is ever startable.
   */
  gitBranchMode: GitBranchMode
  /** Whether the intent still holds at least one live (`activeIntentPrs`) PR. */
  hasActivePr: boolean
  reviewStatus: IntentReviewStatus | null
  fixStatus: IntentFixStatus | null
  /** Closed-loop rounds already claimed; compared against the shared cap. */
  reviewFixRounds: number
  /** The review phase's session is still occupied (see the module note). */
  reviewInFlight: boolean
  /** The fix phase's session is still occupied. */
  fixInFlight: boolean
}

/** Why no phase can be started; `null` when at least one can. */
export type IntentRelayManualBlockedReason =
  /** A phase's session is still occupied — both buttons are withheld. */
  | 'inFlight'
  /** Nothing is running, but the ledger's own facts call for no next phase. */
  | 'notApplicable'

export interface IntentRelayManualTrigger {
  canStartReview: boolean
  canStartFix: boolean
  blockedReason: IntentRelayManualBlockedReason | null
}

const NONE: IntentRelayManualTrigger = {
  canStartReview: false,
  canStartFix: false,
  blockedReason: 'notApplicable',
}

/**
 * Resolve which phase, if either, a human may start for this intent.
 *
 * The ordering is the whole rule: "something is already running" is answered
 * before anything is offered, so a live review can never be joined by a fix (the
 * two would edit and read the same worktree at once), and the branch mode / PR
 * gate comes first of all because no other fact makes a phase runnable.
 *
 * The phase table is the queue's own derivation with the unattended-dispatch
 * gates removed, so the two paths can never disagree about what the ledger calls
 * for next:
 *
 * | ledger                                        | in flight | startable      |
 * |-----------------------------------------------|-----------|----------------|
 * | `reviewStatus === null`                        | none      | review (incl. L5) |
 * | `reviewStatus === 'pending'`                   | review free | review (resume) |
 * | `rejected` + `fixStatus === 'fixed'`           | none      | review (re-review) |
 * | `rejected` + `fixStatus === null`, under cap   | none      | fix (next round) |
 * | `rejected` + `fixStatus === 'pending'`         | fix free  | fix (resume)   |
 * | `approved`                                     | —         | none           |
 * | at the round cap, still `rejected`             | —         | none (no park) |
 *
 * Reaching the cap deliberately writes NOTHING here: the queue parks an intent
 * it can no longer drive by itself, but a human's own loop stopping at the cap
 * is not a queue state, and the manual path must never move queue scheduling
 * metadata. The intent simply offers no further fix.
 */
export function resolveIntentRelayManualTrigger(
  facts: IntentRelayManualTriggerFacts,
): IntentRelayManualTrigger {
  if (facts.gitBranchMode !== 'worktree' || !facts.hasActivePr) return NONE
  if (facts.reviewInFlight || facts.fixInFlight) {
    return { canStartReview: false, canStartFix: false, blockedReason: 'inFlight' }
  }

  const { reviewStatus, fixStatus } = facts
  if (reviewStatus === null || reviewStatus === 'pending') {
    return { canStartReview: true, canStartFix: false, blockedReason: null }
  }
  if (reviewStatus === 'approved') return NONE

  // `rejected` — the only state a fix round derives from.
  if (fixStatus === 'fixed') {
    return { canStartReview: true, canStartFix: false, blockedReason: null }
  }
  if (fixStatus === 'pending') {
    return { canStartReview: false, canStartFix: true, blockedReason: null }
  }
  const underCap = facts.reviewFixRounds < MAX_REVIEW_FIX_ROUNDS
  return {
    canStartReview: false,
    canStartFix: underCap,
    blockedReason: underCap ? null : 'notApplicable',
  }
}
