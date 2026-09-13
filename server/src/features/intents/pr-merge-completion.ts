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
 * Callers invoke this right after a PR row is written to `merged` — or after a
 * review conclusion is written — before their own broadcast, and fan the intent
 * list themselves when it returns `true`.
 */
import { deriveIntentPrAggregate, intentHasConverged } from '@ccc/shared'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { getIntent, updateStatus } from './store.js'

/**
 * Converge one intent to `done` once its whole loop has settled. Returns `true`
 * only when the status actually moved (so the caller knows a broadcast is owed);
 * every other case — unknown intent, not `in_progress`/`reviewing`, no PR, a PR
 * still open or unmerged, a `reviewing` intent whose review is not yet settled —
 * leaves the ledger untouched.
 */
export function completeIntentOnPrsMerged(workspacePath: string, intentId: string): boolean {
  const intent = getIntent(intentId)
  if (!intent) return false
  if (intent.status !== 'in_progress' && intent.status !== 'reviewing') return false
  if (deriveIntentPrAggregate(intent.prs) !== 'merged') return false

  const prior = intent.status
  const converged = intentHasConverged({
    status: intent.status,
    reviewStatus: intent.reviewStatus,
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
