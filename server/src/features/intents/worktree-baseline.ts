/**
 * What a work session's worktree is ROOTED at, and what to do when an existing
 * worktree is rooted somewhere else.
 *
 * Before deliveries the answer was always the workspace mainline. With a
 * delivery context it is `origin/<delivery branch>`: a delivery is the branch
 * its intents integrate into, so developing off mainline would produce a diff
 * that carries the whole mainline-vs-delivery difference.
 *
 * The hard line is what happens to a worktree that ALREADY exists on the wrong
 * baseline: nothing, automatically. It is never rebuilt (that discards
 * uncommitted work) and never merged into (that rewrites the user's branch
 * behind their back). The launch is blocked, and the two ways out are explicit
 * user actions. This block has NO force-release: the dependency gate is advice,
 * this one is data safety.
 */
import type { Delivery } from '@ccc/shared/protocol'
import { getDefaultMainBranch } from '../../kernel/config/index.js'
import {
  fetchRemoteBase,
  getWorktreePath,
  isWorktreeClean,
  worktreeContainsRef,
  worktreeExists,
} from './worktree.js'

/** The baseline one launch resolves for its worktree. */
export interface WorktreeBaseline {
  /** The branch a new worktree roots at; `null` when the workspace has none configured. */
  baseBranch: string | null
  /**
   * The just-fetched remote ref for {@link baseBranch} (`origin/<branch>`), or
   * `null` when there is no remote / the fetch failed. Only a remote ref is worth
   * checking an existing worktree against — a stale local branch proves nothing.
   */
  remoteRef: string | null
  /** The delivery this baseline came from; `null` when the session has no context. */
  delivery: { id: string; title: string } | null
  /**
   * True when a delivery context existed but its branch was not usable yet, so
   * the baseline fell back to the workspace mainline. Surfaced to the caller as a
   * notice — the launch still proceeds.
   */
  fellBackToMainline: boolean
}

/**
 * Resolve the baseline for one launch and fetch it, so both the new-worktree root
 * and the existing-worktree check work against the same, just-fetched commit.
 *
 * A delivery whose branch is not ready has nothing to root on, so the baseline
 * falls back to the mainline and says so. That is not a refusal: an intent linked
 * to a delivery whose branch has not been initialised yet must still be able to
 * start work.
 */
export function resolveWorktreeBaseline(
  workspacePath: string,
  delivery: Delivery | null,
): WorktreeBaseline {
  const mainline = getDefaultMainBranch(workspacePath)?.trim() || null
  const deliveryRef = delivery ? { id: delivery.id, title: delivery.title } : null
  const deliveryBranch =
    delivery && delivery.branchReady ? (delivery.branchName?.trim() ?? null) : null
  const fellBackToMainline = delivery !== null && deliveryBranch === null
  const baseBranch = deliveryBranch ?? mainline
  return {
    baseBranch,
    remoteRef: baseBranch ? fetchRemoteBase(workspacePath, baseBranch) : null,
    delivery: deliveryRef,
    fellBackToMainline,
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
  if (!baseline.remoteRef || !baseline.baseBranch) return null
  const worktreePath = getWorktreePath(workspacePath, intentId)
  if (!worktreeExists(worktreePath)) return null
  if (worktreeContainsRef(worktreePath, baseline.remoteRef) !== false) return null
  return {
    branch: baseline.baseBranch,
    delivery: baseline.delivery,
    canRebuild: isWorktreeClean(worktreePath),
  }
}
