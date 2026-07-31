/**
 * Framing-free cores for the two intent WRITES that reach outside c3 — creating
 * a PR and changing an intent's status.
 *
 * They were extracted from the WebSocket handlers verbatim so a second surface
 * (the advisor MCP tool group) executes the SAME gates in the SAME order instead
 * of re-implementing them. The rule the extraction protects: an action an agent
 * can take must have a human equivalent, and both must run one gate chain — not
 * two that drift.
 *
 * Neither function sends on a connection. Each returns a structured result the
 * caller frames as a WS `error` / response or as an MCP `{content, isError}`.
 */
import type { CreatePrStage, Intent, IntentStatus } from '@ccc/shared/protocol'
import { CREATE_PR_STAGES } from '@ccc/shared/protocol'
import { closeForgePr, commitAndPush, createGhPr, hasDiffAgainstMain } from '../../git.js'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { runServerSidePrCreate } from '../pr-events/tool-defs.js'
import type { GenericEvent } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import { normalizeBranchName } from './dependency-gate.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { clearJudgedSession, clearRunStatus } from './run-status.js'
import {
  canTransition,
  getIntent,
  isStoreAvailable,
  safeInsertIntentLog,
  setPrInfo,
  updateStatus,
} from './store.js'
import { getWorktreePath } from './worktree.js'

/** A structured outcome both surfaces can frame. */
export type IntentWriteResult<T = Record<string, never>> =
  ({ success: true } & T) | { success: false; code: string; params?: Record<string, string> }

// ---------------------------------------------------------------------------
// create_pr
// ---------------------------------------------------------------------------

export interface CreatePrDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Publish the normalized `pr:create` event so event-triggered automations react. */
  publishEvent: (workspacePath: string, sessionId: string, event: GenericEvent) => void
  /** Lifecycle-log actor. */
  actor?: string | null
  /**
   * Optional coarse progress sink for a user-initiated run (the WS handler pushes
   * it to the requesting connection). Omitted by the agent/automation surfaces,
   * which have no connection to report to. Observational only — it never changes
   * a gate, a Git action or the returned result.
   */
  onStage?: (stage: CreatePrStage) => void
}

/**
 * Wrap `onStage` so stages are reported at most once and only ever forward.
 * `commitAndPush` fires its commit/push boundary once per affected repo in a
 * multi-repo workspace; the overlay contract is a single one-way pass, so the
 * repeats and the resulting back-steps are dropped here rather than on the wire.
 */
function monotonicStageReporter(
  onStage: ((stage: CreatePrStage) => void) | undefined,
): (stage: CreatePrStage) => void {
  let reached = -1
  return (stage) => {
    if (!onStage) return
    const index = CREATE_PR_STAGES.indexOf(stage)
    if (index <= reached) return
    reached = index
    onStage(stage)
  }
}

/**
 * Create a PR for one intent. Gate order is fixed and unchanged: already has a
 * PR (idempotent, no Git work at all) → worktree mode → non-empty branch →
 * the worktree actually differs from main. Only then does it commit, push, and
 * create the PR; a failed commit never creates one.
 *
 * `deps.onStage` observes that same order: the synchronous gates ahead of the
 * diff check report nothing (a rejection there is only an error), and a failure
 * never reports a stage the run did not reach.
 */
export async function createPrForIntent(
  workspacePath: string,
  intentId: string,
  deps: CreatePrDeps,
): Promise<IntentWriteResult<{ prId: string; prUrl: string }>> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }
  const req = getIntent(intentId)
  if (!req) return { success: false, code: 'intent.notFound' }

  // Idempotent guard first: an intent that already has a PR is never re-created —
  // no Git checks, no commit, no push. Independent of intent status.
  if (req.prId) {
    return {
      success: false,
      code: 'intent.prCreateFailed',
      params: { detail: `intent 已有 PR #${req.prId}` },
    }
  }
  if (getGitBranchMode(workspacePath) !== 'worktree') {
    return { success: false, code: 'intent.prCreateNotWorktree' }
  }
  if (normalizeBranchName(req.branchName) === null) {
    return { success: false, code: 'intent.prCreateNoBranch' }
  }
  const reportStage = monotonicStageReporter(deps.onStage)
  const worktreePath = getWorktreePath(workspacePath, intentId)
  reportStage('analyzing-changes')
  if (!(await hasDiffAgainstMain(worktreePath))) {
    return { success: false, code: 'intent.prCreateNoChanges' }
  }

  const headBranch = req.branchName ?? undefined
  const title = `feat: ${req.title}`
  const body = buildPrBody(req)

  try {
    // Commit and push first; only create the PR when that succeeded.
    const commit = await commitAndPush(worktreePath, title)
    if (!commit.ok) {
      return {
        success: false,
        code: 'intent.prCreateFailed',
        params: { detail: commit.error ?? '提交失败' },
      }
    }
    const pr = await createGhPr(worktreePath, title, body, headBranch)
    if (!pr.ok || !pr.prId) {
      return {
        success: false,
        code: 'intent.prCreateFailed',
        params: { detail: pr.error ?? '未知错误' },
      }
    }
    setPrInfo(intentId, pr.prId, 'reviewing', pr.prUrl ?? null)
    safeInsertIntentLog(intentId, 'pr_created', `创建 PR #${pr.prId}`, deps.actor)
    deps.broadcastIntents(workspacePath)
    runServerSidePrCreate(
      {
        prId: pr.prId,
        prUrl: pr.prUrl ?? null,
        headBranch,
        baseBranch: undefined,
        intentId,
      },
      deps.normalizeEvent,
      (event) => deps.publishEvent(workspacePath, intentId, event),
    )
    return { success: true, prId: pr.prId, prUrl: pr.prUrl ?? pr.prId }
  } catch (err) {
    return {
      success: false,
      code: 'intent.prCreateFailed',
      params: { detail: err instanceof Error ? err.message : String(err) },
    }
  }
}

/** The PR body: the intent content plus a dependency roll-up when it has any. */
function buildPrBody(req: Intent): string {
  const parts: string[] = [req.content]
  if (req.dependsOn.length > 0) {
    parts.push('', '## 依赖需求')
    for (const depId of req.dependsOn) {
      const dep = getIntent(depId)
      parts.push(`- ${dep?.title ?? depId} (${dep?.status ?? 'unknown'})`)
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// update_intent_status
// ---------------------------------------------------------------------------

export interface StatusChangeDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Domain event for cross-feature subscribers (ADR-0018). */
  publishStatusChanged: (input: {
    intentId: string
    workspacePath: string
    fromStatus: IntentStatus
    toStatus: IntentStatus
  }) => void
  actor?: string | null
}

/**
 * Change an intent's status.
 *
 * Cancelling an intent that owns a PR closes the remote PR FIRST: a close
 * failure blocks the cancellation entirely, so the ledger never claims a
 * cancellation the forge did not accept.
 */
export async function applyIntentStatusChange(
  workspacePath: string,
  intentId: string,
  status: IntentStatus,
  deps: StatusChangeDeps,
): Promise<IntentWriteResult<{ fromStatus: IntentStatus }>> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }
  const req = getIntent(intentId)
  if (!req) return { success: false, code: 'intent.notFound' }
  if (!canTransition(req.status, status)) {
    return {
      success: false,
      code: 'intent.illegalStatusTransition',
      params: { from: req.status, to: status },
    }
  }
  if (status === 'cancelled' && req.prId) {
    const close = await closeForgePr(workspacePath, req.prId)
    if (!close.ok) {
      return {
        success: false,
        code: 'intent.prCloseFailed',
        params: { detail: close.error ?? '未知错误' },
      }
    }
  }

  const prevStatus = req.status
  updateStatus(intentId, status, deps.actor ?? 'system')
  if (status === 'cancelled' && req.prId) {
    setPrInfo(intentId, req.prId, 'closed', req.prUrl ?? null)
    safeInsertIntentLog(intentId, 'pr_closed', `PR #${req.prId} 已随意图取消`, deps.actor)
  }
  // Leaving in_progress drops the derived caches, so a later restart cannot show
  // a stale dangling/running label.
  if (prevStatus === 'in_progress' && status !== 'in_progress') {
    clearRunStatus(intentId)
    clearJudgedSession(intentId)
  }
  deps.publishStatusChanged({ intentId, workspacePath, fromStatus: prevStatus, toStatus: status })
  publishIntentStatusTransition(workspacePath, req, prevStatus, status)
  deps.broadcastIntents(workspacePath)
  return { success: true, fromStatus: prevStatus }
}
