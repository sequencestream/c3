/**
 * The PR review / fix relay: ONE execution core, TWO ways to ask for it.
 *
 * The kernel emits `launch_review` / `launch_fix` when the queue decides a phase
 * is due; a human can ask for the same phase through `start_intent_relay`. Both
 * arrive here, because the execution is not the part that differs — the agent
 * role, the intent's own worktree, the claim, the prompt, the tool allowlist and
 * the wall-clock bound are identical, and a second implementation of any of them
 * would be a second thing to keep true.
 *
 * What DOES differ is who is accountable for the attempt, and that difference is
 * confined to three points:
 *
 * - **admission** ({@link admitRelayPhase}) is synchronous and returns a typed
 *   refusal instead of acting on it, so the queue can book a failed attempt on
 *   its ladder while the handler can answer the caller's own connection;
 * - **provenance** — the queue's review round records that it owns the round
 *   ({@link recordQueueReviewClaim}), which is the only thing that can later
 *   turn an `approved` into merge authority; a manual round records nothing, so
 *   its approval writes a conclusion and grants no merge;
 * - **settlement** — the queue books success / failure on its ledger, a manual
 *   round releases the placeholder and stops there. A human retrying by hand is
 *   its own backoff.
 *
 * Four invariants the execution core carries, unchanged for both callers:
 * - a phase is claimed before it is launched. The conditional claim writes the
 *   session placeholder, the transient `pending` marker and (for a fix) the round
 *   counter in ONE guarded update, so a repeated request, a racing tick or a
 *   restart can never spend the convergence budget twice — and "already running"
 *   needs no second lock, because the claim itself refuses.
 * - a turn that ends is not a conclusion. Only `sync_intent_review_status` /
 *   `sync_intent_fix_status` conclude a phase; an exit, a crash, a timeout or a
 *   confident "done" in the transcript leaves the phase un-concluded and releases
 *   the placeholder.
 * - the agent identity is chosen once, at claim time, from the phase's role
 *   (`review` / `fix`) through the shared role-following rules. A settings change
 *   mid-flight never re-targets a running phase, and "no usable agent" is a loud
 *   failure — never a silent skip that would read as "review not needed".
 * - a fix runs in the intent's OWN worktree. There is no fallback to the project
 *   checkout: an unavailable worktree fails the attempt.
 *
 * Deliberately not here: in-flight bookkeeping and the cooldown pre-write (the
 * controller owns both), and any decision about WHETHER a phase may run (the
 * kernel owns the queue's, the shared phase criterion owns the human's).
 */
import { randomUUID } from 'node:crypto'
import type { Intent, IntentPr, VendorId } from '@ccc/shared/protocol'
import { activeIntentPrs } from '@ccc/shared'
import type { QueueAction, QueuePrIdentity } from '../../kernel/queue/index.js'
import { getGitBranchMode, getForgeOverride } from '../../kernel/config/index.js'
import { getForgePrLinkFacts } from '../../git.js'
import type { QueueActionContext, WorkflowHooks } from './queue-action-context.js'
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
import { runRelaySession, type RelaySessionOutcome } from '../automations/relay-session.js'
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
 * What a relay phase needs from whoever started it — the whole environment the
 * execution core touches, and nothing about the queue.
 *
 * Structural on purpose: a {@link QueueActionContext} satisfies it as it stands,
 * so the kernel's path passes its own context straight through, while the manual
 * handler builds the same two things (a workspace and a broadcast) without
 * standing up a controller it does not have.
 */
export interface RelayPhaseEnv {
  readonly workspacePath: string
  readonly hooks: Pick<WorkflowHooks, 'broadcastIntents'>
  /** The owning controller was disposed — unwind without further effects. */
  isDisposed(): boolean
}

/** Why a phase could not be claimed. Nothing is written for any of them. */
export type RelayAdmissionFailure =
  /** The phase's agent role resolves to a group with no usable member. */
  | { reason: 'agentUnavailable'; groupRef: string }
  /** Not worktree mode, or the intent's worktree directory is missing. */
  | { reason: 'worktreeUnavailable' }
  /** The intent holds no live PR anymore — the world moved, nothing to run on. */
  | { reason: 'noActivePr' }
  /** The conditional claim's projection row could not be written. */
  | { reason: 'projectionWriteFailed' }
  /** The claim's conditional check failed: another pass or a human moved first. */
  | { reason: 'stale' }

/** A relay phase that has been claimed and is ready to run. */
export interface ClaimedRelayPhase {
  phase: RelayPhase
  /**
   * The round this phase runs under, as the caller derived it: a review keeps
   * `reviewFixRounds`, a fresh fix takes the NEXT one. Carried rather than
   * re-read at execution time because the claim has already persisted it, and the
   * prompt must name the same round the ledger now holds.
   */
  round: number
  cwd: string
  /** The `pending:` placeholder now held in the phase's session field. */
  pendingId: string
  /** The live PRs the phase will work on, read at claim time. */
  prs: IntentPr[]
  vendor: VendorId
  agentId: string
}

export type RelayAdmission =
  { ok: true; claimed: ClaimedRelayPhase } | { ok: false; failure: RelayAdmissionFailure }

/**
 * Resolve the agent and the worktree, then claim the phase — the whole
 * synchronous prefix of a relay run. On success the occupancy is written and the
 * intent list is broadcast (the phase now reads as `pending` with a live
 * placeholder); on failure NOTHING was written, which is what lets a caller
 * retry the same request against a world that has since changed.
 *
 * Both refusals that can be diagnosed before the claim (no usable agent, no
 * worktree) are checked FIRST, because a claim is a durable write: writing one
 * and then discovering there is no agent to run would leave a phase occupied by
 * a session that was never going to exist.
 */
export function admitRelayPhase(
  env: RelayPhaseEnv,
  phase: RelayPhase,
  round: number,
  req: Intent,
): RelayAdmission {
  // The agent identity, resolved BEFORE anything is written. An empty role field
  // follows the workspace / system default exactly as every other role does; a
  // group with no usable member is a configuration error a human must see, so it
  // fails loudly instead of quietly skipping the phase.
  const target = sessionAgentTargetForRole(phase, env.workspacePath)
  if (!target.ok)
    return { ok: false, failure: { reason: 'agentUnavailable', groupRef: target.groupRef } }

  // The intent's own worktree. A fix must edit the PR's head branch, so there is
  // deliberately no fallback to the project checkout.
  const cwd = relayCwd(env.workspacePath, req.id)
  if (!cwd) return { ok: false, failure: { reason: 'worktreeUnavailable' } }

  const prs = activeIntentPrs(req.prs)
  // The PR list emptied since the caller looked. Nothing to review / fix: not a
  // failure of the request, just a world that moved.
  if (prs.length === 0) return { ok: false, failure: { reason: 'noActivePr' } }

  const pendingId = newRelayPendingId()
  const claim = claimRelayOccupancy(req.id, phase, pendingId, expectationFor(phase, round, req), {
    workspacePath: env.workspacePath,
    vendor: target.target.agent.vendor,
    agentId: target.target.ref,
    title: `${relayLabel(phase)}:${req.title}`,
  })
  if (!claim.ok) {
    return {
      ok: false,
      failure: {
        reason: claim.reason === 'projection-write-failed' ? 'projectionWriteFailed' : 'stale',
      },
    }
  }

  // The phase is now the ledger's truth; from here every exit must either bind a
  // real session or release the placeholder.
  env.hooks.broadcastIntents(env.workspacePath)

  return {
    ok: true,
    claimed: {
      phase,
      round,
      cwd,
      pendingId,
      prs,
      vendor: target.target.agent.vendor,
      agentId: target.target.ref,
    },
  }
}

/**
 * Run ONE claimed phase to completion and report how the session ended. Owns the
 * prompt, the tool surface, the wall-clock bound and the placeholder lifecycle —
 * everything that must be identical whichever entry point asked for the phase.
 *
 * `recordQueueProvenance` is the ONE branch, and it is the accountability
 * difference, not an execution one:
 *
 * - `true` (the queue's own round) pins the PR set the round is about to judge
 *   and registers the run in the trust registry. The pin is written NOW, before
 *   the agent can say anything, so an `approved` conclusion later has something
 *   to be checked against that no caller authored; the registry is what makes a
 *   tool call arriving on this execution provably the queue's run rather than a
 *   model's claim about itself.
 * - `false` (a human's round) writes neither. The round therefore CANNOT become a
 *   merge credential: authority to let c3 land a PR by itself is a fact about the
 *   queue having chosen to review, and a human clicking a button never said that.
 *   Leaving the run out of the registry is how that stays true even if a future
 *   reader of the registry forgets why it exists.
 *
 * A failed pin leaves no claim, which simply means the round grants no merge
 * authority; the review itself proceeds unchanged.
 */
export async function executeRelayPhase(
  env: RelayPhaseEnv,
  req: Intent,
  claimed: ClaimedRelayPhase,
  opts: { recordQueueProvenance: boolean },
): Promise<{ boundSessionId: string | null; outcome: RelaySessionOutcome }> {
  const { phase, cwd, pendingId, prs } = claimed
  const label = relayLabel(phase)

  if (opts.recordQueueProvenance && phase === 'review') {
    recordQueueReviewClaim({
      workspacePath: env.workspacePath,
      intentId: req.id,
      sessionId: pendingId,
      prs: await pinReviewedPrs(env.workspacePath, cwd, req),
    })
  }

  // The execution handle is minted HERE so the run can be registered before it
  // launches: a tool call may arrive on the very first turn, and a registry that
  // was populated afterwards would fail to attribute it.
  const executionId = opts.recordQueueProvenance ? randomUUID() : undefined
  if (executionId) {
    registerRelayRun(executionId, {
      intentId: req.id,
      phase,
      workspacePath: env.workspacePath,
      sessionId: pendingId,
    })
  }

  const prompt =
    phase === 'review'
      ? buildRelayReviewPrompt({
          intent: req,
          prs,
          round: claimed.round,
          sessionId: pendingId,
          cwd,
        })
      : buildRelayFixPrompt({ intent: req, prs, round: claimed.round, sessionId: pendingId, cwd })

  let boundSessionId: string | null = null
  let outcome: RelaySessionOutcome
  try {
    outcome = await runRelaySession({
      workspaceName: env.workspacePath,
      vendor: claimed.vendor,
      agentId: claimed.agentId,
      prompt,
      toolAllowlist: phase === 'review' ? RELAY_REVIEW_TOOL_ALLOWLIST : RELAY_FIX_TOOL_ALLOWLIST,
      cwd,
      maxWallClockMs: RELAY_MAX_WALL_CLOCK_MS,
      title: `${label}:${req.title}`,
      executionId,
      onSessionBound: (sessionId) => {
        boundSessionId = sessionId
        bindRelayOccupancy(req.id, phase, pendingId, sessionId)
        if (executionId) bindRelayRunSession(executionId, sessionId)
        if (opts.recordQueueProvenance && phase === 'review') {
          bindQueueReviewClaimSession(env.workspacePath, req.id, pendingId, sessionId)
        }
        env.hooks.broadcastIntents(env.workspacePath)
      },
    })
  } finally {
    // The registry answers "is this live call the queue's run?", so a run that has
    // ended must stop answering it — on every path, including a throw.
    if (executionId) unregisterRelayRun(executionId)
  }

  return { boundSessionId, outcome }
}

/**
 * Run ONE relay phase for an intent the QUEUE owns, from claim to settlement.
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
  const label = relayLabel(phase)

  const admission = admitRelayPhase(ctx, phase, action.round, req)
  if (!admission.ok) {
    reportQueueRefusal(ctx, req, label, admission.failure)
    return
  }

  const { boundSessionId, outcome } = await executeRelayPhase(ctx, req, admission.claimed, {
    recordQueueProvenance: true,
  })

  if (ctx.isDisposed()) return
  settleRelayPhase(ctx, req, phase, label, admission.claimed.pendingId, boundSessionId, outcome)
}

/**
 * Run ONE relay phase for a HUMAN's request, from a claim that already happened.
 *
 * Same execution as the queue's, with the accountability difference applied at
 * both ends: no provenance is recorded (so an approval here can never become a
 * merge credential), and the settlement books nothing on the queue's ladder. A
 * failure that happens after the claim reaches the user through the intent and
 * the session UI, never as a late error frame on a connection that has long since
 * been answered.
 */
export async function runManualRelayPhase(
  env: RelayPhaseEnv,
  req: Intent,
  claimed: ClaimedRelayPhase,
): Promise<void> {
  const { boundSessionId } = await executeRelayPhase(env, req, claimed, {
    recordQueueProvenance: false,
  })
  settleManualRelayPhase(env, req, claimed, boundSessionId)
}

/** Record a relay phase's refusal on the queue's own accounting. */
function reportQueueRefusal(
  ctx: QueueActionContext,
  req: Intent,
  label: string,
  failure: RelayAdmissionFailure,
): void {
  switch (failure.reason) {
    case 'agentUnavailable':
      recordFailure(
        ctx,
        req.id,
        'launch_failed',
        `${label} Agent 不可用:Agent 组「${failure.groupRef}」没有可用成员`,
      )
      return
    case 'worktreeUnavailable':
      recordFailure(ctx, req.id, 'launch_failed', `${label} 无法执行:意图 worktree 不可用`)
      return
    case 'projectionWriteFailed':
      recordFailure(ctx, req.id, 'launch_failed', `${label} 占位投影不可写,本轮未启动`)
      return
    case 'noActivePr':
      // The PR list emptied between the kernel's snapshot and this executor.
      // Nothing to review: a world that moved, not a failed attempt.
      ctx.requestPass()
      return
    case 'stale':
      // Another pass, a human backfill or a settled phase moved the facts.
      // Re-reconcile against what actually holds now.
      console.log(`[c3:queue]「${req.title}」${label} 阶段前置事实已变化,本轮不启动`)
      ctx.requestPass()
      return
  }
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
 * Decide what a finished QUEUE relay turn actually achieved, and record it.
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
  outcome: RelaySessionOutcome,
): void {
  if (relayConcluded(req.id, phase)) {
    recordSuccess(ctx, req.id)
    ctx.hooks.broadcastIntents(ctx.workspacePath)
    console.log(`[c3:queue]「${req.title}」${label} 结论已回填:` + freshConclusion(req.id, phase))
    return
  }

  releaseRelayPlaceholder(req.id, phase, pendingId, boundSessionId)
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
 * Decide what a finished HUMAN relay turn achieved — the same evidence, without
 * the queue's accounting.
 *
 * A conclusion needs nothing from us: the `sync_intent_*` tool that wrote it has
 * already broadcast. Anything else releases the placeholder (owner-safe, so a
 * late callback can never clobber a newer phase's session) so the phase reads as
 * un-started again and the button comes back. The ROUND is deliberately untouched
 * — recovering a phase must not refund convergence budget — and the failure
 * ladder is deliberately untouched too: a human retrying by hand IS the backoff,
 * and the queue's `failureCount` / `backoffUntil` / `parked` describe the queue's
 * own unattended attempts, which this was never one of.
 */
export function settleManualRelayPhase(
  env: RelayPhaseEnv,
  req: Intent,
  claimed: ClaimedRelayPhase,
  boundSessionId: string | null,
): void {
  const label = relayLabel(claimed.phase)
  if (relayConcluded(req.id, claimed.phase)) {
    console.log(
      `[c3:manual-relay]「${req.title}」${label} 结论已回填:` +
        freshConclusion(req.id, claimed.phase),
    )
    return
  }
  releaseRelayPlaceholder(req.id, claimed.phase, claimed.pendingId, boundSessionId)
  env.hooks.broadcastIntents(env.workspacePath)
  console.log(`[c3:manual-relay]「${req.title}」${label} 会话已结束但未回填结论,占位已释放`)
}

/** Whether the ledger now holds a terminal for this phase — the ONLY evidence. */
function relayConcluded(intentId: string, phase: RelayPhase): boolean {
  const fresh = getIntent(intentId)
  return phase === 'review'
    ? fresh?.reviewStatus === 'approved' || fresh?.reviewStatus === 'rejected'
    : fresh?.fixStatus === 'fixed'
}

/** The conclusion just read back, for the log line. */
function freshConclusion(intentId: string, phase: RelayPhase): string {
  const fresh = getIntent(intentId)
  return String(phase === 'review' ? fresh?.reviewStatus : fresh?.fixStatus)
}

/**
 * Release the phase's placeholder — owner-safe against whichever id the phase
 * ended up holding. When the vendor bound a real session the field holds that,
 * and the `pending:` row (which the bind left behind as history) is cleared
 * separately; releasing only the current owner is what keeps a newer phase's
 * occupancy safe from a late callback.
 */
function releaseRelayPlaceholder(
  intentId: string,
  phase: RelayPhase,
  pendingId: string,
  boundSessionId: string | null,
): void {
  releaseRelayOccupancy(intentId, phase, boundSessionId ?? pendingId)
  if (boundSessionId) releaseRelayOccupancy(intentId, phase, pendingId)
}

/**
 * The facts a claim must still find, derived from the request that asked for it.
 *
 * A review claim keeps the round where it is and clears the fix marker; a fix
 * claim either takes the NEXT round (a fresh `rejected`) or re-enters the one it
 * already took (a `pending` fix whose session died). `round` is the caller's
 * decision and both callers derive it the same way — the queue's kernel from its
 * own phase derivation, the manual handler from the shared phase criterion — so
 * reading the expectation off the intent the caller was handed is what makes the
 * claim a genuine compare-and-set.
 */
function expectationFor(phase: RelayPhase, round: number, req: Intent): RelayClaimExpectation {
  if (phase === 'review') {
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
    nextRounds: round,
  }
}

/** The human-facing name of a phase, used in session titles and log lines. */
function relayLabel(phase: RelayPhase): string {
  return phase === 'review' ? 'PR 评审' : 'PR 修复'
}

/**
 * The working directory a relay phase runs in: the intent's isolated worktree.
 *
 * `null` when the workspace is not in worktree mode, or the directory is not
 * there. Both are refusals, not fallbacks — a fix session pointed at the project
 * checkout would commit the PR's changes onto whatever branch happens to be
 * checked out there.
 */
function relayCwd(workspacePath: string, intentId: string): string | null {
  if (getGitBranchMode(workspacePath) !== 'worktree') return null
  const cwd = getWorktreePath(workspacePath, intentId)
  return worktreeExists(cwd) ? cwd : null
}
