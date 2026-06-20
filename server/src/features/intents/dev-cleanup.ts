/**
 * Manual Start-Dev session-end Git/PR cleanup (MSC-R1…R6).
 *
 * When a MANUAL `start_development` dev session settles (complete / error /
 * aborted), the resident `run:settled` subscription routes here (automation-owned
 * sessions are filtered out upstream — see `isIntentDrivenByAutomation`). This
 * module commits, pushes, and opens a PR for the intent's work, writing back the
 * Git/PR tracking fields. It deliberately does NOT touch the intent status machine
 * (no auto `done`) — only the Git/PR fields.
 *
 * Branch-mode dispatch (mirrors `startDevelopment`'s effectiveCwd choice):
 *  - `worktree`: always run the cleanup against the isolated worktree.
 *  - `current-branch`: run only when the current branch differs from the
 *    workspace's configured main branch; on the main branch this is a NORMAL
 *    success skip (no commit / push / PR, no failure todo).
 *
 * Failure is explicit (MSC-R4): no committable changes, a commit/push failure,
 * `gh` unavailable / not logged in, or a PR-create failure all return a `failed`
 * outcome AND push a `source='intent'` wait-user-involve todo carrying a UiError
 * so the workbench surfaces a localized "needs your attention" message. We NEVER
 * fake success: on failure no `reviewing` status and no placeholder PR fields are
 * written; already-completed steps (commit+push ⇒ `latestCommitHash`) are honestly
 * recorded.
 *
 * Idempotent re-cleanup (MSC-R6): if the intent already has a PR, we commit+push
 * and refresh `latestCommitHash` but do NOT create a second PR; the existing PR
 * fields are preserved.
 *
 * Dependency-injected (mirrors `save-gate.ts`) so the whole flow is unit-testable
 * without a live git tree, the wire, or the db.
 */
import type { GitBranchMode, Intent, IntentPrStatus } from '@ccc/shared/protocol'
import type { UiErrorCode } from '@ccc/shared/ui-codes'
import type { CommitResult, CreatePrResult } from '../../git.js'

/** Why a cleanup failed — each maps to a workbench todo UiError code. */
export type CleanupFailureCode = 'noChanges' | 'commitPushFailed' | 'ghUnavailable' | 'prFailed'

export type CleanupOutcome =
  | { kind: 'success'; createdPr: boolean }
  /** current-branch mode on the configured main branch — a normal success skip. */
  | { kind: 'skipped' }
  | { kind: 'failed'; code: CleanupFailureCode; detail?: string }

/** Everything the cleanup needs, injected so it is testable in isolation. */
export interface DevCleanupDeps {
  getGitBranchMode: (workspacePath: string) => GitBranchMode
  getDefaultMainBranch: (workspacePath: string) => string | undefined
  /** The intent's git working dir: the worktree (worktree mode) or the checkout. */
  gitCwd: (workspacePath: string, intentId: string) => string
  hasCommittableChanges: (cwd: string) => Promise<boolean>
  getCurrentBranch: (cwd: string) => Promise<string | null>
  getHeadCommit: (cwd: string) => Promise<string | null>
  commitAndPush: (cwd: string, message: string) => Promise<CommitResult>
  createGhPr: (
    cwd: string,
    title: string,
    body: string,
    headBranch?: string,
  ) => Promise<CreatePrResult>
  getIntent: (id: string) => Intent | null
  setBranchName: (id: string, branchName: string) => void
  setLatestCommitHash: (id: string, commitHash: string) => void
  setPrInfo: (id: string, prId: string, prStatus: IntentPrStatus, prUrl: string | null) => void
  /** Cancel prior cleanup todos for this intent (self-healing on re-run). */
  cancelEventsForIntent: (intentId: string) => void
  /** Push a workbench todo carrying a UiError describing the failure. */
  pushFailureEvent: (input: {
    workspacePath: string
    intentId: string
    code: UiErrorCode
    params?: Record<string, string | number>
  }) => void
  broadcastIntents: (workspacePath: string) => void
  broadcastWaitUserEvents: (workspacePath: string) => void
}

/** Normalize a branch ref so `origin/main` / `refs/heads/main` / `main` compare equal. */
function normBranch(b: string | null | undefined): string | null {
  const s = b?.trim()
  if (!s) return null
  return s
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '')
}

/** Build the PR title + body from the intent (mirrors the manual create_pr path). */
function buildPr(
  req: Intent,
  getIntent: (id: string) => Intent | null,
): {
  title: string
  body: string
} {
  const bodyParts: string[] = [req.content]
  if (req.dependsOn.length > 0) {
    bodyParts.push('', '## 依赖需求')
    for (const depId of req.dependsOn) {
      const dep = getIntent(depId)
      bodyParts.push(`- ${dep?.title ?? depId} (${dep?.status ?? 'unknown'})`)
    }
  }
  return { title: `feat: ${req.title}`, body: bodyParts.join('\n') }
}

const FAILURE_CODE: Record<CleanupFailureCode, UiErrorCode> = {
  noChanges: 'intent.gitCleanupNoChanges',
  commitPushFailed: 'intent.gitCleanupCommitPushFailed',
  ghUnavailable: 'intent.gitCleanupGhUnavailable',
  prFailed: 'intent.gitCleanupPrFailed',
}

/**
 * Run the session-end Git/PR cleanup for a manual dev session's intent.
 * Returns the outcome; also performs all writes / broadcasts / failure-todo pushes
 * as side effects via the injected deps. Never throws — callers fire-and-forget.
 */
export async function runManualDevCleanup(
  intentId: string,
  workspacePath: string,
  deps: DevCleanupDeps,
): Promise<CleanupOutcome> {
  const req = deps.getIntent(intentId)
  if (!req) return { kind: 'skipped' }

  const mode = deps.getGitBranchMode(workspacePath)
  const cwd = deps.gitCwd(workspacePath, intentId)

  // current-branch on the configured main branch ⇒ normal success skip (MSC-R3).
  if (mode !== 'worktree') {
    const current = normBranch(await deps.getCurrentBranch(cwd))
    const main = normBranch(deps.getDefaultMainBranch(workspacePath))
    if (current !== null && main !== null && current === main) {
      return { kind: 'skipped' }
    }
  }

  // Clear any stale cleanup todo for this intent before re-attempting (self-heal).
  deps.cancelEventsForIntent(intentId)

  const fail = (code: CleanupFailureCode, detail?: string): CleanupOutcome => {
    deps.pushFailureEvent({
      workspacePath,
      intentId,
      code: FAILURE_CODE[code],
      ...(detail ? { params: { detail } } : {}),
    })
    deps.broadcastWaitUserEvents(workspacePath)
    deps.broadcastIntents(workspacePath)
    return { kind: 'failed', code, detail }
  }

  // ① No committable changes ⇒ explicit failure, not a silent skip (MSC-R4).
  if (!(await deps.hasCommittableChanges(cwd))) {
    return fail('noChanges')
  }

  // ② Commit + push.
  const commit = await deps.commitAndPush(cwd, `feat: ${req.title}`)
  if (!commit.ok) {
    return fail('commitPushFailed', commit.error)
  }

  // Honest write-back of the steps that DID succeed: branch + pushed commit hash.
  const branch = await deps.getCurrentBranch(cwd)
  if (branch) deps.setBranchName(intentId, branch)
  const head = await deps.getHeadCommit(cwd)
  if (head) deps.setLatestCommitHash(intentId, head)

  // ③ Idempotent: an intent that already has a PR is not re-PR'd (MSC-R6).
  if (req.prId) {
    deps.broadcastIntents(workspacePath)
    return { kind: 'success', createdPr: false }
  }

  // ④ Create the PR.
  const { title, body } = buildPr(req, deps.getIntent)
  const headBranch = req.branchName ?? branch ?? undefined
  const pr = await deps.createGhPr(cwd, title, body, headBranch)
  if (!pr.ok || !pr.prId) {
    // gh missing / not logged in vs a generic create failure (MSC-R4 ③ vs ④).
    return fail(pr.unavailable ? 'ghUnavailable' : 'prFailed', pr.error)
  }

  deps.setPrInfo(intentId, pr.prId, 'reviewing', pr.prUrl ?? null)
  deps.broadcastIntents(workspacePath)
  return { kind: 'success', createdPr: true }
}
