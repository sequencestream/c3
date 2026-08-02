import type { Intent, SpecLaunchStage } from '@ccc/shared/protocol'
import { getDefaultMainBranch, getGitBranchMode } from '../../kernel/config/index.js'
import { listIntents } from './store.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'
import { pullCurrentBranch } from './worktree.js'

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

/**
 * The outcome of the spec-launch gate, stated as a DOMAIN fact only: either the
 * launch may proceed, or one dependency is not on the mainline yet. It carries
 * no error code, no frame and no launch result — every entry point mints its own
 * `intent.dependencyNotMerged` shape, so transport never leaks back in here.
 */
export type SpecLaunchGateResult =
  { blocked: false } | { blocked: true; dependency: Pick<Intent, 'id' | 'title'> }

/**
 * The ONE spec-launch precondition: the worktree-mode dependency gate followed by
 * a best-effort pull of the current branch. Shared verbatim by the manual entry
 * (`reset_spec_session`) and by every branch of {@link launchSpecSession} (which
 * the `write_spec` handler, the automation MCP tool and the queue all reach), so
 * an unattended launch can never admit an intent the manual one would refuse.
 *
 * Order is part of the contract:
 *   1. Only in `worktree` mode, look for a dependency that is not on the mainline.
 *   2. Blocked → kick off a fire-and-forget PR-status refresh (a stale `reviewing`
 *      row is the most common false block) and return. Nothing is pulled and no
 *      progress is reported: the caller is about to refuse.
 *   3. Otherwise report `pulling-code`, pull, then report `launching`. A failed
 *      pull is a warning, not a refusal — the session still starts.
 */
export function prepareSpecLaunch(input: {
  workspacePath: string
  intent: Intent
  broadcastIntents: (workspacePath: string) => void
  progress?: (stage: SpecLaunchStage) => void
}): SpecLaunchGateResult {
  const { workspacePath, intent } = input
  if (getGitBranchMode(workspacePath) === 'worktree') {
    const blocking = findDependencyBlockingMainline(
      intent.dependsOn,
      listIntents(workspacePath),
      getDefaultMainBranch(workspacePath),
    )
    if (blocking) {
      syncUnconfirmedDependencyPrsInBackground({
        ctx: { broadcastIntents: input.broadcastIntents },
        workspacePath,
        dependsOn: intent.dependsOn,
      })
      return { blocked: true, dependency: { id: blocking.id, title: blocking.title } }
    }
  }
  input.progress?.('pulling-code')
  const pull = pullCurrentBranch(workspacePath)
  if (!pull.ok) {
    console.warn(`[c3:intents] spec session pull failed; continuing: ${pull.message ?? 'unknown'}`)
  }
  input.progress?.('launching')
  return { blocked: false }
}
