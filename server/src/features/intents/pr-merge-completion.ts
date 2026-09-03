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
 * Only `in_progress` auto-completes. `todo` never had a run to finish, and
 * `blocked` / `failed` are states a human has to resolve first (the transition
 * graph refuses those edges anyway); `done` is already there.
 *
 * Callers invoke this right after a PR row is written to `merged`, before their
 * own broadcast, and fan the intent list themselves when it returns `true`.
 */
import { deriveIntentPrAggregate } from '@ccc/shared'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { getIntent, updateStatus } from './store.js'

/**
 * Auto-complete one intent when its PRs have all landed. Returns `true` only
 * when the status actually moved (so the caller knows a broadcast is owed);
 * every other case — unknown intent, not `in_progress`, no PR, a PR still open
 * or unmerged — leaves the ledger untouched.
 */
export function completeIntentOnPrsMerged(workspacePath: string, intentId: string): boolean {
  const intent = getIntent(intentId)
  if (!intent || intent.status !== 'in_progress') return false
  if (deriveIntentPrAggregate(intent.prs) !== 'merged') return false

  // Forge-observed merge, not a user action ⇒ the log actor stays `automation`.
  updateStatus(intent.id, 'done')
  publishIntentStatusTransition(workspacePath, intent, 'in_progress', 'done')
  return true
}
