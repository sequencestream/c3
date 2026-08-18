/**
 * Framing-free session launch service — extracts the intent session start logic
 * from both the WebSocket handlers (`start_development`, `write_spec`) into
 * core functions that both the WS adapters and the automation MCP tool adapter
 * call, so the two surfaces never drift.
 *
 * The core functions accept an optional progress callback (for WS →
 * {@link ServerToClient.dev_launch_progress} /
 * {@link ServerToClient.spec_launch_progress}), a {@link SessionLaunchDeps}
 * callback bag, and an optional actor name; they return a structured result
 * that the adapter translates into either an MCP `{content, isError}` or a WS
 * `{type:'error', error}` frame. Never sends to a connection itself — the
 * adapter does that.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { GitActionFailureGuidance, Intent, PromptImage } from '@ccc/shared/protocol'
import { findWriteBlockingDelivery } from '@ccc/shared'
import { ensureRuntime, getRuntime, isRunning } from '../../runs.js'
import type { SessionRuntime } from '../../runs.js'
import { loadHistory, sessionExists } from '../../sessions.js'
import {
  getDefaultMode,
  getDevSkill,
  getGitBranchMode,
  getSddEnabled,
} from '../../kernel/config/index.js'
import { setSessionAgent } from '../../kernel/agent-config/index.js'
import { sessionAgentTargetForRole } from '../sessions/agent-target.js'
import type { RunInject } from '../../kernel/run/prompt-delivery.js'
import {
  getIntent,
  getIntentSessionBySessionId,
  isStoreAvailable,
  listIntents,
  safeInsertIntentLog,
  setBranchName,
  setSpecPath,
} from './store.js'
import {
  clearPendingDevLink,
  registerPendingDevLink,
  releaseDevLaunch,
  tryClaimDevLaunch,
} from './dev-link.js'
import { clearPendingSpecLink, registerPendingSpecLink } from './spec-link.js'
import { clearPendingSpecReviewLink, registerPendingSpecReviewLink } from './spec-review-link.js'
import {
  claimSpecOccupancy,
  claimSpecReviewOccupancy,
  isSpecOccupancyAlive,
  releaseSpecOccupancy,
  releaseSpecReviewOccupancy,
} from './spec-occupancy.js'
import {
  buildSpecReviewPrompt,
  buildSpecReworkPrompt,
  readSpecFingerprint,
  specFingerprint,
} from './spec-review.js'
import { armSpecContentWatch } from './spec-content-watch.js'
import { buildDevPrompt } from './dev-prompt.js'
import {
  dependencyGateRejection,
  evaluateIntentDependencyGate,
  prepareSpecLaunch,
  syncPrStatusForVerdict,
} from './dependency-gate.js'
import {
  deliveryGateFacts,
  resolveSessionDeliveryContext,
  type DeliveryContextResult,
} from './delivery-context.js'
import {
  existingIntentSessionCwd,
  prepareIntentSessionWorktree,
  prepareIntentWorktreeBaseline,
  worktreeBaselineNotice,
  type WorktreeBaselineNotice,
} from './session-worktree.js'
import type { WorktreeBaselineDrift } from './worktree-baseline.js'
import { captureFastTurnBaseline } from './fast-spec.js'
import { buildContinueSpecPrompt, buildSeedSpec, buildSpecInstructPrompt } from './spec.js'
import { computeSpecLayout } from './spec-path.js'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'
import { pullCurrentBranch, readBranch } from './worktree.js'
import { hasPendingQuestion } from './turn-guards.js'
import { upsertPendingRow } from '../sessions/session-metadata-store.js'

/**
 * The continuation turn a resumed work session receives. Identical to what the
 * queue kernel sends on its own `resume` action, so a resume started by a human,
 * by an automation tool, or by the kernel is the same turn.
 */
const WORK_CONTINUE_PROMPT = 'continue'

// ── Types ──

/**
 * How a launch call reached its session.
 *
 * - `fresh`   — a brand-new session was created and its first turn fired.
 * - `resume`  — an existing session was continued in place (same id, no new
 *               worktree, no new session).
 * - `attach`  — the session was already running a turn: the caller only gets the
 *               id to hang a viewer on. NO second turn is sent — a run outlives
 *               a turn, so starting another one would double-drive the session.
 */
export type SessionLaunchMode = 'fresh' | 'resume' | 'attach'

export type SessionLaunchResult =
  | {
      success: true
      sessionId: string
      mode: SessionLaunchMode
      /**
       * The worktree this session runs in does not contain its baseline tip.
       * The launch happened anyway — falling behind a base branch is settled at
       * PR merge, not at launch — so this rides the SUCCESS result as a notice
       * the page turns into the two explicit repairs. Adapters with no UI (the
       * MCP tool surface, the queue) ignore it.
       */
      baselineNotice?: WorktreeBaselineNotice
    }
  | {
      success: false
      code: string
      params?: Record<string, string>
      /**
       * Targeted repair guidance for a failed Git action. Set only where a Git
       * command actually failed (worktree creation) — a gate rejection keeps its
       * own precise copy and carries none. Adapters that have no UI to show it
       * (the MCP tool surface) simply ignore the field.
       */
      guidance?: GitActionFailureGuidance
    }

export interface SessionLaunchDeps {
  readonly launchRun: (
    rt: SessionRuntime,
    prompt: string,
    images?: PromptImage[],
    inject?: RunInject,
  ) => Promise<void>
  readonly broadcastIntents: (workspacePath: string) => void
}

// ── Helpers ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The concurrency gate, evaluated here rather than only inside the
 * queue kernel's scheduling loop. Every caller that starts or continues a work
 * turn goes through this function, so the manual `start_development` button and
 * the automation `start_session_for_intent` tool share ONE gate instead of two —
 * an automation can no longer open a second concurrent work session just because
 * it entered through MCP.
 *
 * The gate exists to stop two work sessions from editing the same files, so its
 * scope follows the workspace's git branch mode:
 *
 * - `current-branch` — every intent develops in the one shared checkout, so any
 *   other intent's live work session blocks a new turn.
 * - `worktree` — each intent develops in its own directory, so another intent's
 *   live session shares no file with this one and never blocks it.
 *
 * A DANGLING session (on disk but not running) never blocks either way, and the
 * target intent's OWN running session is excluded: attaching to it is not a
 * second concurrent turn.
 */
export function findBlockingWorkSession(
  workspacePath: string,
  exceptIntentId: string,
): Intent | null {
  if (getGitBranchMode(workspacePath) === 'worktree') return null
  for (const other of listIntents(workspacePath)) {
    if (other.id === exceptIntentId) continue
    if (other.status !== 'in_progress') continue
    if (!other.lastWorkSessionId) continue
    if (isRunning(other.lastWorkSessionId)) return other
  }
  return null
}

/** Extra steering a work launch may carry from its caller. */
export interface WorkLaunchOptions {
  /**
   * The delivery this session develops against. Optional: an intent with zero or
   * exactly one association needs none. An intent with SEVERAL is refused unless
   * this says which — see `resolveSessionDeliveryContext`.
   */
  deliveryId?: string | null
  /**
   * One-shot FORCE RELEASE of the dependency gate. The dependency gate is advice
   * ("the output you depend on is probably not on your base"), not a physical
   * constraint, so a human who understands the risk may proceed. It skips ONLY
   * that gate — SDD approval, concurrency, delivery status and the worktree
   * baseline are all still evaluated — and it is never persisted: the next launch
   * (and every resume) evaluates the gate again from scratch. Never set by the
   * automation queue: an unattended path does not get to make this call.
   */
  forceDependencyGate?: boolean
}

/**
 * The admission gates every path that is ABOUT TO START a work turn must pass —
 * a fresh launch and a resume alike. Both call this one function so the rules
 * exist once: a second copy is how a resume ends up developing on a spec whose
 * approval was revoked, or on an intent whose dependency is not on its base.
 *
 * Fail-closed and in a fixed order:
 *
 *   1. SDD is on and the spec is not approved → `intent.specNotApproved`.
 *   2. An associated delivery is closed to new writes (`verifying` / `verified`
 *      / `delivered` / `cancelled`) → `intent.deliveryNotWritable`. Placed ahead
 *      of the dependency gate and mirrored by the queue kernel, so automation and
 *      the manual button cannot disagree about who may write.
 *   3. The dependency criterion, evaluated in THIS session's delivery context →
 *      the verdict's own rejection, plus the best-effort background PR status
 *      sync when a stale PR row is the likely cause.
 *
 * `forceDependencyGate` skips step 3 only, and only after it has been evaluated
 * — so the audit record says what was actually overridden.
 *
 * Returns the rejection to hand back, or `null` when the turn may proceed.
 * Attaching a viewer to an already-running turn is NOT a new admission and does
 * not come through here.
 */
function checkWorkAdmission(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  gate: { deliveryId: string | null; force?: boolean; actor?: string | null },
): SessionLaunchResult | null {
  // SDD quality gate — server-side, forced. The authoritative condition is the
  // spec STATUS: the compatibility boolean is never consulted here, so it can
  // never become a second way in when the two disagree.
  //
  // The ONE relaxation is per-intent `fast` mode: a fast intent may start a
  // MANUAL work turn without an approved spec — the spec is reverse-authored
  // from the turn's diff after it settles. Everything else below stays closed,
  // and the automation queue still requires `approved` regardless of mode.
  if (getSddEnabled(workspacePath) && intent.specStatus !== 'approved') {
    if (intent.effectiveSpecMode !== 'fast') {
      return { success: false, code: 'intent.specNotApproved' }
    }
  }

  const deliveries = deliveryGateFacts(workspacePath)

  // Delivery status gate: merging more code into a delivery that is being (or has
  // been) verified would invalidate the conclusion reached about a specific tree,
  // and a terminal delivery has nothing left to write into.
  const closed = findWriteBlockingDelivery(
    intent.linkedDeliveries.map((d) => d.id),
    deliveries,
  )
  if (closed) {
    return {
      success: false,
      code: 'intent.deliveryNotWritable',
      params: { deliveryTitle: closed.title, deliveryId: closed.id, status: closed.status },
    }
  }

  if (intent.dependsOn.length > 0) {
    const verdict = evaluateIntentDependencyGate({
      workspacePath,
      dependsOn: intent.dependsOn,
      sessionDeliveryId: gate.deliveryId,
      intents: listIntents(workspacePath),
      deliveries,
    })
    if (verdict.blocked) {
      if (!gate.force) {
        syncPrStatusForVerdict({
          verdict,
          workspacePath,
          dependsOn: intent.dependsOn,
          broadcastIntents: deps.broadcastIntents,
        })
        return { success: false, ...dependencyGateRejection(verdict) }
      }
      // Forced through: record WHAT was overridden, by whom. The gate stays the
      // authoritative fact — this log is the only trace that it was bypassed.
      safeInsertIntentLog(
        intent.id,
        'dependency_gate_force_release',
        `强制放行依赖闸门(${verdict.reason}):依赖「${verdict.dependency.title}」` +
          (verdict.delivery ? `,交付「${verdict.delivery.title}」` : ''),
        gate.actor ?? 'system',
      )
    }
  }

  return null
}

/**
 * The shared intent-directory preparation, in THIS service's failure shape:
 * resolve and fetch the baseline, refuse an existing worktree rooted elsewhere,
 * then create or reuse `getWorktreePath(workspace, intentId)`. All four session
 * kinds go through the same function in `session-worktree.ts` — a second copy is
 * how a spec session ends up reading a different branch than the work session.
 */
function prepareSessionCwd(
  workspacePath: string,
  intent: Intent,
  opts?: { deliveryId?: string | null },
):
  | { ok: true; cwd: string; branchName: string | null; notice: WorktreeBaselineNotice | null }
  | { ok: false; result: SessionLaunchResult } {
  const prepared = prepareIntentSessionWorktree(workspacePath, intent, opts)
  if (!prepared.ok) return { ok: false, result: { success: false, ...prepared.failure } }
  return {
    ok: true,
    cwd: prepared.prepared.cwd,
    branchName: prepared.prepared.branchName,
    notice: baselineNoticeOf(intent.id, prepared.prepared.baselineDrift),
  }
}

/** The baseline check alone, for the resume path that creates no directory. */
function baselineNoticeFor(
  workspacePath: string,
  intent: Intent,
  deliveryId: string | null,
): WorktreeBaselineNotice | null {
  const { drift } = prepareIntentWorktreeBaseline(workspacePath, intent, deliveryId)
  return baselineNoticeOf(intent.id, drift)
}

function baselineNoticeOf(
  intentId: string,
  drift: WorktreeBaselineDrift | null,
): WorktreeBaselineNotice | null {
  return drift ? worktreeBaselineNotice(intentId, drift) : null
}

/**
 * Attach to / resume the work session an `in_progress` intent already owns.
 * Mirrors {@link launchSpecSession}'s `specSessionId` handling so the two
 * session kinds stop behaving asymmetrically: a live intent is no longer
 * rejected with `intent.cannotStartDev` just because its session is healthy.
 *
 * Returns `null` when the intent owns no usable session — the caller then falls
 * through to the historic fresh / dangling-restart path.
 *
 * The delivery context is NOT re-resolved here: it is read back from the session
 * record written at fresh launch, so a resume develops against the same delivery
 * the session was started for even if the intent's associations changed since.
 * A session that predates the column reads back NULL, which is exactly what it
 * ran with — no context — so it too is reused rather than re-derived.
 */
async function attachOrResumeWorkSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  opts?: WorkLaunchOptions,
  actor?: string | null,
): Promise<SessionLaunchResult | null> {
  const sessionId = intent.lastWorkSessionId
  if (intent.status !== 'in_progress' || !sessionId) return null
  const live = getRuntime(sessionId) !== undefined
  if (!live && !(await sessionExists(workspacePath, sessionId))) return null

  // A turn is executing right now → attach only. The caller hangs a viewer on
  // the returned id; sending a second turn would double-drive the session.
  if (isRunning(sessionId)) {
    return { success: true, sessionId, mode: 'attach' }
  }

  // From here on we are about to start a NEW turn, so every hard gate applies.
  const blocking = findBlockingWorkSession(workspacePath, intent.id)
  if (blocking) {
    return {
      success: false,
      code: 'intent.concurrencyGate',
      params: { title: blocking.title },
    }
  }
  // An unanswered AskUserQuestion is a human decision point: the continuation
  // prompt must never stand in for the user's answer.
  const rt = getRuntime(sessionId)
  if (rt && hasPendingQuestion(rt.buffer)) {
    return { success: false, code: 'intent.pendingQuestionUnanswered' }
  }
  // The context this session was STARTED with, not one re-derived from today's
  // associations. A record whose `deliveryId` is NULL is an ANSWER — the session
  // ran with no delivery context, which is also what every session predating the
  // column ran with — so it is reused as-is even if the intent has since gained
  // associations. Only a MISSING record (session never registered here, or an
  // unreadable db) has no answer to reuse and falls back to resolution.
  const record = getIntentSessionBySessionId(sessionId, intent.id)
  let deliveryId = record?.deliveryId ?? null
  if (!record) {
    const resolved = resolveSessionDeliveryContext(workspacePath, intent, opts?.deliveryId)
    if (!resolved.ok) return { success: false, code: resolved.code }
    deliveryId = resolved.delivery?.id ?? null
  }

  // Resuming is a NEW admission, not a continuation of the old one: a spec whose
  // approval was revoked, or a dependency no longer on this session's base, stops
  // this turn exactly as it stops a fresh one. Evaluated before the runtime is
  // restored, so a rejected resume touches nothing.
  const denied = checkWorkAdmission(workspacePath, intent, deps, {
    deliveryId,
    force: opts?.forceDependencyGate,
    actor,
  })
  if (denied) return denied

  // Whether the worktree this session lives in still contains its baseline.
  // Never repaired silently — the two exits are explicit user actions — and
  // never a reason to refuse the turn either: a directory that fell behind its
  // base branch keeps developing, and the divergence is settled at PR merge.
  // A resume only CHECKS: the directory this session already ran in is reused as
  // it stands, and re-creating one that was cleaned up is not a continuation.
  const baselineNotice =
    getGitBranchMode(workspacePath) === 'worktree'
      ? baselineNoticeFor(workspacePath, intent, deliveryId)
      : null

  // A fast-mode resume is a NEW turn with a NEW baseline: capture the git HEAD
  // it resumes from, so the settle can measure only this turn's diff against it.
  if (getSddEnabled(workspacePath) && intent.effectiveSpecMode === 'fast') {
    void captureFastTurnBaseline(workspacePath, sessionId, intent.id)
  }

  // Restore the runtime if it was dropped (server restart / GC), then continue
  // the SAME session — no new worktree, no new session, no new pending link.
  progress?.('launching')
  if (!rt) {
    const isPending = sessionId.startsWith(PENDING_SESSION_PREFIX)
    const baseline = isPending ? [] : await loadHistory(workspacePath, sessionId).catch(() => [])
    const restored = ensureRuntime(
      sessionId,
      workspacePath,
      getDefaultMode(workspacePath),
      baseline,
      'work',
    )
    if (!restored.effectiveCwd) {
      restored.effectiveCwd = existingIntentSessionCwd(workspacePath, intent.id)
    }
  }

  try {
    void deps.launchRun(getRuntime(sessionId)!, WORK_CONTINUE_PROMPT).catch((err: unknown) => {
      progress?.('failed')
      console.warn(`[c3:intents] launchWorkSession (resume) async fail: ${errMsg(err)}`)
    })
  } catch (err) {
    console.warn(`[c3:intents] launchWorkSession (resume) sync fail: ${errMsg(err)}`)
  }
  return { success: true, sessionId, mode: 'resume', ...(baselineNotice ? { baselineNotice } : {}) }
}

// ── Work session launcher ──

/**
 * Launch, resume or attach to the work/development session of an intent.
 *
 * Resolution order (mirrors {@link launchSpecSession}'s `specSessionId` handling,
 * and the queue kernel's attach → resume → fresh precedence):
 *
 *   1. `in_progress` + a session that is running a turn → **attach**, same id.
 *   2. `in_progress` + a session that exists but is idle → **resume**, same id.
 *   3. `todo`, or `in_progress` whose session is gone → **fresh** (the historic
 *      status gate plus the git branch strategy).
 *
 * Before any NEW turn — fresh or resumed — the concurrency gate and
 * then {@link checkWorkAdmission} (SDD approval + delivery status + dependency)
 * are evaluated here, so the manual entry and the MCP entry share one gate chain
 * and a resume is admitted on today's facts rather than on the ones that admitted
 * the original launch. The concurrency gate's scope follows the git branch mode:
 * shared in `current-branch`, per-intent (and therefore never cross-blocking) in
 * `worktree`. **attach** sends no turn and is therefore not a new admission: it
 * passes none of these gates and gains no new rejection.
 *
 * A FRESH launch also resolves the session's DELIVERY CONTEXT first: it decides
 * the worktree baseline and the dependency reading, so it is settled before any
 * gate runs and travels with the pending link so the session record can keep it.
 * Returns a structured result — never throws for expected validation failures.
 */
export async function launchWorkSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  actor?: string | null,
  opts?: WorkLaunchOptions,
): Promise<SessionLaunchResult> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }

  if (!tryClaimDevLaunch(intentId)) {
    return { success: false, code: 'intent.devStartInFlight' }
  }
  const releaseClaim = (): void => releaseDevLaunch(intentId)

  const req = getIntent(intentId)
  if (!req) {
    releaseClaim()
    return { success: false, code: 'intent.notFound' }
  }

  // An `in_progress` intent whose session is still usable is attached to or
  // resumed in place — it is NOT a `cannotStartDev` rejection any more.
  const existing = await attachOrResumeWorkSession(workspacePath, req, deps, progress, opts, actor)
  if (existing) {
    releaseClaim()
    return existing
  }

  // Status gate: allow `todo`, or `in_progress` whose work session has gone missing.
  const dangling =
    req.status === 'in_progress' &&
    (!req.lastWorkSessionId || !(await sessionExists(workspacePath, req.lastWorkSessionId)))
  if (req.status !== 'todo' && !dangling) {
    releaseClaim()
    return { success: false, code: 'intent.cannotStartDev', params: { status: req.status } }
  }

  // The concurrency gate, applied before a fresh turn for the same reason it
  // applies before a resumed one.
  const blocking = findBlockingWorkSession(workspacePath, req.id)
  if (blocking) {
    releaseClaim()
    return { success: false, code: 'intent.concurrencyGate', params: { title: blocking.title } }
  }

  // The delivery context this session will develop against — resolved BEFORE the
  // gates, because both the dependency reading and the worktree baseline are
  // stated in terms of it. An intent linked to several deliveries is refused here
  // unless the caller named one: there is a real choice and only a human makes it.
  const context: DeliveryContextResult = resolveSessionDeliveryContext(
    workspacePath,
    req,
    opts?.deliveryId,
  )
  if (!context.ok) {
    releaseClaim()
    return { success: false, code: context.code }
  }
  const deliveryId = context.delivery?.id ?? null

  // SDD approval + delivery status + dependency gates — the SAME chain a resume
  // runs, from the one shared function, so the two entries can never drift apart.
  const denied = checkWorkAdmission(workspacePath, req, deps, {
    deliveryId,
    force: opts?.forceDependencyGate,
    actor,
  })
  if (denied) {
    releaseClaim()
    return denied
  }

  // The agent a fresh work session will bind: the default role, which may be a
  // group. Resolved BEFORE the git branch strategy runs — a refusal here must not
  // leave a worktree behind.
  const agentTarget = sessionAgentTargetForRole('default')
  if (!agentTarget.ok) {
    releaseClaim()
    return {
      success: false,
      code: 'agent.groupUnavailable',
      params: { group: agentTarget.groupRef },
    }
  }

  // ── Git branch strategy ──
  let effectiveCwd: string
  let baselineNotice: WorktreeBaselineNotice | null = null
  progress?.('fetching-base-branch')

  if (getGitBranchMode(workspacePath) === 'worktree') {
    // The baseline is the intent's persisted base branch. Resolving it also
    // fetches it, and NOTES when an existing worktree does not contain it — c3
    // never rebuilds or merges that worktree on its own, and never refuses the
    // launch over it either. The directory may already exist because this
    // intent's comm / spec / review session got there first; that is a reuse,
    // not a second worktree.
    progress?.('preparing-worktree')
    const prepared = prepareSessionCwd(workspacePath, req, { deliveryId })
    if (!prepared.ok) {
      releaseClaim()
      return prepared.result
    }
    effectiveCwd = prepared.cwd
    baselineNotice = prepared.notice
    // Only the WORK launch writes `branch_name`: it is a development fact (PR
    // head branch, the "still on main" warning), not a directory fact.
    if (prepared.branchName) setBranchName(req.id, prepared.branchName)
  } else {
    progress?.('preparing-worktree')
    const pull = pullCurrentBranch(workspacePath)
    if (!pull.ok) {
      releaseClaim()
      return {
        success: false,
        code: 'intent.pullFailed',
        params: { message: pull.message ?? '' },
      }
    }
    effectiveCwd = workspacePath
    const branch = readBranch(workspacePath)
    if (branch) setBranchName(req.id, branch)
  }

  // ── Create dev session ──
  const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const devRt = ensureRuntime(devId, workspacePath, getDefaultMode(workspacePath), [], 'work')
  devRt.effectiveCwd = effectiveCwd
  // A fast-mode FRESH turn starts from this git state: capture the baseline so
  // the settle can measure this turn's diff against it (see `fast-spec.ts`).
  if (getSddEnabled(workspacePath) && req.effectiveSpecMode === 'fast') {
    void captureFastTurnBaseline(workspacePath, devId, req.id)
  }
  // Both halves of the projection row come from the ONE resolution above: the
  // routing ref (a group stays a group ref, so each run re-failovers through its
  // members) paired with its representative member's vendor.
  const resolvedVendor = agentTarget.target.agent.vendor
  if (resolvedVendor === 'codex') {
    try {
      upsertPendingRow({
        pendingId: devId,
        workspacePath,
        vendor: resolvedVendor,
        agentId: agentTarget.target.ref,
        title: req.title,
        ownerKind: 'intent',
        ownerId: req.id,
      })
    } catch (err) {
      console.warn(`[c3:intents] work session projection write failed: ${errMsg(err)}`)
    }
  }

  // Build dev prompt (split system / visible / prefix). The intent's own effective
  // spec mode rides along: a `fast` turn skips the spec gate, so it must not be
  // handed the SDD work-session contract either.
  const devParts = buildDevPrompt({
    title: req.title,
    content: req.content,
    dependsOn: req.dependsOn,
    devSkill: getDevSkill(workspacePath),
    sddEnabled: getSddEnabled(workspacePath),
    effectiveSpecMode: req.effectiveSpecMode,
    specPath: req.specPath,
  })

  // Register pending→intent link and fire launcher. The delivery context rides
  // along so the `run:bound` handler can persist it with the session record.
  registerPendingDevLink(devId, req.id, deliveryId)
  progress?.('launching')

  try {
    void deps
      .launchRun(devRt, devParts.visible, undefined, {
        systemInstruction: devParts.systemInstruction,
        userTurnPrefix: devParts.userTurnPrefix,
      })
      .catch((err: unknown) => {
        clearPendingDevLink(devId)
        releaseClaim()
        progress?.('failed')
        console.warn(`[c3:intents] launchWorkSession async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingDevLink(devId)
    releaseClaim()
    console.warn(`[c3:intents] launchWorkSession sync fail: ${errMsg(err)}`)
  }

  return {
    success: true,
    sessionId: devId,
    mode: 'fresh',
    ...(baselineNotice ? { baselineNotice } : {}),
  }
}

// ── Spec session launcher ──

/** Extra steering for a spec-authoring launch. */
export interface SpecLaunchOptions {
  /**
   * The reviewer's findings from a `changes_requested` conclusion. When set, the
   * author is handed a REWORK brief (the findings verbatim) instead of a plain
   * "continue", and an intent that has a spec but has lost its authoring session
   * gets a fresh session bound to the EXISTING spec path rather than a scaffolded
   * new one — a rework must never orphan the document under review.
   */
  reworkReason?: string
  /** Which rework round this is, for the author's brief. */
  reworkRound?: number
}

/**
 * Launch a spec-authoring session for an intent. Resolution order:
 *   0. **In-flight pending** (`specSessionId` is a `pending:` id) — the launch
 *      already happened but the `run:bound` write has not arrived (or the
 *      process restarted inside the grace window). The caller attaches to it and
 *      starts nothing; a stale pending (past grace) is released and re-created.
 *   1. **Resume** (existing REAL `specSessionId`) — validate the session is not
 *      already running, restore the runtime if it was dropped, and re-launch with
 *      a continuation prompt (or the rework brief). Returns the existing id.
 *   2. **Re-author on an existing spec** (a `specPath` but no live authoring
 *      session, only under `reworkReason`) — a fresh session pointed at the spec
 *      that already exists. No scaffolding, so the reviewed document survives.
 *   3. **First-time** (neither) — scaffold the dated spec directory, seed
 *      spec.md, backfill `specPath`, and launch with the first-time prompt.
 *
 * Every path that starts a NEW session claims the authoring occupancy first
 * (conditional, owner-safe), so a concurrent launch of the same intent never
 * scaffolds or starts a second session. Every path runs the dependency gate.
 */
export async function launchSpecSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  actor?: string | null,
  opts?: SpecLaunchOptions,
): Promise<SessionLaunchResult> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }

  const intent = getIntent(intentId)
  if (!intent) return { success: false, code: 'intent.notFound' }

  // A REAL (bound) authoring session exists → resume it in place.
  if (intent.specSessionId && !intent.specSessionId.startsWith(PENDING_SESSION_PREFIX)) {
    return resumeSpecSession(workspacePath, intent, deps, progress, actor, opts)
  }

  // A `pending:` occupancy means a NEW authoring session is already being
  // launched — bind has not arrived yet, or the process restarted inside the
  // grace window. Never start a second one: attach to the in-flight session.
  if (intent.specSessionId) {
    const pendingId = intent.specSessionId
    if (isSpecOccupancyAlive(pendingId, isRunning, Date.now())) {
      return { success: true, sessionId: pendingId, mode: 'attach' }
    }
    // Stale (the launch died and the grace window expired): release it and
    // launch fresh below.
    releaseSpecOccupancy(intentId, pendingId)
  }

  // Rework on a spec whose authoring session is gone (authored manually, or the
  // link was lost): re-author IN PLACE. Scaffolding here would mint a second spec
  // file and silently detach the one the reviewer just judged.
  if (opts?.reworkReason && intent.specPath) {
    return createSpecSessionOnExistingPath(workspacePath, intent, deps, opts, progress)
  }

  // First-time: scaffold and launch new session
  return createFirstSpecSession(workspacePath, intent, deps, progress, actor)
}

/**
 * Service adapter over the shared {@link prepareSpecLaunch} gate: run the one
 * spec launch precondition and translate a block into THIS service's failure
 * shape. Returns `null` when the launch may proceed. The rule lives in
 * `dependency-gate.ts` — the manual WS entry runs the very same call behind its
 * own frame adapter, so the two can no longer drift.
 */
function specLaunchGateFailure(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
): SessionLaunchResult | null {
  const gate = prepareSpecLaunch({
    workspacePath,
    intent,
    broadcastIntents: deps.broadcastIntents,
    progress,
  })
  if (!gate.blocked) return null
  return { success: false, ...dependencyGateRejection(gate.verdict) }
}

/** Internal: create a FIRST spec session — scaffold the dated directory, write
 * the seed file, backfill specPath, log, broadcast, then launch the spec agent
 * with a first-time prompt. Sync (fire-and-forget launch).
 */
function createFirstSpecSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  actor?: string | null,
): SessionLaunchResult {
  const blocked = specLaunchGateFailure(workspacePath, intent, deps, progress)
  if (blocked) return blocked

  // The spec role's agent, resolved before the directory is scaffolded: a refusal
  // must not leave a seeded spec file and a backfilled `spec_path` behind.
  const specTarget = sessionAgentTargetForRole('spec')
  if (!specTarget.ok) {
    return {
      success: false,
      code: 'agent.groupUnavailable',
      params: { group: specTarget.groupRef },
    }
  }

  // Claim the authoring slot BEFORE any scaffolding: only one concurrent launch
  // may own it — the others attach to the winner and scaffold nothing. The
  // pending id doubles as the occupancy marker written into `spec_session_id`,
  // so the queue's probe and a subsequent bind both recognize this run.
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const claim = claimSpecOccupancy(intent.id, specId, {
    workspacePath,
    vendor: specTarget.target.agent.vendor,
    agentId: specTarget.target.ref,
    title: intent.title,
  })
  if (!claim.ok) {
    if (claim.owner) return { success: true, sessionId: claim.owner, mode: 'attach' }
    // The occupancy could not be registered (pending projection row unwritable):
    // report a failure rather than attach to a null owner — the queue retries on
    // a later tick, and the ledger was left untouched so nothing is stuck.
    return { success: false, code: 'intent.dbUnavailable' }
  }
  const releaseClaim = (): void => releaseSpecOccupancy(intent.id, specId)

  // The intent's directory — the code this spec is authored AGAINST. Resolved
  // before anything is scaffolded: a baseline refusal must not leave a seeded
  // spec file and a backfilled `spec_path` behind.
  const cwd = prepareSessionCwd(workspacePath, intent)
  if (!cwd.ok) {
    releaseClaim()
    return cwd.result
  }

  // Compute dated spec layout
  const specRoot = getSpecsBase(workspacePath)
  const layout = computeSpecLayout({
    specRoot,
    shortEnTitle: intent.shortEnTitle,
    intentId: intent.id,
    now: new Date(),
    listDay: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
  })

  // Scaffold directory + seed spec.md
  const seed = buildSeedSpec(intent, new Date().toISOString())
  try {
    mkdirSync(layout.dirAbs, { recursive: true })
    writeFileSync(layout.fileAbs, seed, 'utf8')
  } catch (err) {
    releaseClaim()
    return { success: false, code: 'intent.specWriteFailed', params: { message: errMsg(err) } }
  }

  // Backfill spec_path (as `raw` — a seed is not an authored spec) and broadcast.
  setSpecPath(intent.id, layout.fileAbs)
  // The baseline this run is measured against is the SEED itself, so an agent
  // that writes nothing leaves the intent `raw` instead of looking authored.
  armSpecContentWatch({
    intentId: intent.id,
    workspacePath,
    specPath: layout.fileAbs,
    fingerprint: specFingerprint(seed),
  })
  safeInsertIntentLog(intent.id, 'spec_created', '编写 spec', actor ?? 'system')
  deps.broadcastIntents(workspacePath)

  // Launch spec session. Two independent roots: the agent RUNS in the intent
  // worktree (that is the code it reads), and writes only into `specDir` — the
  // centralized spec root, which is not in the worktree and not in git.
  const rt = ensureRuntime(specId, workspacePath, getDefaultMode(workspacePath), [], 'spec')
  rt.effectiveCwd = cwd.cwd
  rt.specDir = layout.dirAbs
  setSessionAgent(specId, specTarget.target.ref)

  registerPendingSpecLink(specId, intent.id)

  try {
    void deps
      .launchRun(rt, buildSpecInstructPrompt(intent, layout.fileAbs, cwd.cwd))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        releaseClaim()
        progress?.('failed')
        console.warn(`[c3:intents] launchSpecSession (first) async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    releaseClaim()
    console.warn(`[c3:intents] launchSpecSession (first) sync fail: ${errMsg(err)}`)
  }

  return {
    success: true,
    sessionId: specId,
    mode: 'fresh',
    ...(cwd.notice ? { baselineNotice: cwd.notice } : {}),
  }
}

// ── Spec review session launcher ──

/**
 * Launch a strictly read-only review session for an intent's authored spec.
 *
 * Unlike {@link launchSpecSession} there is no resume path. A review is a
 * one-shot judgement of ONE document version: the fingerprint captured here binds
 * the conclusion, so continuing an old review session against changed content
 * would be judging two documents at once. Every review is therefore a fresh
 * session, and the previous one stays queryable under Works.
 *
 * Refuses — writing nothing — when there is no spec, when the spec is unreadable
 * (an unreadable spec is not an empty one), or when a review is already running
 * for this intent.
 */
export async function launchSpecReviewSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  _actor?: string | null,
): Promise<SessionLaunchResult> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }

  const intent = getIntent(intentId)
  if (!intent) return { success: false, code: 'intent.notFound' }
  if (!intent.specPath) return { success: false, code: 'intent.specNotWritten' }

  const reviewId = intent.specReviewSessionId
  // A review already running (real, or a live pending) → attach, never double.
  if (reviewId && isRunning(reviewId)) {
    return { success: true, sessionId: reviewId, mode: 'attach' }
  }
  // A `pending:` review occupancy that is still valid → the review is already
  // in flight (bind not arrived, or restart inside the grace window).
  if (reviewId && reviewId.startsWith(PENDING_SESSION_PREFIX)) {
    if (isSpecOccupancyAlive(reviewId, isRunning, Date.now())) {
      return { success: true, sessionId: reviewId, mode: 'attach' }
    }
    // Stale (the launch died, grace expired): release it and review fresh below.
    releaseSpecReviewOccupancy(intentId, reviewId)
  }

  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
  const fingerprint = readSpecFingerprint(workspacePath, intent.specPath)
  if (fingerprint === null) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  // The reviewer's agent, resolved before the runtime exists.
  const reviewTarget = sessionAgentTargetForRole('spec_review')
  if (!reviewTarget.ok) {
    return {
      success: false,
      code: 'agent.groupUnavailable',
      params: { group: reviewTarget.groupRef },
    }
  }

  // Claim the review slot before creating the runtime: a review is one-shot per
  // document version, so a new review replaces a finished previous one, but only
  // ONE concurrent launch may own the slot.
  const newReviewId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const claim = claimSpecReviewOccupancy(intent.id, newReviewId, {
    workspacePath,
    vendor: reviewTarget.target.agent.vendor,
    agentId: reviewTarget.target.ref,
    title: intent.title,
  })
  if (!claim.ok) {
    if (claim.owner) return { success: true, sessionId: claim.owner, mode: 'attach' }
    // The occupancy could not be registered (pending projection row unwritable):
    // report a failure — the ledger was left untouched so nothing is stuck.
    return { success: false, code: 'intent.dbUnavailable' }
  }
  const releaseClaim = (): void => releaseSpecReviewOccupancy(intent.id, newReviewId)

  // The reviewer checks the spec's claims against the SAME code the author read
  // — the intent's worktree on its base branch, not whatever the main checkout
  // happens to have checked out. Read-only either way: sharing the directory
  // does not widen the reviewer's tool gate.
  const cwd = prepareSessionCwd(workspacePath, intent)
  if (!cwd.ok) {
    releaseClaim()
    return cwd.result
  }

  progress?.('launching')
  const rt = ensureRuntime(
    newReviewId,
    workspacePath,
    getDefaultMode(workspacePath),
    [],
    'spec_review',
  )
  rt.effectiveCwd = cwd.cwd
  // Both facts are part of the security contract — `launchRun` throws without
  // them rather than binding an unbounded submit tool.
  rt.specReviewIntentId = intent.id
  rt.specReviewFingerprint = fingerprint
  setSessionAgent(newReviewId, reviewTarget.target.ref)

  registerPendingSpecReviewLink(newReviewId, intent.id)

  try {
    void deps
      .launchRun(rt, buildSpecReviewPrompt(intent, fileAbs, cwd.cwd))
      .catch((err: unknown) => {
        clearPendingSpecReviewLink(newReviewId)
        releaseClaim()
        progress?.('failed')
        console.warn(`[c3:intents] launchSpecReviewSession async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecReviewLink(newReviewId)
    releaseClaim()
    console.warn(`[c3:intents] launchSpecReviewSession sync fail: ${errMsg(err)}`)
  }

  return {
    success: true,
    sessionId: newReviewId,
    mode: 'fresh',
    ...(cwd.notice ? { baselineNotice: cwd.notice } : {}),
  }
}

/**
 * Internal: start a FRESH authoring session on an intent's EXISTING spec file.
 * Used only by the rework path when the original authoring session is gone —
 * everything about it mirrors {@link createFirstSpecSession} except that it
 * scaffolds nothing and leaves `spec_path` exactly as it was.
 */
function createSpecSessionOnExistingPath(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  opts: SpecLaunchOptions,
  progress?: (stage: string) => void,
): SessionLaunchResult {
  const blocked = specLaunchGateFailure(workspacePath, intent, deps, progress)
  if (blocked) return blocked

  const specTarget = sessionAgentTargetForRole('spec')
  if (!specTarget.ok) {
    return {
      success: false,
      code: 'agent.groupUnavailable',
      params: { group: specTarget.groupRef },
    }
  }

  // Claim the authoring slot before creating the runtime — a rework contends
  // for the SAME occupancy as a first-pass launch, so only one wins.
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const claim = claimSpecOccupancy(intent.id, specId, {
    workspacePath,
    vendor: specTarget.target.agent.vendor,
    agentId: specTarget.target.ref,
    title: intent.title,
  })
  if (!claim.ok) {
    if (claim.owner) return { success: true, sessionId: claim.owner, mode: 'attach' }
    // The occupancy could not be registered (pending projection row unwritable):
    // report a failure — the ledger was left untouched so nothing is stuck.
    return { success: false, code: 'intent.dbUnavailable' }
  }
  const releaseClaim = (): void => releaseSpecOccupancy(intent.id, specId)

  const cwd = prepareSessionCwd(workspacePath, intent)
  if (!cwd.ok) {
    releaseClaim()
    return cwd.result
  }

  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath!)
  armSpecContentWatch({
    intentId: intent.id,
    workspacePath,
    specPath: intent.specPath!,
    fingerprint: readSpecFingerprint(workspacePath, intent.specPath!),
  })
  const rt = ensureRuntime(specId, workspacePath, getDefaultMode(workspacePath), [], 'spec')
  rt.effectiveCwd = cwd.cwd
  rt.specDir = dirname(fileAbs)
  setSessionAgent(specId, specTarget.target.ref)

  registerPendingSpecLink(specId, intent.id)

  const prompt = buildSpecReworkPrompt(
    intent,
    fileAbs,
    opts.reworkReason ?? '',
    opts.reworkRound ?? intent.specReviewReworkRounds,
    cwd.cwd,
  )
  try {
    void deps.launchRun(rt, prompt).catch((err: unknown) => {
      clearPendingSpecLink(specId)
      releaseClaim()
      progress?.('failed')
      console.warn(
        `[c3:intents] launchSpecSession (rework, new session) async fail: ${errMsg(err)}`,
      )
    })
  } catch (err) {
    clearPendingSpecLink(specId)
    releaseClaim()
    console.warn(`[c3:intents] launchSpecSession (rework, new session) sync fail: ${errMsg(err)}`)
  }

  return {
    success: true,
    sessionId: specId,
    mode: 'fresh',
    ...(cwd.notice ? { baselineNotice: cwd.notice } : {}),
  }
}

/** Internal: RESUME an existing spec session. The intent already has
 * `specSessionId` set. Validates the session is not running, restores the
 * runtime if dropped, then re-launches with a continuation prompt — or, under
 * `opts.reworkReason`, the reviewer's findings as a rework brief. Returns the
 * existing session id (no new session created).
 */
async function resumeSpecSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  _actor?: string | null,
  opts?: SpecLaunchOptions,
): Promise<SessionLaunchResult> {
  if (!intent.specSessionId) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  // Gate: already running
  if (isRunning(intent.specSessionId)) {
    return { success: false, code: 'intent.specSessionRunning' }
  }

  if (!intent.specPath) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  const blocked = specLaunchGateFailure(workspacePath, intent, deps, progress)
  if (blocked) return blocked

  // A resume is a NEW turn, so it re-passes the directory admission: the same
  // intent worktree, still rooted on the same baseline. Reused, never rebuilt.
  const cwd = prepareSessionCwd(workspacePath, intent)
  if (!cwd.ok) return cwd.result

  // Restore runtime if it was dropped (server restart / GC)
  if (!getRuntime(intent.specSessionId)) {
    const isPending = intent.specSessionId.startsWith(PENDING_SESSION_PREFIX)
    const baseline = isPending
      ? []
      : await loadHistory(workspacePath, intent.specSessionId).catch(() => [])
    const restored = ensureRuntime(
      intent.specSessionId,
      workspacePath,
      getDefaultMode(workspacePath),
      baseline,
      'spec',
    )
    const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
    restored.specDir = dirname(fileAbs)
    // Re-pin the spec agent on a restored runtime (a group re-pins as its ref).
    // An unusable group leaves the existing binding alone — this is a resume, and
    // the launch below reports the real cause if it cannot run.
    const specTarget = sessionAgentTargetForRole('spec')
    if (specTarget.ok) setSessionAgent(intent.specSessionId, specTarget.target.ref)
  }
  // Set on the live runtime too, not just a freshly restored one: a session
  // reopened for VIEWING carries no launch cwd, and the turn about to run must
  // read code from the intent worktree either way.
  getRuntime(intent.specSessionId)!.effectiveCwd = cwd.cwd

  // Baseline for this turn's content check: a resumed session that writes nothing
  // must not promote the intent out of `raw`.
  armSpecContentWatch({
    intentId: intent.id,
    workspacePath,
    specPath: intent.specPath,
    fingerprint: readSpecFingerprint(workspacePath, intent.specPath),
  })

  // The turn: a plain continuation, or — after a `changes_requested` conclusion —
  // the reviewer's findings verbatim, so the author reworks against the actual
  // objection rather than a paraphrase of it.
  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
  const prompt = opts?.reworkReason
    ? buildSpecReworkPrompt(
        intent,
        fileAbs,
        opts.reworkReason,
        opts.reworkRound ?? intent.specReviewReworkRounds,
        cwd.cwd,
      )
    : buildContinueSpecPrompt(intent, fileAbs, cwd.cwd)

  // Re-launch — no new pending link needed (specSessionId is already set)
  try {
    void deps.launchRun(getRuntime(intent.specSessionId)!, prompt).catch((err: unknown) => {
      progress?.('failed')
      console.warn(`[c3:intents] launchSpecSession (resume) async fail: ${errMsg(err)}`)
    })
  } catch (err) {
    console.warn(`[c3:intents] launchSpecSession (resume) sync fail: ${errMsg(err)}`)
  }

  return {
    success: true,
    sessionId: intent.specSessionId,
    mode: 'resume',
    ...(cwd.notice ? { baselineNotice: cwd.notice } : {}),
  }
}
