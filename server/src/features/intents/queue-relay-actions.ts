/**
 * Queue action family: the PR review / fix relay.
 *
 * Executes `launch_review` and `launch_fix` — the two unattended agent phases the
 * queue drives after an intent's work is `done` and its PR exists. The kernel
 * decides WHICH phase; everything here is the side effect of running one.
 *
 * Four invariants this file carries:
 * - a phase is claimed before it is launched. The conditional claim writes the
 *   session placeholder, the transient `pending` marker and (for a fix) the round
 *   counter in ONE guarded update, so a repeated action, a racing tick or a
 *   restart can never spend the convergence budget twice.
 * - a turn that ends is not a conclusion. Only `sync_intent_review_status` /
 *   `sync_intent_fix_status` conclude a phase; an exit, a crash, a timeout or a
 *   confident "done" in the transcript leaves the phase un-concluded, releases
 *   the placeholder and counts as ONE failed attempt on the existing ladder.
 * - the agent identity is chosen once, at claim time, from the phase's role
 *   (`review` / `fix`) through the shared role-following rules. A settings change
 *   mid-flight never re-targets a running phase, and "no usable agent" is a loud
 *   failure — never a silent skip that would read as "review not needed".
 * - a fix runs in the intent's OWN worktree. There is no fallback to the project
 *   checkout: an unavailable worktree fails the attempt.
 *
 * Deliberately not here: in-flight bookkeeping and the cooldown pre-write (the
 * controller owns both), and any decision about WHETHER a phase may run (the
 * kernel owns that).
 */
import { randomUUID } from 'node:crypto'
import type { Intent, IntentPr } from '@ccc/shared/protocol'
import { activeIntentPrs } from '@ccc/shared'
import type { QueueAction, QueuePrIdentity } from '../../kernel/queue/index.js'
import { getGitBranchMode, getForgeOverride } from '../../kernel/config/index.js'
import { getForgePrLinkFacts } from '../../git.js'
import type { QueueActionContext } from './queue-action-context.js'
import {
  bindQueueReviewClaimSession,
  orderedActivePrs,
  prIdentityOf,
  recordQueueReviewClaim,
} from './merge-authority.js'
import { recordFailure, recordSuccess } from './queue-outcome-actions.js'
import { bindRelayRunSession, registerRelayRun, unregisterRelayRun } from './relay-run-registry.js'
import { getIntent } from './store.js'
import { sessionAgentTargetForRole } from '../sessions/agent-target.js'
import { runRelaySession } from '../automations/relay-session.js'
import {
  bindRelayOccupancy,
  claimRelayOccupancy,
  newRelayPendingId,
  releaseRelayOccupancy,
  type RelayClaimExpectation,
  type RelayPhase,
} from './relay-occupancy.js'
import {
  RELAY_FIX_TOOL_ALLOWLIST,
  RELAY_REVIEW_TOOL_ALLOWLIST,
  buildRelayFixPrompt,
  buildRelayReviewPrompt,
} from './relay-prompt.js'
import { getWorktreePath, worktreeExists } from './worktree.js'

/** The kernel action shapes this family executes. */
type RelayAction = Extract<QueueAction, { kind: 'launch_review' | 'launch_fix' }>

/**
 * Wall-clock ceiling for one relay phase. Generous compared with the built-in
 * automation templates' 10 minutes: a review reads a real diff and a fix edits,
 * tests and pushes. The queue's own failure ladder, not this bound, is what stops
 * a phase that keeps dying.
 */
export const RELAY_MAX_WALL_CLOCK_MS = 30 * 60_000

/**
 * Run ONE relay phase for an intent, from claim to settlement.
 *
 * The order is the whole safety story: resolve the agent and the worktree (both
 * can refuse, and a refusal must leave the ledger untouched), then claim, then
 * launch. A claim that loses its conditional check is NOT a failure — the world
 * moved and the next pass re-derives from it — so it never counts against the
 * intent.
 */
export async function runRelayPhase(
  ctx: QueueActionContext,
  action: RelayAction,
  req: Intent,
): Promise<void> {
  const phase: RelayPhase = action.kind === 'launch_review' ? 'review' : 'fix'
  const label = phase === 'review' ? 'PR 评审' : 'PR 修复'

  // The agent identity, resolved BEFORE anything is written. An empty role field
  // follows the workspace / system default exactly as every other role does; a
  // group with no usable member is a configuration error a human must see, so it
  // fails loudly instead of quietly skipping the phase.
  const target = sessionAgentTargetForRole(phase, ctx.workspacePath)
  if (!target.ok) {
    recordFailure(
      ctx,
      req.id,
      'launch_failed',
      `${label} Agent 不可用:Agent 组「${target.groupRef}」没有可用成员`,
    )
    return
  }

  // The intent's own worktree. A fix must edit the PR's head branch, so there is
  // deliberately no fallback to the project checkout.
  const cwd = relayCwd(ctx, req.id)
  if (!cwd) {
    recordFailure(ctx, req.id, 'launch_failed', `${label} 无法执行:意图 worktree 不可用`)
    return
  }

  const prs = activeIntentPrs(req.prs)
  if (prs.length === 0) {
    // The PR list emptied between the kernel's snapshot and this executor. Nothing
    // to review: not a failure, just a world that moved.
    ctx.requestPass()
    return
  }

  const pendingId = newRelayPendingId()
  const claim = claimRelayOccupancy(req.id, phase, pendingId, expectationFor(action, req), {
    workspacePath: ctx.workspacePath,
    vendor: target.target.agent.vendor,
    agentId: target.target.ref,
    title: `${label}:${req.title}`,
  })
  if (!claim.ok) {
    if (claim.reason === 'projection-write-failed') {
      recordFailure(ctx, req.id, 'launch_failed', `${label} 占位投影不可写,本轮未启动`)
      return
    }
    // Stale expectation: another pass, a human backfill or a settled phase moved
    // the facts. Re-reconcile against what actually holds now.
    console.log(`[c3:queue]「${req.title}」${label} 阶段前置事实已变化,本轮不启动`)
    ctx.requestPass()
    return
  }

  // The phase is now the ledger's truth; from here every exit must either bind a
  // real session or release the placeholder.
  ctx.hooks.broadcastIntents(ctx.workspacePath)

  // A REVIEW round the queue owns records its own provenance: the session that
  // will run it and the exact PRs — down to the head commit — it is about to have
  // reviewed. Written now, before the agent can say anything, so an `approved`
  // conclusion later has something to be checked against that no caller authored.
  // A failed pin leaves no claim, which simply means this round grants no merge
  // authority; the review itself proceeds unchanged.
  if (phase === 'review') {
    recordQueueReviewClaim({
      workspacePath: ctx.workspacePath,
      intentId: req.id,
      sessionId: pendingId,
      prs: await pinReviewedPrs(ctx.workspacePath, cwd, req),
    })
  }

  // The execution handle is minted HERE so the run can be registered before it
  // launches: a tool call may arrive on the very first turn, and a registry that
  // was populated afterwards would fail to attribute it.
  const executionId = randomUUID()
  registerRelayRun(executionId, {
    intentId: req.id,
    phase,
    workspacePath: ctx.workspacePath,
    sessionId: pendingId,
  })

  const prompt =
    phase === 'review'
      ? buildRelayReviewPrompt({ intent: req, prs, round: action.round, sessionId: pendingId, cwd })
      : buildRelayFixPrompt({ intent: req, prs, round: action.round, sessionId: pendingId, cwd })

  let boundSessionId: string | null = null
  let outcome: { ok: boolean; error: string | null }
  try {
    outcome = await runRelaySession({
      workspaceName: ctx.workspacePath,
      vendor: target.target.agent.vendor,
      agentId: target.target.ref,
      prompt,
      toolAllowlist: phase === 'review' ? RELAY_REVIEW_TOOL_ALLOWLIST : RELAY_FIX_TOOL_ALLOWLIST,
      cwd,
      maxWallClockMs: RELAY_MAX_WALL_CLOCK_MS,
      title: `${label}:${req.title}`,
      executionId,
      onSessionBound: (sessionId) => {
        boundSessionId = sessionId
        bindRelayOccupancy(req.id, phase, pendingId, sessionId)
        bindRelayRunSession(executionId, sessionId)
        if (phase === 'review') {
          bindQueueReviewClaimSession(ctx.workspacePath, req.id, pendingId, sessionId)
        }
        ctx.hooks.broadcastIntents(ctx.workspacePath)
      },
    })
  } finally {
    // The registry answers "is this live call the queue's run?", so a run that has
    // ended must stop answering it — on every path, including a throw.
    unregisterRelayRun(executionId)
  }

  if (ctx.isDisposed()) return
  settleRelayPhase(ctx, req, phase, label, pendingId, boundSessionId, outcome)
}

/**
 * Pin the PR set a review round is about to judge, reading each PR's head commit
 * from its own forge and repository.
 *
 * The head SHA is the part that makes an approval specific to code rather than to
 * a PR number: a commit pushed after the review must not be merged under it. A PR
 * the forge cannot be read for is pinned with `headSha: null`, and the merge
 * executor refuses to send a command it cannot pin to an expected commit — so an
 * unreadable forge degrades to "a human merges this", never to "merge whatever is
 * there now".
 */
async function pinReviewedPrs(
  workspacePath: string,
  cwd: string,
  req: Intent,
): Promise<QueuePrIdentity[]> {
  const fallbackForge = getForgeOverride(workspacePath)
  const pinned: QueuePrIdentity[] = []
  for (const pr of orderedActivePrs(req)) {
    pinned.push(prIdentityOf(pr, await readHeadSha(cwd, pr, fallbackForge)))
  }
  return pinned
}

async function readHeadSha(
  cwd: string,
  pr: IntentPr,
  fallbackForge: ReturnType<typeof getForgeOverride>,
): Promise<string | null> {
  try {
    const facts = await getForgePrLinkFacts(cwd, pr.number, pr.forge ?? fallbackForge, pr.repo)
    return facts.ok ? (facts.headSha ?? null) : null
  } catch {
    return null
  }
}

/**
 * Decide what a finished relay turn actually achieved, and record it.
 *
 * The ledger — re-read here, never the snapshot the phase started from — is the
 * only evidence that counts. A terminal means the phase concluded and the failure
 * ladder is reset; anything else releases the placeholder so the next pass can
 * recover the SAME phase, and books one failed attempt so a phase that can never
 * conclude backs off and eventually parks.
 */
function settleRelayPhase(
  ctx: QueueActionContext,
  req: Intent,
  phase: RelayPhase,
  label: string,
  pendingId: string,
  boundSessionId: string | null,
  outcome: { ok: boolean; error: string | null },
): void {
  const fresh = getIntent(req.id)
  const concluded =
    phase === 'review'
      ? fresh?.reviewStatus === 'approved' || fresh?.reviewStatus === 'rejected'
      : fresh?.fixStatus === 'fixed'

  if (concluded) {
    recordSuccess(ctx, req.id)
    ctx.hooks.broadcastIntents(ctx.workspacePath)
    console.log(
      `[c3:queue]「${req.title}」${label} 结论已回填:` +
        (phase === 'review' ? fresh?.reviewStatus : fresh?.fixStatus),
    )
    return
  }

  // No conclusion. Release the placeholder (owner-safe against whichever id the
  // phase ended up holding) so the phase reads as un-started again, then book the
  // attempt. The ROUND is deliberately untouched: recovering a phase must not
  // refund convergence budget.
  releaseRelayOccupancy(req.id, phase, boundSessionId ?? pendingId)
  if (boundSessionId) releaseRelayOccupancy(req.id, phase, pendingId)
  ctx.hooks.broadcastIntents(ctx.workspacePath)
  recordFailure(
    ctx,
    req.id,
    outcome.ok ? 'turn_error' : 'launch_failed',
    outcome.ok
      ? `${label} 会话已结束但未回填结论`
      : `${label} 会话执行失败:${outcome.error ?? '未知原因'}`,
  )
}

/**
 * The facts a claim must still find, derived from the action the kernel emitted.
 *
 * A review claim keeps the round where it is and clears the fix marker; a fix
 * claim either takes the NEXT round (a fresh `rejected`) or re-enters the one it
 * already took (a `pending` fix whose session died). Reading the expectation off
 * the intent the executor was handed — not off a re-read — is what makes the
 * claim a genuine compare-and-set against the kernel's snapshot.
 */
function expectationFor(action: RelayAction, req: Intent): RelayClaimExpectation {
  if (action.kind === 'launch_review') {
    return {
      expectReviewStatus: req.reviewStatus,
      expectFixStatus: req.fixStatus,
      expectRounds: req.reviewFixRounds,
      nextRounds: req.reviewFixRounds,
    }
  }
  return {
    expectReviewStatus: 'rejected',
    expectFixStatus: req.fixStatus,
    expectRounds: req.reviewFixRounds,
    nextRounds: action.round,
  }
}

/**
 * The working directory a relay phase runs in: the intent's isolated worktree.
 *
 * `null` when the workspace is not in worktree mode, or the directory is not
 * there. Both are refusals, not fallbacks — a fix session pointed at the project
 * checkout would commit the PR's changes onto whatever branch happens to be
 * checked out there.
 */
function relayCwd(ctx: QueueActionContext, intentId: string): string | null {
  if (getGitBranchMode(ctx.workspacePath) !== 'worktree') return null
  const cwd = getWorktreePath(ctx.workspacePath, intentId)
  return worktreeExists(cwd) ? cwd : null
}
