import type { GitBranchMode, Intent, SpecLaunchStage } from '@ccc/shared/protocol'
import { deriveIntentPrAggregate } from '@ccc/shared'
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
      // The dependency's AGGREGATE PR status — `merged` only when nothing it owns
      // is still unsettled, so a second, still-open PR keeps the gate closed.
      if (deriveIntentPrAggregate(dep.prs) === 'merged') return false
      const branch = normalizeBranchName(dep.branchName)
      if (branch === null) return false
      return mainBranch === null || branch !== mainBranch
    })
}

/**
 * The first dependency that still trips the HARD dependency gate for an intent,
 * or `undefined` when none does. One rule, two readers: the launch gate that
 * refuses to start work, and the read-model projection that explains the refusal
 * to the user — so an explanation can never disagree with the refusal.
 *
 * - A dependency that is not `done` blocks in EVERY branch mode.
 * - In `worktree` mode a `done` dependency that is not on the mainline yet blocks
 *   as well (see {@link findDependencyBlockingMainline}).
 *
 * Declaration order in `dependsOn` decides which one is reported. Unresolvable
 * ids (cross-workspace / deleted) stay non-blocking, exactly as every other
 * entry point already treats them.
 */
export function findBlockingDependency(input: {
  dependsOn: string[]
  intents: Intent[]
  gitBranchMode: GitBranchMode
  defaultMainBranch: string | null | undefined
}): Intent | undefined {
  if (input.gitBranchMode === 'worktree') {
    return findDependencyBlockingMainline(input.dependsOn, input.intents, input.defaultMainBranch)
  }
  const byId = new Map(input.intents.map((intent) => [intent.id, intent]))
  return input.dependsOn
    .map((id) => byId.get(id))
    .find((dep): dep is Intent => !!dep && dep.status !== 'done')
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
