/**
 * The ONE way to answer "which branch does this workspace build on" for an
 * intent's persisted base branch.
 *
 * It exists because the answer used to be re-derived at every read point, and
 * the derivations had already drifted: one landed a literal `'main'` when the
 * workspace setting was absent, the other landed `null` and let the worktree
 * anchor at whatever HEAD happened to be. A snapshot that is written once and
 * read everywhere only works if the writing side has a single resolver.
 *
 * Resolution order — configured setting first, repository fact second,
 * convention last:
 *  1. the workspace's `defaultMainBranch` (an explicit human decision);
 *  2. {@link detectDefaultBranch} (`origin/HEAD`, else the checked-out branch);
 *  3. `main`, unless only `master` exists in the repo.
 *
 * Step 3 is reached only by a path git cannot speak for (a non-repo directory,
 * or a detached HEAD with no remote). It never returns empty: a base branch that
 * is absent is exactly the un-auditable state this snapshot removes.
 */
import { getDefaultMainBranch } from '../../kernel/config/index.js'
import { branchExists, detectDefaultBranch } from './worktree.js'

/** The conventional mainline name, used when nothing about the repo is knowable. */
const CONVENTIONAL_MAIN = 'main'
/** The other conventional name — chosen only when it exists and `main` does not. */
const CONVENTIONAL_LEGACY_MAIN = 'master'

function clean(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

/**
 * The workspace's base branch for a NEW intent (and the value an intent falls
 * back to when it loses its last delivery link). Touches git only when the
 * workspace has no configured mainline.
 */
export function resolveWorkspaceBaseBranch(workspacePath: string): string {
  const configured = clean(getDefaultMainBranch(workspacePath))
  if (configured) return configured
  const detected = clean(detectDefaultBranch(workspacePath))
  if (detected) return detected
  if (
    !branchExists(workspacePath, CONVENTIONAL_MAIN) &&
    branchExists(workspacePath, CONVENTIONAL_LEGACY_MAIN)
  ) {
    return CONVENTIONAL_LEGACY_MAIN
  }
  return CONVENTIONAL_MAIN
}
