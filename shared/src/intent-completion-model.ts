/**
 * The ONE criterion for "has this intent's whole loop converged to `done`", as a
 * pure function shared by the server (the `reviewing → done` convergence check)
 * and the client (progress / board projection), so the two can never drift into
 * two different definitions of "finished".
 *
 * Two shapes converge here:
 *
 * - `reviewing` — the automatic path wrote it after work finished and a PR was
 *   filed. It is `done` only when its PRs have all merged AND its review is
 *   settled: exempt (L5) or `approved`. The two events may land in either order;
 *   the last one to arrive completes the convergence.
 * - `in_progress` — the pre-`reviewing` automatic path (and any manually driven
 *   intent) auto-completed on merge alone, with no review gate. This arm is kept
 *   so a PR merged through the human path still closes an `in_progress` intent
 *   the way it always did; `reviewing` is what adds the review requirement.
 *
 * Data in, verdict out: no I/O, no clock, no store access. `prAggregate` and
 * `impactLevel` are supplied rather than derived so the caller (which already
 * holds them) is the only reader of the ledger / model it needs.
 */
import type {
  GitBranchMode,
  IntentImpactLevel,
  IntentPrStatus,
  IntentReviewStatus,
  IntentStatus,
} from './protocol.js'
import { needsReview } from './intent-impact-level-model.js'

/** An intent reduced to the facts the convergence criterion reads. */
export interface IntentCompletionFacts {
  status: IntentStatus
  reviewStatus: IntentReviewStatus | null
  impactLevel: IntentImpactLevel | null
  prAggregate: IntentPrStatus | null
  branchMode: GitBranchMode
}

/**
 * `true` when the intent may be (or already is) written `done`.
 *
 * - `done` — already there (the check is idempotent).
 * - `reviewing` — PR aggregate `merged` AND (review exempt or `approved`).
 * - `in_progress` (worktree) — PR aggregate `merged` alone, the historic rule.
 * - anything else — never converges here.
 */
export function intentHasConverged(facts: IntentCompletionFacts): boolean {
  if (facts.status === 'done') return true
  if (facts.status === 'reviewing') {
    if (facts.prAggregate !== 'merged') return false
    return needsReview(facts.impactLevel) ? facts.reviewStatus === 'approved' : true
  }
  if (facts.status === 'in_progress') {
    return facts.branchMode === 'worktree' && facts.prAggregate === 'merged'
  }
  return false
}
