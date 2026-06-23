import type { Intent } from '@ccc/shared/protocol'

/** Normalise local and remote git branch references before comparison. */
export function normalizeBranchName(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  if (!trimmed) return null
  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '')
}

/**
 * Return the first dependency that is not available on the workspace mainline.
 * Missing dependency records are historical/invalid references and deliberately
 * remain non-blocking, matching the existing development-start behaviour.
 */
export function findDependencyBlockingMainline(
  dependsOn: string[],
  intents: Intent[],
  defaultMainBranch: string | null | undefined,
): Intent | undefined {
  const byId = new Map(intents.map((intent) => [intent.id, intent]))
  const mainBranch = normalizeBranchName(defaultMainBranch)
  return dependsOn
    .map((id) => byId.get(id))
    .find((dep): dep is Intent => {
      if (!dep) return false
      if (dep.status !== 'done') return true
      if (dep.prStatus === 'merged') return false
      const branch = normalizeBranchName(dep.branchName)
      if (branch === null) return false
      return mainBranch === null || branch !== mainBranch
    })
}
