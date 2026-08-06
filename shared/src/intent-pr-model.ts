/**
 * Reductions over an intent's PR list, shared verbatim by the server (dependency
 * gates, queue facts, tool output) and the web console (progress bar, list row,
 * detail, title bar).
 *
 * They live here rather than in the wire contract because they are RULES, not
 * shapes — `protocol/` stays a pure wire contract. One copy is the whole point:
 * an intent now owns a LIST of PRs, so every reader needs the same answer to
 * "what is this intent's PR status" and "which PR does the button open". Two
 * private reductions would drift the moment a second delivery target lands.
 */
import type { IntentPr, IntentPrStatus } from './protocol.js'

/** PR statuses that mean the PR is finished — nothing further will happen to it. */
const TERMINAL_PR_STATUSES: readonly IntentPrStatus[] = ['merged', 'closed']

/** The PRs that are still live (not `merged`, not `closed`), input order preserved. */
export function activeIntentPrs(prs: readonly IntentPr[]): IntentPr[] {
  return prs.filter((pr) => !TERMINAL_PR_STATUSES.includes(pr.status))
}

/**
 * Reduce an intent's PRs to the ONE status that stands for the intent as a whole.
 *
 * The ladder, most-undecided first — an unsettled PR outranks any terminal one
 * (there is still something to wait for), and a merge outranks a plain close
 * (something actually landed):
 *
 * | condition                | aggregate   |
 * | ------------------------ | ----------- |
 * | no PR rows               | `null`      |
 * | any `reviewing`          | `reviewing` |
 * | else any `failed`        | `failed`    |
 * | else any `rejected`      | `rejected`  |
 * | else any `merged`        | `merged`    |
 * | else (all `closed`)      | `closed`    |
 */
export function deriveIntentPrAggregate(prs: readonly IntentPr[]): IntentPrStatus | null {
  if (prs.length === 0) return null
  const has = (s: IntentPrStatus): boolean => prs.some((pr) => pr.status === s)
  if (has('reviewing')) return 'reviewing'
  if (has('failed')) return 'failed'
  if (has('rejected')) return 'rejected'
  if (has('merged')) return 'merged'
  return 'closed'
}

/**
 * The ONE PR a single-PR affordance (open link / copy number) should act on: the
 * first still-active PR, or — when every PR is finished — the oldest one, so the
 * button keeps pointing at a stable row instead of jumping between terminals.
 * `null` when the intent owns no PR. Ties on `createdAt` break by `number` so the
 * choice is deterministic across processes.
 */
export function pickPrimaryIntentPr(prs: readonly IntentPr[]): IntentPr | null {
  if (prs.length === 0) return null
  const byAge = [...prs].sort(
    (a, b) => a.createdAt - b.createdAt || a.number.localeCompare(b.number),
  )
  return activeIntentPrs(byAge)[0] ?? byAge[0]
}
