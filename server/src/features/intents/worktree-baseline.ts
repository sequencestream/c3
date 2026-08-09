/**
 * What a work session's worktree is ROOTED at, and what to do when an existing
 * worktree is rooted somewhere else.
 *
 * The answer is the intent's persisted `baseBranch` snapshot — the same value
 * the PR target reads, so a worktree is rooted at exactly the branch its PR will
 * later be filed against. A delivery is the branch its intents integrate into,
 * and the snapshot already follows that at the association lifecycle edges, so
 * nothing is re-derived from the live delivery here: the delivery context only
 * labels the baseline for the messages the user sees.
 *
 * The hard line is what happens to a worktree that ALREADY exists on the wrong
 * baseline: nothing, automatically. It is never rebuilt (that discards
 * uncommitted work) and never merged into (that rewrites the user's branch
 * behind their back). The launch is blocked, and the two ways out are explicit
 * user actions. This block has NO force-release: the dependency gate is advice,
 * this one is data safety.
 */
import type { Delivery, Intent } from '@ccc/shared/protocol'
import {
  fetchRemoteBase,
  getWorktreePath,
  isWorktreeClean,
  readWorktreeHead,
  worktreeContainsRef,
  worktreeExists,
  type WorktreeHeadState,
} from './worktree.js'

/** The baseline one launch resolves for its worktree. */
export interface WorktreeBaseline {
  /** The branch a new worktree roots at — the intent's persisted base snapshot. */
  baseBranch: string
  /**
   * The just-fetched remote ref for {@link baseBranch} (`origin/<branch>`), or
   * `null` when there is no remote / the fetch failed. Only a remote ref is worth
   * checking an existing worktree against — a stale local branch proves nothing.
   */
  remoteRef: string | null
  /** The delivery this baseline came from; `null` when the session has no context. */
  delivery: { id: string; title: string } | null
  /**
   * True when a delivery context exists but the baseline is NOT its branch —
   * because the branch is not initialised yet, or the intent's snapshot was taken
   * against something else. That "something else" is not necessarily the mainline:
   * an intent linked to several deliveries keeps the snapshot of the first one, so
   * this is true for another delivery's branch too. Surfaced to the caller as a
   * notice; the launch still proceeds. An intent linked to a delivery whose branch
   * has not been created must still be able to start work.
   */
  offDeliveryBranch: boolean
}

/**
 * Resolve the baseline for one launch and fetch it, so both the new-worktree root
 * and the existing-worktree check work against the same, just-fetched commit.
 *
 * The branch itself is read, never derived: `intent.baseBranch` already carries
 * the delivery branch when the association lifecycle put it there. `delivery` is
 * consulted only to label the baseline and to tell the user when it is not the
 * delivery's own branch.
 */
export function resolveWorktreeBaseline(
  workspacePath: string,
  intent: Intent,
  delivery: Delivery | null,
): WorktreeBaseline {
  const baseBranch = intent.baseBranch
  const deliveryBranch =
    delivery && delivery.branchReady ? (delivery.branchName?.trim() ?? null) : null
  return {
    baseBranch,
    remoteRef: fetchRemoteBase(workspacePath, baseBranch),
    delivery: delivery ? { id: delivery.id, title: delivery.title } : null,
    offDeliveryBranch: delivery !== null && deliveryBranch !== baseBranch,
  }
}

/** Why an existing worktree may not be used as it stands. */
export type WorktreeBaselineBlock = {
  /** The baseline branch the worktree does not contain. */
  branch: string
  /** The delivery that baseline came from; `null` for a mainline baseline. */
  delivery: { id: string; title: string } | null
  /** Whether a safe rebuild is currently possible (no uncommitted work). */
  canRebuild: boolean
  /**
   * Where the worktree actually sits. Carried so the refusal can say WHY the two
   * disagree: a directory still on the mainline was created off the wrong base,
   * while one on its own intent branch simply fell behind a delivery branch that
   * moved. Diagnostic only — it changes neither the verdict nor the exits.
   */
  current: WorktreeHeadState
}

/**
 * Check an EXISTING worktree against the baseline. Returns `null` when the
 * launch may proceed — which includes every case the check cannot decide:
 *
 * - no worktree yet (it will be created at the baseline),
 * - no remote ref (offline, no remote, or a delivery branch never pushed),
 * - the ancestry test could not be run.
 *
 * A check that cannot be made is not a violation. Blocking on one would strand
 * users behind a repair dialog for a branch that does not exist.
 */
export function checkExistingWorktreeBaseline(
  workspacePath: string,
  intentId: string,
  baseline: WorktreeBaseline,
): WorktreeBaselineBlock | null {
  if (!baseline.remoteRef) return null
  const worktreePath = getWorktreePath(workspacePath, intentId)
  if (!worktreeExists(worktreePath)) return null
  if (worktreeContainsRef(worktreePath, baseline.remoteRef) !== false) return null
  return {
    branch: baseline.baseBranch,
    delivery: baseline.delivery,
    canRebuild: isWorktreeClean(worktreePath),
    current: readWorktreeHead(worktreePath),
  }
}
