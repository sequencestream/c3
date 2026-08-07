/**
 * Queue action family: development and delivery.
 *
 * Executes `launch`, `resume` and `attach` — the whole per-intent development
 * loop the queue drives: prepare the git working directory, run dev turns,
 * judge completion, commit & push (healing a pre-commit lint failure exactly
 * once), mark the intent `done`, and only then create the PR toward the
 * delivery the intent is associated with.
 *
 * Three invariants this file carries:
 * - a real human question is never answered by the queue. The checkpoint
 *   consensus may overrule a pending question, otherwise the intent is parked
 *   and a human is asked; the queue itself keeps going.
 * - an intent only reaches `done` through the existing judge → commit → push
 *   path. Nothing here shortcuts it.
 * - a PR is never filed at a target the user did not decide: the base comes from
 *   the intent's delivery association (`resolvePrTarget`), never from the
 *   workspace mainline as a fallback, and an intent with no delivery gets no
 *   automatic PR at all.
 *
 * Deliberately not here: in-flight registration, cooldown pre-writes and status
 * projection (the controller owns those), and any gate decision (the kernel
 * owns those).
 */
import { randomUUID } from 'node:crypto'
import type { Intent } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { QueueAction } from '../../kernel/queue/index.js'
import {
  errText,
  type InFlightRun,
  type QueueActionContext,
  type RunDevTurnInput,
} from './queue-action-context.js'
import { parkForHuman, recordFailure, recordSuccess } from './queue-outcome-actions.js'
import { MAX_CONTINUATIONS, hasPendingQuestion } from './turn-guards.js'
import {
  getIntent,
  safeInsertIntentLog,
  setBranchName,
  setLastWorkSession,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { parsePrIdentity } from './pr-identity.js'
import { prTargetFailureText, resolvePrTarget } from './pr-target.js'
import { registerPendingDevLink } from './dev-link.js'
import { buildDevPrompt } from './dev-prompt.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { JudgeUnavailableError, judgeCompletion, type JudgeVerdict } from './judge.js'
import { runCheckpointConsensus } from './checkpoint-consensus.js'
import { commitAndPush, createForgePr, gitDiffStat, gitRecentLog } from '../../git.js'
import { runServerSidePrCreate } from '../pr-events/tool-defs.js'
import {
  getDevSkill,
  getDefaultMode,
  getDefaultMainBranch,
  getForgeOverride,
  getGitBranchMode,
  getSddEnabled,
} from '../../kernel/config/index.js'
import { ensureRuntime, getRuntime } from '../../runs.js'
import {
  createWorktree,
  getWorktreePath,
  pullCurrentBranch,
  readBranch,
  worktreeExists,
} from './worktree.js'

/** The kernel action shapes this family executes. */
type DevAction = Extract<QueueAction, { kind: 'launch' | 'resume' | 'attach' }>

// ---------------------------------------------------------------------------
// The per-intent development loop
// ---------------------------------------------------------------------------

export async function runDevelopLoop(
  ctx: QueueActionContext,
  action: DevAction,
  req: Intent,
  record: InFlightRun,
): Promise<void> {
  const signal = ctx.signal
  let turnInput = buildFirstTurn(ctx, action, req, signal)
  record.sessionId = turnInput.sessionId
  let continuations = 0

  for (;;) {
    const result = await ctx.hooks.runDevTurn(turnInput)
    if (signal.aborted || ctx.isDisposed()) return
    const sessionId = result.sessionId || turnInput.sessionId || ''
    record.sessionId = sessionId
    markInProgress(ctx, req.id, sessionId)

    if (result.outcome === 'blocked') return // user stop / abort
    if (result.outcome === 'error') {
      recordFailure(ctx, req.id, 'turn_error', result.detail ?? '开发 turn 运行出错')
      return
    }

    const fresh = getIntent(req.id) ?? req
    const rt = getRuntime(sessionId)
    let lastMessage = result.lastMessage
    let pendingQuestion = result.pendingQuestion === true
    if (rt) {
      const texts: string[] = []
      for (const e of rt.buffer) if (e.type === 'assistant_text') texts.push(e.text)
      if (texts.length > 0) lastMessage = texts.join('\n')
      pendingQuestion = pendingQuestion || hasPendingQuestion(rt.buffer)
    }

    const evidenceCwd = gitCwd(ctx, req.id)
    const [diffStat, recentLog] = await Promise.all([
      gitDiffStat(evidenceCwd),
      gitRecentLog(evidenceCwd),
    ])
    if (signal.aborted || ctx.isDisposed()) return

    // A real human decision is never continued over. The checkpoint consensus
    // may overrule it; otherwise the intent is parked and a human is asked —
    // the queue itself keeps going.
    if (pendingQuestion) {
      const ck = await runCheckpointConsensus({
        workspacePath: ctx.workspacePath,
        intent: fresh,
        lastMessage,
        trigger: 'pending_question',
        triggerReason: '存在未作答的 AskUserQuestion',
        diffStat,
        signal,
      })
      if (signal.aborted || ctx.isDisposed()) return
      if (ck?.decision === 'continue') {
        ctx.setCheckpointConsensus(ck)
        continuations += 1
        if (continuations > MAX_CONTINUATIONS) {
          recordFailure(ctx, req.id, 'budget_exhausted', `超过最大续跑次数(${MAX_CONTINUATIONS})`)
          return
        }
        turnInput = buildContinueTurn(ctx, req.id, sessionId, signal)
        continue
      }
      parkForHuman(ctx, fresh, 'needs_human_decision', '存在未作答的提问,需要人工决策')
      return
    }

    // A judge that cannot run says NOTHING about the intent — it must not be read
    // as `stuck` (that would send a healthy intent through the human-decision
    // path). Record it as its own failure so the ladder backs off and the reason
    // points at the tool agent's provider config, not at the work.
    let verdict: JudgeVerdict
    try {
      verdict = await judgeCompletion({
        req: fresh,
        lastMessages: [lastMessage],
        evidence: { diffStat, recentLog },
        cwd: ctx.workspacePath,
        signal,
      })
    } catch (err) {
      if (signal.aborted || ctx.isDisposed()) return
      const detail =
        err instanceof JudgeUnavailableError ? err.detail : `完成判定执行失败:${errText(err)}`
      recordFailure(
        ctx,
        req.id,
        'judge_unavailable',
        `完成判定不可用(检查 tool agent 配置):${detail}`,
      )
      return
    }
    if (signal.aborted || ctx.isDisposed()) return

    if (verdict.verdict === 'done') {
      const committed = await commitWithLintHeal(ctx, fresh, sessionId, record, signal)
      if (committed === 'aborted' || ctx.isDisposed()) return
      if (committed === 'failed') return // recordFailure already applied
      updateStatus(fresh.id, 'done')
      publishIntentStatusTransition(ctx.workspacePath, fresh, fresh.status, 'done')
      ctx.markCompleted(fresh.id)
      ctx.hooks.broadcastIntents(ctx.workspacePath)
      recordSuccess(ctx, fresh.id)
      // The PR comes AFTER `done` is written, and reads the intent back before
      // acting: no automatic path may produce a PR for an intent that is still
      // `in_progress`. Its outcome — created, skipped, or target unavailable —
      // never changes the `done` this intent already reached.
      await maybeCreatePr(ctx, fresh.id)
      console.log(`[c3:queue]「${fresh.title}」已完成 → done`)
      return
    }

    if (verdict.verdict === 'in_progress') {
      continuations += 1
      if (continuations > MAX_CONTINUATIONS) {
        recordFailure(
          ctx,
          req.id,
          'budget_exhausted',
          `超过最大续跑次数(${MAX_CONTINUATIONS}),最后状态:${verdict.reason}`,
        )
        return
      }
      turnInput = buildContinueTurn(ctx, req.id, sessionId, signal)
      continue
    }

    // stuck → checkpoint consensus may overrule, else this intent fails.
    const ck = await runCheckpointConsensus({
      workspacePath: ctx.workspacePath,
      intent: fresh,
      lastMessage,
      trigger: 'judge_stuck',
      triggerReason: verdict.reason,
      diffStat,
      signal,
    })
    if (signal.aborted || ctx.isDisposed()) return
    if (ck?.decision === 'continue') {
      ctx.setCheckpointConsensus(ck)
      continuations += 1
      if (continuations > MAX_CONTINUATIONS) {
        recordFailure(ctx, req.id, 'budget_exhausted', `超过最大续跑次数(${MAX_CONTINUATIONS})`)
        return
      }
      turnInput = buildContinueTurn(ctx, req.id, sessionId, signal)
      continue
    }
    recordFailure(ctx, req.id, 'judge_stuck', `未真实完成:${verdict.reason}`)
    return
  }
}

// ---------------------------------------------------------------------------
// Turn construction
// ---------------------------------------------------------------------------

/**
 * Build the first turn for a launch/resume/attach. Fresh launches prepare the
 * git working directory first; anything thrown here (diverged branch, worktree
 * failure) propagates to the controller's catch and becomes ONE failed attempt
 * for this intent — never a stopped queue.
 */
function buildFirstTurn(
  ctx: QueueActionContext,
  action: DevAction,
  req: Intent,
  signal: AbortSignal,
): RunDevTurnInput {
  if (action.kind === 'attach') {
    return {
      workspacePath: ctx.workspacePath,
      sessionId: action.sessionId,
      prompt: '',
      intentId: req.id,
      signal,
      attach: true,
      onAwaitingPermission: (a) => ctx.setAwaiting(a),
    }
  }
  if (action.kind === 'resume') {
    ensureResumeRuntime(ctx, req, action.sessionId)
    return buildContinueTurn(ctx, req.id, action.sessionId, signal)
  }

  // Fresh launch — mirror the manual `startDevelopment` git strategy.
  const pendingId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  let effectiveCwd: string
  if (getGitBranchMode(ctx.workspacePath) === 'worktree') {
    const wt = createWorktree(
      ctx.workspacePath,
      req.id,
      req.title,
      getDefaultMainBranch(ctx.workspacePath),
    )
    effectiveCwd = wt.worktreePath
    setBranchName(req.id, wt.branchName)
  } else {
    const pull = pullCurrentBranch(ctx.workspacePath)
    if (!pull.ok) {
      throw new Error(
        `当前分支已与远端分叉，无法 fast-forward，请先手动同步:\n${pull.message ?? ''}`,
      )
    }
    effectiveCwd = ctx.workspacePath
    const branch = readBranch(ctx.workspacePath)
    if (branch) setBranchName(req.id, branch)
  }

  const rt = ensureRuntime(
    pendingId,
    ctx.workspacePath,
    getDefaultMode(ctx.workspacePath),
    [],
    'work',
    undefined,
    'background',
  )
  rt.effectiveCwd = effectiveCwd
  registerPendingDevLink(pendingId, req.id)

  const devParts = buildDevPrompt({
    title: req.title,
    content: req.content,
    dependsOn: req.dependsOn,
    devSkill: getDevSkill(ctx.workspacePath),
    sddEnabled: getSddEnabled(ctx.workspacePath),
    specPath: req.specPath,
  })
  return {
    workspacePath: ctx.workspacePath,
    sessionId: pendingId,
    prompt: devParts.visible,
    ...(devParts.userTurnPrefix ? { userTurnPrefix: devParts.userTurnPrefix } : {}),
    ...(devParts.systemInstruction ? { systemInstruction: devParts.systemInstruction } : {}),
    intentId: req.id,
    signal,
    onAwaitingPermission: (a) => ctx.setAwaiting(a),
  }
}

function buildContinueTurn(
  ctx: QueueActionContext,
  intentId: string,
  sessionId: string,
  signal: AbortSignal,
): RunDevTurnInput {
  return {
    workspacePath: ctx.workspacePath,
    sessionId,
    prompt: 'continue',
    intentId,
    signal,
    onAwaitingPermission: (a) => ctx.setAwaiting(a),
  }
}

// ---------------------------------------------------------------------------
// Delivery: commit, lint self-heal, PR
// ---------------------------------------------------------------------------

/**
 * Commit & push, self-healing exactly once through a fix agent turn when a
 * pre-commit lint hook blocked it. The fix turn is awaited like every other
 * kernel run.
 */
async function commitWithLintHeal(
  ctx: QueueActionContext,
  req: Intent,
  sessionId: string,
  record: InFlightRun,
  signal: AbortSignal,
): Promise<'ok' | 'failed' | 'aborted'> {
  const message = `feat: ${req.title}`
  const first = await commitAndPush(gitCwd(ctx, req.id), message)
  if (signal.aborted) return 'aborted'
  if (first.ok) return 'ok'

  if (first.failure !== 'commit-hook') {
    recordFailure(ctx, req.id, 'commit_failed', first.error ?? '提交失败')
    return 'failed'
  }

  console.warn(
    `[c3:queue]「${req.title}」pre-commit lint 失败,启动修复 agent 介入一次:${first.error}`,
  )
  record.phase = 'fixing'
  ctx.setState('fixing')
  try {
    await ctx.hooks.runDevTurn({
      workspacePath: ctx.workspacePath,
      sessionId,
      prompt: `pre-commit 钩子的 lint 检查未通过,本次提交被拦截。请修复以下 lint/格式报错,改完即可,无需自行 git commit:\n\n${first.error ?? 'pre-commit lint 失败'}`,
      intentId: req.id,
      signal,
      onAwaitingPermission: (a) => ctx.setAwaiting(a),
    })
  } finally {
    record.phase = 'developing'
  }
  if (signal.aborted || ctx.isDisposed()) return 'aborted'

  const second = await commitAndPush(gitCwd(ctx, req.id), message)
  if (signal.aborted) return 'aborted'
  if (second.ok) return 'ok'
  recordFailure(
    ctx,
    req.id,
    'commit_failed',
    `lint 自动修复后仍未通过:${second.error ?? '未知 lint 错误'}`,
  )
  return 'failed'
}

/**
 * Best-effort PR creation after a successful commit+push and the `done` write.
 *
 * Three gates before any forge work, in this order:
 *  - git mode: `worktree` creates PRs, `current-branch` never does;
 *  - the intent, re-read, is actually `done` — an automatic path never files a
 *    PR for work that is still in progress;
 *  - the PR target resolves through the SAME `resolvePrTarget` the human button
 *    uses, so an automatic PR reaches exactly the targets a human could reach.
 *
 * The automatic policy on top of that resolution, and the only place it differs
 * from the human path: an intent with NO linked delivery gets no PR at all
 * (recorded as a `pr_skipped` log rather than silently dropped) instead of a
 * mainline PR nobody decided on, and an unresolvable target raises a todo. There
 * is no fallback to the mainline in either case.
 */
async function maybeCreatePr(ctx: QueueActionContext, intentId: string): Promise<void> {
  if (getGitBranchMode(ctx.workspacePath) !== 'worktree') return
  const req = getIntent(intentId)
  if (!req) return
  if (req.status !== 'done') return

  const target = resolvePrTarget(ctx.workspacePath, req, undefined)
  if (!target.ok) {
    const detail = prTargetFailureText(target.code)
    console.warn(`[c3:queue]「${req.title}」${detail}`)
    ctx.hooks.createUserTodo({
      workspacePath: ctx.workspacePath,
      intentId: req.id,
      sessionId: req.lastWorkSessionId,
      title: `「${req.title}」${detail}`,
      reasonCode: 'pr_target_unavailable',
    })
    return
  }
  if (target.deliveryId === null) {
    // No delivery to file against. The code is committed and pushed on the
    // intent's own branch; the user links a delivery and creates the PR by hand.
    safeInsertIntentLog(req.id, 'pr_skipped', '未关联交付,未创建 PR', 'automation')
    ctx.hooks.broadcastIntents(ctx.workspacePath)
    console.log(`[c3:queue]「${req.title}」未关联交付,未创建 PR`)
    return
  }

  const { deliveryId, baseBranch } = target
  const prResult = await createPrForIntent(ctx, req, baseBranch).catch((err) => {
    console.warn(`[c3:queue]「${req.title}」PR 创建异常: ${errText(err)}`)
    return null
  })
  if (prResult?.ok) {
    // Persist the PR's identity alongside its number: `repo` lives only in the URL
    // the forge CLI printed, and the forge is the one this create routed through.
    const identity = parsePrIdentity(prResult.prUrl)
    upsertIntentPr({
      intentId: req.id,
      deliveryId,
      number: prResult.prId,
      status: 'reviewing',
      forge: identity.forge ?? getForgeOverride(ctx.workspacePath) ?? null,
      repo: identity.repo,
      url: prResult.prUrl || null,
      headBranch: req.branchName ?? null,
      baseBranch,
    })
    safeInsertIntentLog(req.id, 'pr_created', `创建 PR #${prResult.prId}`, 'automation')
    ctx.hooks.broadcastIntents(ctx.workspacePath)
    console.log(`[c3:queue]「${req.title}」PR #${prResult.prId} 已创建`)

    const headBranch = req.branchName ?? undefined
    const effectiveSessionId = req.lastWorkSessionId ?? req.id
    runServerSidePrCreate(
      {
        prId: prResult.prId,
        prUrl: prResult.prUrl,
        headBranch,
        baseBranch,
        intentId: req.id,
        deliveryId,
      },
      ctx.hooks.normalizeEvent,
      (event) =>
        ctx.hooks.publishEvent({
          workspacePath: ctx.workspacePath,
          sessionId: effectiveSessionId,
          event,
        }),
    )
  } else if (prResult) {
    console.warn(`[c3:queue]「${req.title}」PR 创建失败: ${prResult.error}`)
  }
}

async function createPrForIntent(
  ctx: QueueActionContext,
  req: Intent,
  baseBranch: string,
): Promise<{ ok: true; prId: string; prUrl: string } | { ok: false; error: string } | null> {
  const headBranch = req.branchName ?? undefined
  const bodyParts: string[] = [req.content]
  if (req.dependsOn.length > 0) {
    bodyParts.push('', '## 依赖需求')
    for (const depId of req.dependsOn) {
      const dep = getIntent(depId)
      bodyParts.push(`- ${dep?.title ?? depId} (${dep?.status ?? 'unknown'})`)
    }
  }
  const prResult = await createForgePr(
    gitCwd(ctx, req.id),
    `feat: ${req.title}`,
    bodyParts.join('\n'),
    headBranch,
    baseBranch,
    getForgeOverride(ctx.workspacePath),
  )
  if (prResult.ok && prResult.prId) {
    return { ok: true as const, prId: prResult.prId, prUrl: prResult.prUrl ?? '' }
  }
  return { ok: false as const, error: prResult.error ?? 'Unknown error' }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function markInProgress(ctx: QueueActionContext, intentId: string, sessionId: string): void {
  if (!sessionId) return
  const req = getIntent(intentId)
  if (!req) return
  if (req.lastWorkSessionId !== sessionId) setLastWorkSession(intentId, sessionId)
  if (req.status !== 'in_progress') {
    updateStatus(intentId, 'in_progress')
    publishIntentStatusTransition(ctx.workspacePath, req, req.status, 'in_progress')
  }
  ctx.setCurrentSessionId(sessionId)
  ctx.hooks.broadcastIntents(ctx.workspacePath)
}

/**
 * The git working directory for an intent's commit/push/PR/evidence ops:
 * the isolated worktree in `worktree` mode, else the project checkout itself.
 */
function gitCwd(ctx: QueueActionContext, intentId: string): string {
  if (getGitBranchMode(ctx.workspacePath) === 'worktree') {
    return getWorktreePath(ctx.workspacePath, intentId)
  }
  return ctx.workspacePath
}

function ensureResumeRuntime(ctx: QueueActionContext, req: Intent, sessionId: string): void {
  const worktreeMode = getGitBranchMode(ctx.workspacePath) === 'worktree'
  const cwd = gitCwd(ctx, req.id)
  if (worktreeMode && !worktreeExists(cwd)) return
  const rt = ensureRuntime(
    sessionId,
    ctx.workspacePath,
    getDefaultMode(ctx.workspacePath),
    [],
    'work',
    undefined,
    'background',
  )
  if (!rt.effectiveCwd) rt.effectiveCwd = cwd
}
