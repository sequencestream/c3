/**
 * Queue action family: landing the PRs of an intent the queue itself reviewed.
 *
 * This is the only place c3 changes state on a forge without a human pressing
 * anything, so the whole file is shaped around one question: at the instant the
 * command goes out, is every fact that justified it still true?
 *
 * Four guards, in order, and none of them is redundant:
 *  1. the credential is re-validated against the LIVE ledger (`mergeDenial`) —
 *     the kernel's snapshot may be a tick old;
 *  2. the phase is claimed with a conditional, read-back-confirmed update. A claim
 *     that cannot be persisted means no command is sent at all: an unrecorded
 *     attempt is one a restart would repeat;
 *  3. each PR is re-read from its OWN forge and repository immediately before its
 *     merge, and its head commit must still be the one the review pinned;
 *  4. the command itself carries the expected head commit, so even the gap between
 *     that read and the merge is closed by the forge.
 *
 * Failure is terminal by design. There is no retry ladder here: a conflict, a red
 * check, a missing approval, a forbidden strategy, a missing CLI or a timeout all
 * hand the intent to a human with a reason and a todo. The intent stays
 * `reviewing` with an `approved` review — only the AUTOMATIC merge is over — and
 * the queue moves on to intents that do not depend on it.
 *
 * And success is never asserted. `gh`/`glab` returning 0 is not proof a PR landed;
 * only `syncIntentPrStatus` reading the forge back is, and only then does
 * `completeIntentOnPrsMerged` get to write `done`.
 */
import type { Intent } from '@ccc/shared/protocol'
import type {
  QueueAction,
  QueueMergeGrant,
  QueueMergePhase,
  QueuePrIdentity,
} from '../../kernel/queue/index.js'
import { getForgeOverride, getGitBranchMode } from '../../kernel/config/index.js'
import { getForgePrLinkFacts, mergeForgePr } from '../../git.js'
import { mergeDenial, orderedActivePrs } from './merge-authority.js'
import { completeIntentOnPrsMerged } from './pr-merge-completion.js'
import { syncIntentPrStatus } from './pr-status-sync.js'
import type { QueueActionContext } from './queue-action-context.js'
import {
  appendQueueDecisions,
  claimQueueMergePhase,
  getQueueIntentMetaById,
  putQueueIntentMeta,
} from './queue-store.js'
import { getIntent, safeInsertIntentLog } from './store.js'
import { getWorktreePath, worktreeExists } from './worktree.js'

/** The kernel action shape this family executes. */
type MergeAction = Extract<QueueAction, { kind: 'merge_prs' }>

/** Why an automatic merge ended without landing everything. */
type HandBackReason = 'pr_merge_failed' | 'pr_merge_unconfirmed'

/**
 * Execute one `merge_prs` action, from credential re-check to forge sync.
 *
 * `recover` (a restart found an attempt persisted as in flight) takes the SAME
 * path minus the commands: the PRs are re-read, a set that all landed converges
 * normally, and anything else is handed back as unconfirmed. Nothing is ever
 * re-sent, because the attempt being recovered from may have succeeded.
 */
export async function runMergePhase(
  ctx: QueueActionContext,
  action: MergeAction,
  req: Intent,
): Promise<void> {
  const fresh = getIntent(req.id) ?? req
  const meta = getQueueIntentMetaById(fresh.id)

  // Recovery reads the forge through the workspace, so it runs even when the
  // intent's worktree is already gone — a cleaned-up directory must not be able to
  // strand an attempt whose result is still unknown.
  if (action.recover) {
    await reconcileAfterAttempt(ctx, fresh, meta.mergeGrant, '发现未完成的合并记录')
    return
  }

  const cwd = mergeCwd(ctx, fresh.id)
  if (!cwd) {
    handBack(ctx, fresh, 'pr_merge_failed', '意图 worktree 不可用,无法调用 forge 合并')
    return
  }

  // The kernel decided a tick ago; the ledger is re-read here. A credential that
  // stopped holding in between revokes itself and the merge never happens.
  const denial = mergeDenial(fresh, meta)
  if (denial !== null) {
    console.log(`[c3:queue]「${fresh.title}」自动合并资格已失效(${denial}),本轮不合并`)
    ctx.requestPass()
    return
  }
  const grant = meta.mergeGrant
  if (!grant) {
    ctx.requestPass()
    return
  }

  // Claim BEFORE any external call, and only on a write that was confirmed. A
  // claim that loses its conditional check is not a failure — another pass got
  // there first — and a db that cannot record the claim stops the merge entirely.
  const claimed = claimQueueMergePhase(
    ctx.workspacePath,
    fresh.id,
    { phase: 'pending', grant },
    { phase: 'running', detail: null, startedAt: Date.now() },
  )
  if (!claimed) {
    console.log(`[c3:queue]「${fresh.title}」合并阶段认领未成功,本轮不调用 forge`)
    ctx.requestPass()
    return
  }
  ctx.hooks.broadcastQueueDetail(ctx.workspacePath)

  const fallbackForge = getForgeOverride(ctx.workspacePath)
  const pinned = new Map(grant.prs.map((p) => [identityKey(p), p]))
  let sent = 0

  for (const pr of orderedActivePrs(fresh)) {
    const expect = pinned.get(identityKey(pr))
    if (!expect) {
      // A PR appeared after the approval. The review never saw it, so nothing in
      // this batch may proceed under that approval.
      handBack(ctx, fresh, 'pr_merge_failed', `PR #${pr.number} 不在评审时的 PR 集合内`)
      return
    }
    const forge = pr.forge ?? fallbackForge
    const facts = await getForgePrLinkFacts(cwd, pr.number, forge, pr.repo)
    if (!facts.ok) {
      handBack(
        ctx,
        fresh,
        'pr_merge_failed',
        `读取 PR #${pr.number} 失败:${facts.error ?? 'forge 未返回结果'}`,
      )
      return
    }
    if (facts.status === 'merged' || facts.status === 'closed') {
      // Already terminal on the forge. Nothing to send; the sync below records
      // that row's real state.
      continue
    }
    const mismatch = identityMismatch(expect, facts)
    if (mismatch) {
      handBack(ctx, fresh, 'pr_merge_failed', `PR #${pr.number} ${mismatch}`)
      return
    }
    const result = await mergeForgePr(cwd, pr.number, forge, {
      repo: pr.repo,
      expectedHeadSha: expect.headSha,
    })
    sent += 1
    if (result.timedOut) {
      // The command was sent and its outcome is unknown. Re-reading the forge is
      // the only honest next step; re-sending would be a second merge nobody
      // authorized.
      await reconcileAfterAttempt(ctx, fresh, meta.mergeGrant, `PR #${pr.number} 合并调用超时`)
      return
    }
    if (!result.ok) {
      handBack(
        ctx,
        fresh,
        'pr_merge_failed',
        `PR #${pr.number} 合并失败:${result.error ?? '未知原因'}` +
          (result.unavailable ? '(forge CLI 不可用或未登录)' : ''),
      )
      return
    }
    safeInsertIntentLog(
      fresh.id,
      'pr_merged',
      `队列自动合并 PR #${pr.number} → ${expect.baseBranch ?? '目标分支'}`,
      'automation',
    )
  }

  await settleAfterMerge(ctx, fresh, meta.mergeGrant, sent)
}

/**
 * Turn a finished batch of merge commands into a durable outcome.
 *
 * The CLI's own exit code is deliberately NOT the verdict: the PR rows are synced
 * from the forge, and only an aggregate that actually reads `merged` lets the
 * convergence check write `done`. Anything short of that is handed back as
 * unconfirmed rather than being recorded as a success nobody observed.
 */
async function settleAfterMerge(
  ctx: QueueActionContext,
  req: Intent,
  grant: QueueMergeGrant | null,
  sent: number,
): Promise<void> {
  // The attempt is no longer running, so its start time stops being meaningful;
  // what matters from here is whether the forge confirms the result.
  claimQueueMergePhase(
    ctx.workspacePath,
    req.id,
    { phase: 'running', grant },
    { phase: 'awaiting_sync', detail: null, startedAt: null },
  )
  await reconcileAfterAttempt(
    ctx,
    req,
    grant,
    sent === 0 ? '活跃 PR 在远端均已终结,未发送合并命令' : '合并命令已发送,等待 forge 确认',
  )
}

/**
 * Read the forge back and decide what actually happened.
 *
 * Shared by the normal path, the timeout path and the restart-recovery path,
 * because all three are asking the same question and none of them may answer it
 * by re-sending a command. The sync covers every ACTIVE row, not just the
 * `reviewing` ones: a row left at `failed` or `rejected` locally can still be open
 * on the forge, and a merge that landed it must be observed.
 */
async function reconcileAfterAttempt(
  ctx: QueueActionContext,
  req: Intent,
  grant: QueueMergeGrant | null,
  context: string,
): Promise<void> {
  const sync = await syncIntentPrStatus({
    workspacePath: ctx.workspacePath,
    intentId: req.id,
    scope: 'active',
    broadcastIntents: ctx.hooks.broadcastIntents,
  })

  const landed = sync.prStatus === 'merged'
  if (!landed) {
    handBack(
      ctx,
      req,
      'pr_merge_unconfirmed',
      `${context};forge 未确认全部 PR 已合并${sync.error ? `(${sync.error})` : ''}`,
    )
    return
  }

  claimQueueMergePhase(
    ctx.workspacePath,
    req.id,
    { phase: readPhase(req.id), grant },
    { phase: 'completed', detail: context, startedAt: null },
  )
  // The sync already runs the convergence check; calling it again is how a `done`
  // that the sync's own early-return path skipped still gets written.
  if (completeIntentOnPrsMerged(ctx.workspacePath, req.id)) {
    ctx.hooks.broadcastIntents(ctx.workspacePath)
  }
  recordMergeDecision(ctx, req.id, 'merge_prs', 'pr_merging', `${context};PR 已全部合并`)
  ctx.hooks.broadcastQueueDetail(ctx.workspacePath)
  ctx.requestPass()
  console.log(`[c3:queue]「${req.title}」自动合并完成:${context}`)
}

/**
 * End this intent's automatic merge and give it to a human.
 *
 * Not a park and not a failure-ladder attempt: the WORK is fine and the review
 * passed, so the intent keeps its state and only loses its auto-merge candidacy
 * (the `handed_back` phase is what `mergeDenial` reads to refuse a new attempt).
 * The reason, the decision row and the deduplicated todo are what keep a stopped
 * merge visible instead of leaving the queue claiming it is still merging.
 */
function handBack(
  ctx: QueueActionContext,
  req: Intent,
  reason: HandBackReason,
  detail: string,
): void {
  const prev = getQueueIntentMetaById(req.id)
  putQueueIntentMeta(ctx.workspacePath, {
    ...prev,
    intentId: req.id,
    mergeGrant: null,
    mergePhase: 'handed_back',
    mergeDetail: detail,
    mergeStartedAt: null,
    updatedAt: Date.now(),
  })
  recordMergeDecision(ctx, req.id, 'block', reason, detail)
  ctx.hooks.createUserTodo({
    workspacePath: ctx.workspacePath,
    intentId: req.id,
    sessionId: req.reviewSessionId,
    title: `「${req.title}」${detail}`,
    reasonCode: reason,
  })
  ctx.hooks.broadcastQueueDetail(ctx.workspacePath)
  ctx.requestPass()
  console.warn(`[c3:queue]「${req.title}」自动合并交回人工(${reason}): ${detail}`)
}

function recordMergeDecision(
  ctx: QueueActionContext,
  intentId: string,
  action: string,
  reason: string,
  detail: string,
): void {
  const meta = getQueueIntentMetaById(intentId)
  appendQueueDecisions([
    {
      tickId: ctx.tickId() || 'merge',
      workspacePath: ctx.workspacePath,
      intentId,
      decidedAt: Date.now(),
      action,
      blockedGate: reason,
      rejectReason: detail,
      attemptCount: meta.failureCount,
      backoffCount: meta.backoffCount,
      nextWakeupAt: null,
    },
  ])
}

/** The phase currently persisted, so a conditional update can name it. */
function readPhase(intentId: string): QueueMergePhase {
  return getQueueIntentMetaById(intentId).mergePhase
}

function identityKey(p: { forge: string | null; repo: string | null; number: string }): string {
  return `${p.forge ?? '?'}|${p.repo ?? '?'}|${p.number}`
}

/**
 * Why this PR may not be merged under the pinned approval; `null` when it may.
 *
 * A missing expected head commit is a REFUSAL, not a waiver: without it the merge
 * command has nothing to condition on, so the forge could land commits nobody
 * reviewed. That is exactly the case the spec calls "cannot guarantee the expected
 * commit", and it belongs to a human.
 */
function identityMismatch(
  expect: QueuePrIdentity,
  facts: { headSha?: string; headBranch?: string; baseBranch?: string },
): string | null {
  if (!expect.headSha) return '评审时未能读到 head SHA,无法保证合并的是被评审的提交'
  if (facts.headSha && facts.headSha !== expect.headSha) {
    return `head 已从 ${short(expect.headSha)} 更新为 ${short(facts.headSha)},评审结论不再覆盖当前提交`
  }
  if (expect.baseBranch && facts.baseBranch && facts.baseBranch !== expect.baseBranch) {
    return `目标分支已从 ${expect.baseBranch} 改为 ${facts.baseBranch}`
  }
  if (expect.headBranch && facts.headBranch && facts.headBranch !== expect.headBranch) {
    return `来源分支已从 ${expect.headBranch} 改为 ${facts.headBranch}`
  }
  return null
}

function short(sha: string): string {
  return sha.slice(0, 8)
}

/**
 * The directory the forge CLI runs in: the intent's own worktree, matching the
 * relay phases. `null` outside worktree mode or when the directory is gone — a
 * refusal, never a fallback to the project checkout.
 */
function mergeCwd(ctx: QueueActionContext, intentId: string): string | null {
  if (getGitBranchMode(ctx.workspacePath) !== 'worktree') return null
  const cwd = getWorktreePath(ctx.workspacePath, intentId)
  return worktreeExists(cwd) ? cwd : null
}
