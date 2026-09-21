/**
 * Derive an intent's completion from its PR ledger: work whose PRs have all
 * landed is finished work, and leaving such an intent at `in_progress` makes the
 * board lie about what is still being built.
 *
 * The gate is the intent's AGGREGATE PR status (`deriveIntentPrAggregate`), so a
 * single evaluation covers every shape the ledger can take: one PR or several,
 * with or without delivery bindings. `merged` means no row is still `reviewing`,
 * `failed` or `rejected` and at least one landed — a row the user abandoned
 * (`closed`) does not hold the intent open, because that PR's life is over.
 *
 * This is now the CONVERGENCE check, not just "all PRs merged". An `in_progress`
 * intent auto-completes on merge alone (the historic rule, still valid for a
 * manually driven intent). A `reviewing` intent — the automatic path's "work is
 * done, PR filed, loop not settled" state — completes only when its PRs have all
 * merged AND its review is settled (`approved`, or L5-exempt via `needsReview`).
 * The two facts can arrive in either order; the last one wins. `todo` never had
 * a run to finish, and `blocked` / `failed` are states a human has to resolve
 * first (the transition graph refuses those edges anyway); `done` is already
 * there.
 *
 * The merge also SETTLES the review. A PR that landed is work that was accepted,
 * whether or not a review session ever said so: when the merge is observed while
 * `reviewStatus` still says otherwise — `null` because the review never ran, or
 * because it ran outside c3; `pending`; even `rejected`, if a human merged over
 * it — this pass writes `approved` before evaluating convergence, so a `reviewing`
 * intent whose only missing fact was the conclusion converges to `done` in ONE
 * call instead of waiting for a review session that the merge has made moot.
 * `intentHasConverged` itself is untouched: this is the merge arriving first and
 * supplying the fact, the mirror image of a review arriving first.
 *
 * Callers invoke this right after a PR row is written to `merged` — or after a
 * review conclusion is written — before their own broadcast, and fan the intent
 * list themselves when it returns `true`.
 */
import type { Intent, IntentReviewStatus } from '@ccc/shared/protocol'
import { deriveIntentPrAggregate, intentHasConverged } from '@ccc/shared'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import {
  getIntent,
  safeInsertIntentLog,
  updateIntentReviewFixStatus,
  updateStatus,
} from './store.js'

/**
 * Converge one intent to `done` once its whole loop has settled. Returns `true`
 * only when the status actually moved (so the caller knows a broadcast is owed);
 * every other case — unknown intent, not `in_progress`/`reviewing`, no PR, or a PR
 * still open or unmerged — leaves the ledger untouched.
 */
export function completeIntentOnPrsMerged(workspacePath: string, intentId: string): boolean {
  const intent = getIntent(intentId)
  if (!intent) return false
  if (intent.status !== 'in_progress' && intent.status !== 'reviewing') return false
  if (deriveIntentPrAggregate(intent.prs) !== 'merged') return false

  // Settle the review FIRST: the convergence check below must read what this pass
  // just established, not the stale conclusion a review session is free to ignore.
  const prior = intent.status
  const reviewStatus = settleReviewOnMerge(intent)
  const converged = intentHasConverged({
    status: intent.status,
    reviewStatus,
    impactLevel: intent.impactLevel,
    prAggregate: 'merged',
    branchMode: getGitBranchMode(workspacePath),
  })
  if (!converged) return false

  // Forge-observed merge, not a user action ⇒ the log actor stays `automation`.
  updateStatus(intent.id, 'done')
  publishIntentStatusTransition(workspacePath, intent, prior, 'done')
  return true
}

/**
 * The review conclusion a merged PR set implies, written to the ledger when it
 * disagrees — and returned either way so the caller can feed the convergence
 * check the value that now holds.
 *
 * Idempotent by construction: an intent already at `approved` is neither written
 * again nor logged again, so the several paths that observe the same merge (the
 * sync pass, the queue's post-merge re-check, a delivery unlink) cannot pile up
 * duplicate `approved` rows — and the log stays a record of DECISIONS, not of how
 * many times someone looked.
 *
 * Only the review conclusion is touched: `reviewSessionId`, the round counter and
 * every fix field keep whatever the review / fix relay wrote. The log operation is
 * `intent_updated` — the closed `IntentLogOperation` set has no review-terminal
 * member, and this row's subject is a field of the intent, not a PR event
 * (`pr_merged` already records the PR's own landing, one row per PR).
 */
function settleReviewOnMerge(intent: Intent): IntentReviewStatus | null {
  if (intent.reviewStatus === 'approved') return 'approved'
  updateIntentReviewFixStatus(intent.id, { reviewStatus: 'approved' })
  // Forge-observed merge, not a user action ⇒ the log actor stays `automation`.
  safeInsertIntentLog(
    intent.id,
    'intent_updated',
    'PR 已全部合并，评审结论按合并结果落为 approved',
    'automation',
  )
  return 'approved'
}
