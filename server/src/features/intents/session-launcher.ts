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
import type { Intent, PromptImage } from '@ccc/shared/protocol'
import { ensureRuntime, getRuntime, isRunning } from '../../runs.js'
import type { SessionRuntime } from '../../runs.js'
import { loadHistory, sessionExists } from '../../sessions.js'
import {
  getDefaultMainBranch,
  getDefaultMode,
  getDevSkill,
  getGitBranchMode,
  getSddEnabled,
} from '../../kernel/config/index.js'
import {
  getDefaultAgentId,
  resolveSessionVendor,
  resolveSpecAgent,
  resolveSpecReviewAgent,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import type { RunInject } from '../../kernel/run/prompt-delivery.js'
import {
  getIntent,
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
import { buildSpecReviewPrompt, buildSpecReworkPrompt, readSpecFingerprint } from './spec-review.js'
import { buildDevPrompt } from './dev-prompt.js'
import { findDependencyBlockingMainline } from './dependency-gate.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'
import { buildContinueSpecPrompt, buildSeedSpec, buildSpecInstructPrompt } from './spec.js'
import { computeSpecLayout } from './spec-path.js'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'
import {
  createWorktree,
  fetchRemoteBase,
  getWorktreePath,
  pullCurrentBranch,
  readBranch,
} from './worktree.js'
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
  | { success: true; sessionId: string; mode: SessionLaunchMode }
  | { success: false; code: string; params?: Record<string, string> }

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
 * The concurrency gate (RM-A12), evaluated here rather than only inside the
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

/**
 * Attach to / resume the work session an `in_progress` intent already owns.
 * Mirrors {@link launchSpecSession}'s `specSessionId` handling so the two
 * session kinds stop behaving asymmetrically: a live intent is no longer
 * rejected with `intent.cannotStartDev` just because its session is healthy.
 *
 * Returns `null` when the intent owns no usable session — the caller then falls
 * through to the historic fresh / dangling-restart path.
 */
async function attachOrResumeWorkSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
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

  // From here on we are about to start a NEW turn, so both hard gates apply.
  const blocking = findBlockingWorkSession(workspacePath, intent.id)
  if (blocking) {
    return {
      success: false,
      code: 'intent.concurrencyGate',
      params: { title: blocking.title },
    }
  }
  // An unanswered AskUserQuestion is a human decision point: the continuation
  // prompt must never stand in for the user's answer (RM-A11 / C-SEC-3).
  const rt = getRuntime(sessionId)
  if (rt && hasPendingQuestion(rt.buffer)) {
    return { success: false, code: 'intent.pendingQuestionUnanswered' }
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
      restored.effectiveCwd =
        getGitBranchMode(workspacePath) === 'worktree'
          ? getWorktreePath(workspacePath, intent.id)
          : workspacePath
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
  return { success: true, sessionId, mode: 'resume' }
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
 *      status gate, SDD approval gate, dependency gate and git branch strategy).
 *
 * Before any NEW turn — fresh or resumed — the concurrency gate (RM-A12) is
 * evaluated here, so the manual entry and the MCP entry share one gate. Its
 * scope follows the git branch mode: shared in `current-branch`, per-intent (and
 * therefore never cross-blocking) in `worktree`. Returns a structured result —
 * never throws for expected validation failures.
 */
export async function launchWorkSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  _actor?: string | null,
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
  const existing = await attachOrResumeWorkSession(workspacePath, req, deps, progress)
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

  // RM-A12 — the concurrency gate, applied before a fresh turn for the same
  // reason it applies before a resumed one.
  const blocking = findBlockingWorkSession(workspacePath, req.id)
  if (blocking) {
    releaseClaim()
    return { success: false, code: 'intent.concurrencyGate', params: { title: blocking.title } }
  }

  // SDD quality gate — server-side, forced.
  if (getSddEnabled(workspacePath) && !req.specApproved) {
    releaseClaim()
    return { success: false, code: 'intent.specNotApproved' }
  }

  // Dependency gate (worktree mode only)
  if (req.dependsOn.length > 0 && getGitBranchMode(workspacePath) === 'worktree') {
    const unmerged = findDependencyBlockingMainline(
      req.dependsOn,
      listIntents(workspacePath),
      getDefaultMainBranch(workspacePath),
    )
    if (unmerged) {
      syncUnconfirmedDependencyPrsInBackground({
        ctx: { broadcastIntents: deps.broadcastIntents },
        workspacePath,
        dependsOn: req.dependsOn,
      })
      releaseClaim()
      return {
        success: false,
        code: 'intent.dependencyNotMerged',
        params: { title: unmerged.title, id: unmerged.id },
      }
    }
  }

  // ── Git branch strategy ──
  let effectiveCwd: string
  progress?.('fetching-remote-main')

  if (getGitBranchMode(workspacePath) === 'worktree') {
    try {
      const baseBranch = getDefaultMainBranch(workspacePath)
      if (baseBranch?.trim()) fetchRemoteBase(workspacePath, baseBranch)
      progress?.('preparing-worktree')
      const wt = createWorktree(workspacePath, req.id, req.title, baseBranch)
      effectiveCwd = wt.worktreePath
      setBranchName(req.id, wt.branchName)
    } catch (err) {
      releaseClaim()
      return {
        success: false,
        code: 'intent.worktreeCreateFailed',
        params: { message: errMsg(err) },
      }
    }
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
  const resolvedVendor = resolveSessionVendor(devId)
  if (resolvedVendor === 'codex') {
    try {
      upsertPendingRow({
        pendingId: devId,
        workspacePath,
        vendor: resolvedVendor,
        agentId: getDefaultAgentId(),
        title: req.title,
        ownerKind: 'intent',
        ownerId: req.id,
      })
    } catch (err) {
      console.warn(`[c3:intents] work session projection write failed: ${errMsg(err)}`)
    }
  }

  // Build dev prompt (split system / visible / prefix)
  const devParts = buildDevPrompt({
    title: req.title,
    content: req.content,
    dependsOn: req.dependsOn,
    devSkill: getDevSkill(workspacePath),
    sddEnabled: getSddEnabled(workspacePath),
    specPath: req.specPath,
  })

  // Register pending→intent link and fire launcher
  registerPendingDevLink(devId, req.id)
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

  return { success: true, sessionId: devId, mode: 'fresh' }
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
 * Launch a spec-authoring session for an intent. Three sub-paths:
 *   1. **Resume** (existing `specSessionId`) — validate the session is not
 *      already running, restore the runtime if it was dropped, and re-launch with
 *      a continuation prompt (or the rework brief). Returns the existing id.
 *   2. **Re-author on an existing spec** (a `specPath` but no live authoring
 *      session, only under `reworkReason`) — a fresh session pointed at the spec
 *      that already exists. No scaffolding, so the reviewed document survives.
 *   3. **First-time** (neither) — scaffold the dated spec directory, seed
 *      spec.md, backfill `specPath`, and launch with the first-time prompt.
 *
 * Every path runs the dependency gate first.
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

  // If a spec session already exists → resume it
  if (intent.specSessionId) {
    return resumeSpecSession(workspacePath, intent, deps, progress, actor, opts)
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

/** A gate outcome that carries no session of its own: pass, or the caller's error result. */
type SpecGateResult = { ok: true } | { ok: false; result: SessionLaunchResult }

/**
 * Internal: prepare spec dependency context — dependency gate (worktree mode)
 * + pull current branch. Returns an error result on block, or `{ ok: true }`
 * to proceed. Sync (no I/O beyond the store read for dependencies).
 */
function prepareSpecDependencyContext2(
  workspacePath: string,
  intent: Intent,
  broadcastIntents: (path: string) => void,
  progress?: (stage: string) => void,
): SpecGateResult {
  if (getGitBranchMode(workspacePath) === 'worktree') {
    const blocking = findDependencyBlockingMainline(
      intent.dependsOn,
      listIntents(workspacePath),
      getDefaultMainBranch(workspacePath),
    )
    if (blocking) {
      syncUnconfirmedDependencyPrsInBackground({
        ctx: { broadcastIntents },
        workspacePath,
        dependsOn: intent.dependsOn,
      })
      return {
        ok: false,
        result: {
          success: false,
          code: 'intent.dependencyNotMerged',
          params: { title: blocking.title, id: blocking.id },
        },
      }
    }
  }
  progress?.('pulling-code')
  const pull = pullCurrentBranch(workspacePath)
  if (!pull.ok) {
    console.warn(`[c3:intents] spec session pull failed; continuing: ${pull.message ?? 'unknown'}`)
  }
  progress?.('launching')
  return { ok: true }
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
  const depCheck = prepareSpecDependencyContext2(
    workspacePath,
    intent,
    deps.broadcastIntents,
    progress,
  )
  if (!depCheck.ok) return depCheck.result

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
  try {
    mkdirSync(layout.dirAbs, { recursive: true })
    writeFileSync(layout.fileAbs, buildSeedSpec(intent, new Date().toISOString()), 'utf8')
  } catch (err) {
    return { success: false, code: 'intent.specWriteFailed', params: { message: errMsg(err) } }
  }

  // Backfill spec_path immediately and broadcast
  setSpecPath(intent.id, layout.fileAbs)
  safeInsertIntentLog(intent.id, 'spec_created', '编写 spec', actor ?? 'system')
  deps.broadcastIntents(workspacePath)

  // Launch spec session
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const specAgent = resolveSpecAgent()
  const rt = ensureRuntime(specId, workspacePath, getDefaultMode(workspacePath), [], 'spec')
  rt.specDir = layout.dirAbs
  setSessionAgent(specId, specAgent.id)

  try {
    upsertPendingRow({
      pendingId: specId,
      workspacePath,
      vendor: specAgent.vendor,
      agentId: specAgent.id,
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  } catch (err) {
    console.warn(`[c3:intents] spec session projection write failed: ${errMsg(err)}`)
  }

  registerPendingSpecLink(specId, intent.id)

  try {
    void deps
      .launchRun(rt, buildSpecInstructPrompt(intent, layout.fileAbs, workspacePath))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        progress?.('failed')
        console.warn(`[c3:intents] launchSpecSession (first) async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    console.warn(`[c3:intents] launchSpecSession (first) sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: specId, mode: 'fresh' }
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

  // A review already in flight for this intent → do not start a second one.
  if (intent.specReviewSessionId && isRunning(intent.specReviewSessionId)) {
    return { success: true, sessionId: intent.specReviewSessionId, mode: 'attach' }
  }

  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
  const fingerprint = readSpecFingerprint(workspacePath, intent.specPath)
  if (fingerprint === null) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  progress?.('launching')
  const reviewId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const reviewAgent = resolveSpecReviewAgent()
  const rt = ensureRuntime(
    reviewId,
    workspacePath,
    getDefaultMode(workspacePath),
    [],
    'spec_review',
  )
  // Both facts are part of the security contract — `launchRun` throws without
  // them rather than binding an unbounded submit tool.
  rt.specReviewIntentId = intent.id
  rt.specReviewFingerprint = fingerprint
  setSessionAgent(reviewId, reviewAgent.id)

  try {
    upsertPendingRow({
      pendingId: reviewId,
      workspacePath,
      vendor: reviewAgent.vendor,
      agentId: reviewAgent.id,
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  } catch (err) {
    console.warn(`[c3:intents] spec review session projection write failed: ${errMsg(err)}`)
  }

  registerPendingSpecReviewLink(reviewId, intent.id)

  try {
    void deps
      .launchRun(rt, buildSpecReviewPrompt(intent, fileAbs, workspacePath))
      .catch((err: unknown) => {
        clearPendingSpecReviewLink(reviewId)
        progress?.('failed')
        console.warn(`[c3:intents] launchSpecReviewSession async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecReviewLink(reviewId)
    console.warn(`[c3:intents] launchSpecReviewSession sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: reviewId, mode: 'fresh' }
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
  const depCheck = prepareSpecDependencyContext2(
    workspacePath,
    intent,
    deps.broadcastIntents,
    progress,
  )
  if (!depCheck.ok) return depCheck.result

  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath!)
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const specAgent = resolveSpecAgent()
  const rt = ensureRuntime(specId, workspacePath, getDefaultMode(workspacePath), [], 'spec')
  rt.specDir = dirname(fileAbs)
  setSessionAgent(specId, specAgent.id)

  try {
    upsertPendingRow({
      pendingId: specId,
      workspacePath,
      vendor: specAgent.vendor,
      agentId: specAgent.id,
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  } catch (err) {
    console.warn(`[c3:intents] spec session projection write failed: ${errMsg(err)}`)
  }

  registerPendingSpecLink(specId, intent.id)

  const prompt = buildSpecReworkPrompt(
    intent,
    fileAbs,
    opts.reworkReason ?? '',
    opts.reworkRound ?? intent.specReviewReworkRounds,
    workspacePath,
  )
  try {
    void deps.launchRun(rt, prompt).catch((err: unknown) => {
      clearPendingSpecLink(specId)
      progress?.('failed')
      console.warn(
        `[c3:intents] launchSpecSession (rework, new session) async fail: ${errMsg(err)}`,
      )
    })
  } catch (err) {
    clearPendingSpecLink(specId)
    console.warn(`[c3:intents] launchSpecSession (rework, new session) sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: specId, mode: 'fresh' }
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

  const depCheck = prepareSpecDependencyContext2(
    workspacePath,
    intent,
    deps.broadcastIntents,
    progress,
  )
  if (!depCheck.ok) return depCheck.result

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
    const specAgent = resolveSpecAgent()
    setSessionAgent(intent.specSessionId, specAgent.id)
  }

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
        workspacePath,
      )
    : buildContinueSpecPrompt(intent, fileAbs, workspacePath)

  // Re-launch — no new pending link needed (specSessionId is already set)
  try {
    void deps.launchRun(getRuntime(intent.specSessionId)!, prompt).catch((err: unknown) => {
      progress?.('failed')
      console.warn(`[c3:intents] launchSpecSession (resume) async fail: ${errMsg(err)}`)
    })
  } catch (err) {
    console.warn(`[c3:intents] launchSpecSession (resume) sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: intent.specSessionId, mode: 'resume' }
}
