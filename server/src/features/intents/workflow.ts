/**
 * Automation orchestrator — a per-project event-driven state machine that
 * develops `automate` intents one at a time, by priority then dependency order,
 * fully unattended.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 * The orchestrator is **event-driven**: `run:settled` events from the resident
 * domain subscription (`wiring/run-domain-subscriptions.ts`) drive state
 * transitions instead of an internal await loop (`run()` was removed in the
 * event-driven refactor, 2026-06-08). The resident subscription matches the
 * settled session to an intent's `lastWorkSessionId`, then calls
 * `notifyTurnSettled()` — this module's single entry point from the bus.
 *
 * Internal state:
 *  - `developing` — a dev turn is in-flight for the current intent.
 *  - `awaiting_gate` — the concurrency gate is active (a non-automate manual
 *    run is still going); the controller defers `startNext` until it clears.
 *  - `fixing`   — a lint-fix agent turn was launched after `commitAndPush`
 *    was blocked by a pre-commit hook; awaiting that turn's settle.
 *  - `error`    — the loop stopped on a non-recoverable failure.
 *  - `done`     — all eligible intents are completed.
 *  - `idle`     — not started or stopped by the user.
 *
 * Concurrency: the global gate (RM-A12) is checked BEFORE launching each new
 * intent. If any non-automate intent's work session is truly running (isRunning
 * returns true), the controller defers via `_pendingIntentId` and waits for
 * the blocking session's settle to re-trigger `notifyTurnSettled`. This is the
 * event-driven analogue of the old `awaitProjectRunning` loop.
 *
 * One controller per project (module-level Map). State survives connection
 * churn; it does NOT survive a server restart (in-memory).
 */
import { randomUUID } from 'node:crypto'
import type {
  WorkflowStatus,
  Intent,
  GenericEvent,
  GenericEventEnvelope,
  RunEndReason,
  ServerToClient,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import {
  getIntent,
  listIntents,
  setBranchName,
  setLastWorkSession,
  setPrInfo,
  updateStatus,
} from './store.js'
import { registerPendingDevLink } from './dev-link.js'
import { buildDevPrompt } from './dev-prompt.js'
import { publishIntentLifecycle, publishIntentStatusTransition } from './lifecycle-events.js'
import { judgeCompletion } from './judge.js'
import { runCheckpointConsensus } from './checkpoint-consensus.js'
import { commitAndPush, createForgePr, gitDiffStat, gitRecentLog } from '../../git.js'
import { runServerSidePrCreate } from '../pr-events/tool-defs.js'
import { pathToId } from '../../state.js'
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
import {
  depsWithUnconfirmedPr,
  syncUnconfirmedDependencyPrsInBackground,
} from './pr-status-sync.js'

// ---------------------------------------------------------------------------
// Public types (unchanged)
// ---------------------------------------------------------------------------

export interface DevTurnResult {
  outcome: 'complete' | 'error' | 'blocked'
  sessionId: string
  lastMessage: string
  detail?: string
  pendingQuestion?: boolean
}

export interface RunDevTurnInput {
  workspacePath: string
  sessionId: string | null
  /** The visible turn text echoed to the client (intent body / `continue` / fix note). */
  prompt: string
  /**
   * A slash-command dev skill (e.g. `/dev `) to lead the MODEL user turn on the
   * launch turn; never echoed (hide-session-system-instructions). Omitted on
   * continuation / fix turns and when no devSkill is configured.
   */
  userTurnPrefix?: string
  /**
   * Internal work-session instruction for the launch turn; delivered through the
   * vendor instruction channel and never echoed.
   */
  systemInstruction?: string
  intentId: string
  signal: AbortSignal
  attach?: boolean
  onSessionId?: (sessionId: string) => void
  onAwaitingPermission?: (awaiting: boolean) => void
}

export interface WorkflowHooks {
  runDevTurn(input: RunDevTurnInput): Promise<DevTurnResult>
  broadcastIntents(workspacePath: string): void
  emitStatus(status: WorkflowStatus): void
  sessionExists(workspacePath: string, sessionId: string): Promise<boolean>
  isRunning(sessionId: string): boolean
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Publish a normalized generic event (envelope) onto the kernel event bus. */
  publishEvent: (payload: GenericEventEnvelope) => void
}

// ---------------------------------------------------------------------------
// Module-level state (the hooks bag, wired once by the composition root)
// ---------------------------------------------------------------------------

let injectedHooks: WorkflowHooks | null = null

export function setWorkflowHooks(hooks: WorkflowHooks): void {
  injectedHooks = hooks
}

export function getWorkflowHooks(): WorkflowHooks {
  if (!injectedHooks) throw new Error('[c3] automation hooks not wired (setWorkflowHooks)')
  return injectedHooks
}

// ---------------------------------------------------------------------------
// Pending-question detection (unchanged)
// ---------------------------------------------------------------------------

export function hasPendingQuestion(buffer: readonly ServerToClient[]): boolean {
  const answered = new Set<string>()
  for (const e of buffer) {
    if (e.type === 'tool_result') answered.add(e.toolUseId)
  }
  for (const e of buffer) {
    if (e.type === 'tool_use' && e.toolName === 'AskUserQuestion' && !answered.has(e.toolUseId)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Controller — event-driven FSM per project
// ---------------------------------------------------------------------------

const MAX_CONTINUATIONS = 10

function idleStatus(workspacePath: string): WorkflowStatus {
  return {
    workspaceId: pathToId(workspacePath)!,
    state: 'idle',
    currentIntentId: null,
    currentSessionId: null,
    awaitingPermission: false,
    error: null,
    completedIds: [],
    startedAt: null,
    checkpointConsensus: null,
  }
}

/** @internal exported for testing only */
export function pickNext(workspacePath: string): Intent | null {
  const all = listIntents(workspacePath)
  const byId = new Map(all.map((r) => [r.id, r]))
  const gitBranchMode = getGitBranchMode(workspacePath)
  const sddEnabled = getSddEnabled(workspacePath)
  const eligible = all.filter(
    (r) =>
      r.automate &&
      (r.status === 'todo' || r.status === 'in_progress') &&
      (!sddEnabled || r.specApproved) &&
      r.dependsOn.every((id) => {
        const dep = byId.get(id)
        if (!dep) return true
        if (dep.status !== 'done') return false
        // Worktree mode: dependency code must be merged to main branch
        if (gitBranchMode === 'worktree' && dep.prStatus !== 'merged') return false
        return true
      }),
  )
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const
  eligible.sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt)
  return eligible[0] ?? null
}

function blockedWorkflowDependencyIds(workspacePath: string): string[] {
  if (getGitBranchMode(workspacePath) !== 'worktree') return []
  const all = listIntents(workspacePath)
  const byId = new Map(all.map((r) => [r.id, r]))
  const sddEnabled = getSddEnabled(workspacePath)
  const ids = new Set<string>()
  for (const intent of all) {
    if (!intent.automate) continue
    if (intent.status !== 'todo' && intent.status !== 'in_progress') continue
    if (sddEnabled && !intent.specApproved) continue
    const deps = intent.dependsOn.map((id) => byId.get(id))
    if (deps.some((dep) => dep && dep.status !== 'done')) continue
    for (const dep of depsWithUnconfirmedPr(intent.dependsOn, all)) ids.add(dep.id)
  }
  return [...ids]
}

class WorkflowController {
  readonly status: WorkflowStatus
  private readonly abort = new AbortController()

  /** Re-entrancy guard: true while an async settle chain is in flight. */
  private _processing = false
  /** Resolves when the current async settle processing completes (tests). */
  private _processingPromise: Promise<void> | null = null
  /** Continuation turns remaining for the current intent. */
  private _continuationCount = 0
  /** Deferred next-intent when the concurrency gate is active. */
  private _pendingIntentId: string | null = null
  /** Development phase — normal turn vs lint-fix agent turn. */
  private _phase: 'normal' | 'fixing' = 'normal'

  constructor(
    private readonly workspacePath: string,
    private readonly hooks: WorkflowHooks,
    startedAt: number,
  ) {
    this.status = {
      ...idleStatus(workspacePath),
      state: 'running',
      startedAt,
    }
  }

  // ── Public entry points ───────────────────────────────────────────────

  /**
   * Called by the resident `run:settled` subscription (via `notifyTurnSettled`)
   * when a session matching an intent's `lastWorkSessionId` just settled.
   *
   * Two cases:
   *  1. `intentId === this.status.currentIntentId` → the current developing
   *     or repair turn settled; drive the FSM.
   *  2. Otherwise → a blocking manual/intent settle that may clear the
   *     concurrency gate. If `_pendingIntentId` is set, re-check and launch.
   */
  onTurnSettled(sessionId: string, reason: RunEndReason, intentId: string): void {
    // ── Case 1: our current developing / repair turn ──
    if (intentId === this.status.currentIntentId) {
      if (this._processing) {
        console.warn(`[c3:automation] skip settle — already processing turn for intent ${intentId}`)
        return
      }
      this.status.currentSessionId = sessionId
      this._processing = true
      this.emit()

      if (this._phase === 'fixing') {
        this._processingPromise = this._handleFixTurnSettled(intentId, sessionId)
      } else {
        this._processingPromise = this._processTurnResult(intentId, sessionId, reason)
      }
      return
    }

    // ── Case 2: not our turn — concurrency gate check ──
    if (this._pendingIntentId) {
      const blocking = this._findBlockingIntent()
      if (!blocking) {
        // Gate cleared! Launch the deferred intent.
        this._pendingIntentId = null
        this.status.state = 'running'
        this.status.currentIntentId = null
        this.status.currentSessionId = null
        this.emit()
        this._startNext()
      }
      // Gate still active — stay in awaiting_gate.
    }
  }

  /** Cancel the controller (user stopped automation). */
  stop(): void {
    this.abort.abort()
    this._pendingIntentId = null
    this.status.state = 'idle'
    this.status.currentIntentId = null
    this.status.currentSessionId = null
    this.status.checkpointConsensus = null
    this._processing = false
    this.emit()
  }

  // ── Initial kick-start (called by startWorkflow) ───────────────────

  /** Launch the first eligible intent. Fire-and-forget. */
  kickstart(): void {
    this._startNext()
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private emit(): void {
    this.hooks.emitStatus({ ...this.status, completedIds: [...this.status.completedIds] })
  }

  private setAwaiting(awaiting: boolean): void {
    if (this.status.awaitingPermission === awaiting) return
    this.status.awaitingPermission = awaiting
    this.emit()
  }

  /**
   * Link the work session + flip the intent to in_progress, then broadcast.
   * Called from `_launchDevelopment` for the attach/resume cases where the
   * `run:bound`-driven pendingDevLink does not apply (session already real).
   */
  private markInProgress(reqId: string, sessionId: string): void {
    setLastWorkSession(reqId, sessionId)
    const req = getIntent(reqId)
    if (req?.status !== 'in_progress') {
      updateStatus(reqId, 'in_progress')
      if (req) publishIntentStatusTransition(this.workspacePath, req, req.status, 'in_progress')
    }
    this.status.currentSessionId = sessionId
    this.hooks.broadcastIntents(this.workspacePath)
    this.emit()
  }

  private fail(reason: string): void {
    console.warn(`[c3:automation] 停止 (${this.workspacePath}): ${reason}`)
    const req = this.status.currentIntentId ? getIntent(this.status.currentIntentId) : null
    this.status.state = 'error'
    this.status.error = reason
    this.status.currentIntentId = null
    this.status.currentSessionId = null
    if (req) publishIntentLifecycle(this.workspacePath, req, 'failed')
    this._processing = false
    this.emit()
  }

  /**
   * Find a non-automate intent whose work session is truly running (RM-A12).
   * Returns the blocking intent, or undefined if the gate is clear.
   */
  private _findBlockingIntent(): Intent | undefined {
    const all = listIntents(this.workspacePath)
    return all.find(
      (r) =>
        r.status === 'in_progress' &&
        !!r.lastWorkSessionId &&
        this.hooks.isRunning(r.lastWorkSessionId),
    )
  }

  /**
   * The git working directory for an intent's commit/push/PR/evidence ops:
   * the isolated worktree in `worktree` mode, else the project checkout itself
   * (`current-branch`). Deterministic from (workspacePath, intentId) — mirrors the
   * manual `startDevelopment` effectiveCwd choice so both paths target the same
   * tree. Without this, worktree-mode git ops would run on the main checkout
   * (stuck on the base branch), so the branch never reaches the remote.
   */
  private _gitCwd(intentId: string): string {
    if (getGitBranchMode(this.workspacePath) === 'worktree') {
      return getWorktreePath(this.workspacePath, intentId)
    }
    return this.workspacePath
  }

  // ── Intent selection & launch ─────────────────────────────────────────

  /**
   * Pick the next eligible intent and launch it (or defer if the concurrency
   * gate is active). Fire-and-forget.
   */
  private _startNext(): void {
    if (this.abort.signal.aborted) return

    const req = pickNext(this.workspacePath)
    if (!req) {
      const blockedDepIds = blockedWorkflowDependencyIds(this.workspacePath)
      if (blockedDepIds.length > 0) {
        syncUnconfirmedDependencyPrsInBackground({
          ctx: {
            broadcastIntents: this.hooks.broadcastIntents,
          },
          workspacePath: this.workspacePath,
          dependsOn: blockedDepIds,
          onComplete: () => {
            if (!this.abort.signal.aborted && this.status.state !== 'idle') this._startNext()
          },
        })
        this.status.state = 'running'
        this.status.currentIntentId = null
        this.status.currentSessionId = null
        this.status.checkpointConsensus = null
        this._processing = false
        this.emit()
        return
      }
      this.status.state = 'done'
      this.status.currentIntentId = null
      this.status.currentSessionId = null
      this.status.checkpointConsensus = null
      this._processing = false
      this.emit()
      return
    }

    // Concurrency gate (RM-A12): if any manual intent's session is truly
    // running, defer until it settles.
    const blocking = this._findBlockingIntent()
    if (blocking) {
      this._pendingIntentId = req.id
      this.status.state = 'awaiting_gate'
      this.status.currentIntentId = blocking.id // show what's blocking
      this.status.currentSessionId = blocking.lastWorkSessionId!
      this.emit()
      console.log(
        `[c3:automation] 全局并发闸门:「${blocking.title}」的 work session 仍在运行,等待 turn settle`,
      )
      return
    }

    this._pendingIntentId = null
    this._launchDevelopment(req)
  }

  /**
   * Launch a development turn for the given intent (fresh, resume, or attach).
   * Determines the right session strategy internally and fires off `runDevTurn`.
   * Fire-and-forget (async internally; errors caught and surfaced via fail()).
   */
  private _launchDevelopment(req: Intent): void {
    // Kick off async work and handle errors inline (no caller awaits this).
    void this._launchDevAsync(req).catch((err) => {
      console.error(`[c3:automation] intent ${req.id} 启动失败:`, err)
      this.fail(`「${req.title}」启动开发失败: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Async body of {@link _launchDevelopment} — split so errors can be caught. */
  private async _launchDevAsync(req: Intent): Promise<void> {
    this._phase = 'normal'
    this._continuationCount = 0
    this.status.checkpointConsensus = null

    const attach = !!req.lastWorkSessionId && this.hooks.isRunning(req.lastWorkSessionId!)
    if (attach && req.lastWorkSessionId) {
      // Already running: attach viewer, no new launch.
      this.status.currentIntentId = req.id
      this.status.currentSessionId = req.lastWorkSessionId
      this.status.state = 'developing'
      this.emit()

      void this.hooks.runDevTurn({
        workspacePath: this.workspacePath,
        sessionId: req.lastWorkSessionId,
        prompt: '',
        intentId: req.id,
        signal: this.abort.signal,
        attach: true,
        onAwaitingPermission: (a) => this.setAwaiting(a),
      })
      return
    }

    // Resumable: session exists on disk (continued context).
    if (req.status === 'in_progress' && req.lastWorkSessionId) {
      // Ensure the runtime exists with the right effectiveCwd (worktree, or the
      // project checkout in current-branch mode) across process restarts.
      this._ensureResumeRuntime(req)

      this.status.currentIntentId = req.id
      this.status.currentSessionId = req.lastWorkSessionId
      this.status.state = 'developing'
      this.emit()

      void this.hooks.runDevTurn({
        workspacePath: this.workspacePath,
        sessionId: req.lastWorkSessionId,
        prompt: 'continue',
        intentId: req.id,
        signal: this.abort.signal,
        onAwaitingPermission: (a) => this.setAwaiting(a),
      })
      return
    }

    // Fresh launch: pick the git strategy from the workspace setting, mirroring
    // the manual `startDevelopment` path (index.ts). Both branches are fully
    // synchronous (createWorktree / readBranch use execFileSync) so the dev turn
    // launch stays synchronous — preserving the microtask timing contract that
    // tests and the event-driven FSM rely on.
    //  - `worktree`: isolated worktree branched from the workspace's default main
    //    branch (NOT the project's current HEAD — that was defect D).
    //  - `current-branch`: develop in place on the project checkout; no worktree,
    //    no PR later. Record the current branch so branch_name reflects reality.
    const pendingId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
    let effectiveCwd: string
    if (getGitBranchMode(this.workspacePath) === 'worktree') {
      const wt = createWorktree(
        this.workspacePath,
        req.id,
        req.title,
        getDefaultMainBranch(this.workspacePath),
      )
      effectiveCwd = wt.worktreePath
      // Persist branch name immediately so the UI can show it.
      setBranchName(req.id, wt.branchName)
    } else {
      // Pull latest before developing in place. A diverged branch throws here
      // and is caught by _launchDevelopment → fail() (the user must reconcile).
      const pull = pullCurrentBranch(this.workspacePath)
      if (!pull.ok) {
        throw new Error(
          `当前分支已与远端分叉，无法 fast-forward，请先手动同步:\n${pull.message ?? ''}`,
        )
      }
      effectiveCwd = this.workspacePath
      const branch = readBranch(this.workspacePath)
      if (branch) setBranchName(req.id, branch)
    }

    this.status.currentIntentId = req.id
    this.status.currentSessionId = pendingId
    this.status.state = 'developing'
    this.emit()

    // Use the ORIGINAL project path for ensureRuntime so broadcasts use the
    // correct workspace scope; effectiveCwd overrides the agent's CWD to the
    // worktree (or the project checkout itself in current-branch mode).
    // The automation dev-turn is a `work` business scenario but runs with no
    // socket on the run bus — its execution form is `background`, not interactive.
    const rt = ensureRuntime(
      pendingId,
      this.workspacePath,
      getDefaultMode(this.workspacePath),
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
      devSkill: getDevSkill(this.workspacePath),
      sddEnabled: getSddEnabled(this.workspacePath),
      specPath: req.specPath,
    })
    void this.hooks.runDevTurn({
      workspacePath: this.workspacePath,
      sessionId: pendingId,
      prompt: devParts.visible,
      ...(devParts.userTurnPrefix ? { userTurnPrefix: devParts.userTurnPrefix } : {}),
      ...(devParts.systemInstruction ? { systemInstruction: devParts.systemInstruction } : {}),
      intentId: req.id,
      signal: this.abort.signal,
      onAwaitingPermission: (a) => this.setAwaiting(a),
    })
  }

  /**
   * Ensure the runtime for a resume scenario has the right effectiveCwd. The
   * runtime may already exist (in-memory) or need fresh creation (after server
   * restart); in either case, point its effectiveCwd at the mode's working dir:
   *  - `worktree`: the isolated worktree — but ONLY if it actually exists on
   *    disk (a missing worktree means there's nothing to resume into).
   *  - `current-branch`: the project checkout itself.
   * Deterministic from (workspacePath, intentId) — no extra storage needed.
   */
  private _ensureResumeRuntime(req: Intent): void {
    const worktreeMode = getGitBranchMode(this.workspacePath) === 'worktree'
    const cwd = this._gitCwd(req.id)
    // Worktree mode with no worktree on disk → nothing to point at; leave the
    // runtime's effectiveCwd alone (current-branch never has this gate).
    if (worktreeMode && !worktreeExists(cwd)) return
    // If the runtime already exists (same sessionId), ensureRuntime is a no-op
    // and preserves existing fields; only set effectiveCwd if missing.
    const rt = ensureRuntime(
      req.lastWorkSessionId!,
      this.workspacePath,
      getDefaultMode(this.workspacePath),
      [],
      'work',
      undefined,
      'background',
    )
    if (!rt.effectiveCwd) rt.effectiveCwd = cwd
  }

  /**
   * Launch a continuation turn for the same intent (judge returned
   * `in_progress`). Fire-and-forget; the next settled event drives the FSM.
   */
  private _launchContinue(req: Intent, sessionId: string): void {
    this.status.checkpointConsensus = null
    this.status.state = 'developing'
    this.emit()

    void this.hooks.runDevTurn({
      workspacePath: this.workspacePath,
      sessionId,
      prompt: 'continue',
      intentId: req.id,
      signal: this.abort.signal,
      onAwaitingPermission: (a) => this.setAwaiting(a),
    })
  }

  /**
   * Continue from a checkpoint consensus override. Treats the checkpoint as
   * a passable step (same as `in_progress` continuation) — increments the
   * continuation counter, checks the cap, then launches the continuation.
   * The checkpointConsensus status is cleared before launch so the next
   * turn starts clean.
   */
  private _continueFromCheckpoint(req: Intent, sessionId: string): void {
    this.status.checkpointConsensus = null
    this._continuationCount += 1
    if (this._continuationCount > MAX_CONTINUATIONS) {
      this._processing = false
      this.fail(
        `「${req.title}」超过最大续跑次数(${MAX_CONTINUATIONS}),最后状态:checkpoint-continue`,
      )
      return
    }
    this._processing = false
    this._launchContinue(req, sessionId)
  }

  // ── Turn-settle processing (async) ────────────────────────────────────

  /**
   * Process a settled normal development turn: judge completion, then commit
   * / continue / fail.
   */
  private async _processTurnResult(
    intentId: string,
    sessionId: string,
    reason: RunEndReason,
  ): Promise<void> {
    this.setAwaiting(false)

    try {
      const req = getIntent(intentId)
      if (!req) {
        this._processing = false
        return
      }

      // Map run:settled reason to outcome.
      if (reason === 'error') {
        this._processing = false
        this.fail(`「${req.title}」运行出错`)
        return
      }
      // blocked/max_tokens are treated as "complete" for judging (the agent
      // produced text even if the run hit a token limit).
      if (reason === 'complete') {
        // normal — continue to judge
      } else {
        // `aborted` maps to what was previously `blocked` (permission prompt /
        // user abort). Treat it as a normal completion for judging (the agent
        // produced text even if the run was aborted).
        if (reason !== 'aborted') {
          this._processing = false
          this.fail(`「${req.title}」意外终止 (${reason})`)
          return
        }
      }

      // Extract last assistant message from the runtime buffer.
      const rt = getRuntime(sessionId)
      let lastMessage = ''
      let pendingQuestion = false
      if (rt) {
        const texts: string[] = []
        for (const e of rt.buffer) {
          if (e.type === 'assistant_text') texts.push(e.text)
        }
        lastMessage = texts.join('\n')
        pendingQuestion = hasPendingQuestion(rt.buffer)
      }

      // Compute git evidence early so both the pending-question checkpoint
      // consensus and the completion judge have diff/recent-log context. Scope
      // it to the intent's actual working dir — in worktree mode the changes
      // live in the worktree, not the main checkout, so reading workspacePath
      // would yield empty evidence and mislead the judge.
      const evidenceCwd = this._gitCwd(intentId)
      const [diffStat, recentLog] = await Promise.all([
        gitDiffStat(evidenceCwd),
        gitRecentLog(evidenceCwd),
      ])
      if (this.abort.signal.aborted) {
        this._processing = false
        return
      }

      // Defence: pending question — a real decision must not be continued over.
      // Unless the checkpoint consensus majority decides otherwise.
      if (pendingQuestion) {
        const ckConsensus = await runCheckpointConsensus({
          workspacePath: this.workspacePath,
          intent: req,
          lastMessage,
          trigger: 'pending_question',
          triggerReason: '存在未作答的 AskUserQuestion',
          diffStat,
          signal: this.abort.signal,
        })
        if (ckConsensus?.decision === 'continue') {
          // Checkpoint consensus cleared — treat as in_progress and auto-continue.
          this.status.checkpointConsensus = ckConsensus
          this.emit()
          console.log(
            `[c3:automation]「${req.title}」检查点共识裁决继续(pendingQuestion): ${ckConsensus.summary}`,
          )
          this._continueFromCheckpoint(req, sessionId)
          return
        }
        // Consensus says wait or no decision — follow existing stop path.
        this._processing = false
        this.fail(`「${req.title}」需要人工决策(未作答的提问)`)
        return
      }

      const verdict = await judgeCompletion({
        req,
        lastMessages: [lastMessage],
        evidence: { diffStat, recentLog },
        cwd: this.workspacePath,
        signal: this.abort.signal,
      })
      if (this.abort.signal.aborted) {
        this._processing = false
        return
      }

      if (verdict.verdict === 'done') {
        // ── Done → commit ──
        const commitResult = await this._commit(req, sessionId)
        if (this.abort.signal.aborted) {
          this._processing = false
          return
        }
        if (commitResult === 'committed') {
          // ── Commit succeeded → create PR (best-effort, worktree mode only) ──
          await this._maybeCreatePr(req)

          updateStatus(req.id, 'done')
          publishIntentStatusTransition(this.workspacePath, req, req.status, 'done')
          this.status.completedIds.push(req.id)
          this.hooks.broadcastIntents(this.workspacePath)
          console.log(`[c3:automation]「${req.title}」已完成 → done`)
          this._processing = false
          this._startNext()
          return
        }
        if (commitResult === 'fixing') {
          // Lint-heal fix turn launched; _phase is 'fixing'; unblock so the
          // next settled event (fix turn) can be processed.
          this._processing = false
          return
        }
        // commitResult === 'error' — fail() already called
        this._processing = false
        return
      }

      if (verdict.verdict === 'in_progress') {
        this._continuationCount += 1
        if (this._continuationCount > MAX_CONTINUATIONS) {
          this._processing = false
          this.fail(
            `「${req.title}」超过最大续跑次数(${MAX_CONTINUATIONS}),最后状态:${verdict.reason}`,
          )
          return
        }
        this._processing = false
        this._launchContinue(req, sessionId)
        return
      }

      // Stuck — try checkpoint consensus before stopping.
      if (verdict.verdict === 'stuck') {
        const ckConsensus = await runCheckpointConsensus({
          workspacePath: this.workspacePath,
          intent: req,
          lastMessage,
          trigger: 'judge_stuck',
          triggerReason: verdict.reason,
          diffStat,
          signal: this.abort.signal,
        })
        if (ckConsensus?.decision === 'continue') {
          // Consensus overrode the stuck verdict — treat as in_progress.
          this.status.checkpointConsensus = ckConsensus
          this.emit()
          console.log(
            `[c3:automation]「${req.title}」检查点共识裁决继续(stuck): ${ckConsensus.summary}`,
          )
          this._continueFromCheckpoint(req, sessionId)
          return
        }
        // Consensus says wait or no decision — follow existing stop path.
        this._processing = false
        this.fail(`「${req.title}」未真实完成:${verdict.reason}`)
        return
      }
    } catch (err) {
      this._processing = false
      this.fail(`intent ${intentId} 处理异常:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Handle a lint-fix agent turn's settled event: retry commit, then either
   * mark done or fail.
   */
  private async _handleFixTurnSettled(intentId: string, _sessionId: string): Promise<void> {
    this.setAwaiting(false)
    this._phase = 'normal'
    const fixReq = getIntent(intentId)
    if (!fixReq) {
      this._processing = false
      return
    }

    try {
      const res = await commitAndPush(this._gitCwd(fixReq.id), `feat: ${fixReq.title}`)
      if (this.abort.signal.aborted) {
        this._processing = false
        return
      }

      if (res.ok) {
        // Commit succeeded after auto-fix. Create PR (best-effort, worktree only).
        await this._maybeCreatePr(fixReq)

        updateStatus(fixReq.id, 'done')
        publishIntentStatusTransition(this.workspacePath, fixReq, fixReq.status, 'done')
        this.status.completedIds.push(fixReq.id)
        this.hooks.broadcastIntents(this.workspacePath)
        console.log(`[c3:automation]「${fixReq.title}」已完成 → done (lint 修复后提交)`)
        this._processing = false
        this._startNext()
        return
      }

      // Retry still failed.
      this._processing = false
      this.fail(
        `「${fixReq.title}」lint 自动修复失败(修复 agent 介入后仍未通过):${res.error ?? '未知 lint 错误'}`,
      )
    } catch (err) {
      this._processing = false
      this.fail(
        `「${fixReq.title}」lint 修复异常:${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Best-effort PR creation after a successful commit+push, gated by git mode:
   *  - `worktree`: create the PR (branch is already pushed), record prId +
   *    `reviewing` on success; on failure just log — the intent still goes
   *    `done` (the code is pushed; the user can open the PR manually).
   *  - `current-branch`: NEVER create a PR — develop-in-place mode produces no
   *    reviewable branch, mirroring the manual `startDevelopment` path.
   */
  private async _maybeCreatePr(req: Intent): Promise<void> {
    if (getGitBranchMode(this.workspacePath) !== 'worktree') return
    const prResult = await this._createPrForIntent(req).catch((err) => {
      console.warn(
        `[c3:automation]「${req.title}」PR 创建异常: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    })
    if (prResult?.ok) {
      setPrInfo(req.id, prResult.prId, 'reviewing')
      console.log(`[c3:automation]「${req.title}」PR #${prResult.prId} 已创建`)

      // Publish a pr:operation create event so event-triggered automations can react.
      const headBranch = req.branchName ?? undefined
      const effectiveSessionId = req.lastWorkSessionId ?? req.id
      runServerSidePrCreate(
        {
          prId: prResult.prId,
          prUrl: prResult.prUrl,
          headBranch,
          baseBranch: undefined,
          intentId: req.id,
        },
        this.hooks.normalizeEvent,
        (event) =>
          this.hooks.publishEvent({
            workspacePath: this.workspacePath,
            sessionId: effectiveSessionId,
            event,
          }),
      )
    } else if (prResult) {
      console.warn(`[c3:automation]「${req.title}」PR 创建失败: ${prResult.error}`)
    }
  }

  /**
   * Create a forge-aware pull or merge request for a completed intent.
   *
   * Constructs the PR title and body from the intent's title, content, and
   * dependency list, then creates the change request through the forge dispatcher.
   * The head branch is the intent's worktree branch (`req.branchName`, or the
   * current branch as fallback). Returns the PR id and URL on success, or an
   * error description on failure (forge CLI not installed, auth failure, etc.).
   *
   * Called after `commitAndPush` succeeds in the automation orchestrator.
   * Failures are logged but do NOT block the intent from being marked `done` —
   * the code is already pushed; the user can create the PR manually.
   */
  private async _createPrForIntent(
    req: Intent,
  ): Promise<{ ok: true; prId: string; prUrl: string } | { ok: false; error: string } | null> {
    const headBranch = req.branchName ?? undefined
    const bodyParts: string[] = [req.content]
    if (req.dependsOn.length > 0) {
      bodyParts.push('', '## 依赖需求')
      for (const depId of req.dependsOn) {
        const dep = getIntent(depId)
        const status = dep?.status ?? 'unknown'
        bodyParts.push(`- ${dep?.title ?? depId} (${status})`)
      }
    }
    const body = bodyParts.join('\n')
    const title = `feat: ${req.title}`
    const prResult = await createForgePr(
      this._gitCwd(req.id),
      title,
      body,
      headBranch,
      undefined,
      getForgeOverride(this.workspacePath),
    )
    if (prResult.ok && prResult.prId) {
      return { ok: true as const, prId: prResult.prId, prUrl: prResult.prUrl ?? '' }
    }
    return { ok: false as const, error: prResult.error ?? 'Unknown error' }
  }

  /**
   * Commit & push the finished work. If the initial commit is blocked by a
   * pre-commit lint hook, launch a fix agent turn (fire-and-forget) and return
   * 'fixing'. The fix turn's settle will be handled by _handleFixTurnSettled.
   */
  private async _commit(req: Intent, sessionId: string): Promise<'committed' | 'fixing' | 'error'> {
    const message = `feat: ${req.title}`
    const firstAttempt = await commitAndPush(this._gitCwd(req.id), message)
    if (firstAttempt.ok) return 'committed'

    // Non-lint failure — surface as a hard stop (RM-A6).
    if (firstAttempt.failure !== 'commit-hook') {
      this.fail(`「${req.title}」${firstAttempt.error ?? '提交失败'}`)
      return 'error'
    }

    if (this.abort.signal.aborted) return 'error'

    // Lint hook blocked the commit — launch a fix agent turn.
    console.warn(
      `[c3:automation]「${req.title}」pre-commit lint 失败,启动修复 agent 介入一次:${firstAttempt.error}`,
    )
    this._phase = 'fixing'
    this.status.state = 'fixing'
    this.emit()

    const fixPrompt = `pre-commit 钩子的 lint 检查未通过,本次提交被拦截。请修复以下 lint/格式报错,改完即可,无需自行 git commit:\n\n${firstAttempt.error ?? 'pre-commit lint 失败'}`

    void this.hooks.runDevTurn({
      workspacePath: this.workspacePath,
      sessionId,
      prompt: fixPrompt,
      intentId: req.id,
      signal: this.abort.signal,
      onAwaitingPermission: (a) => this.setAwaiting(a),
    })

    return 'fixing'
  }
}

// ── Per-project controller registry ───────────────────────────────────────

const controllers = new Map<string, WorkflowController>()

/** Current automation status for a project (idle when never started). */
export function getWorkflowStatus(workspacePath: string): WorkflowStatus {
  return controllers.get(workspacePath)?.status ?? idleStatus(workspacePath)
}

/**
 * Start (or re-start) the automation orchestrator for a project. No-op if
 * already running or developing. Otherwise creates a fresh controller and
 * kicks off the first eligible intent via `kickstart()`; progress arrives
 * via `onTurnSettled`.
 */
export function startWorkflow(
  workspacePath: string,
  hooks: WorkflowHooks,
  now: number,
): WorkflowStatus {
  const existing = controllers.get(workspacePath)
  if (existing) {
    if (
      existing.status.state !== 'error' &&
      existing.status.state !== 'idle' &&
      existing.status.state !== 'done'
    ) {
      return existing.status
    }
    // Re-start a stopped/done/errored controller.
    controllers.delete(workspacePath)
  }
  const controller = new WorkflowController(workspacePath, hooks, now)
  controllers.set(workspacePath, controller)
  controller.kickstart()
  return controller.status
}

/**
 * Whether an intent's work session is currently driven by this workspace's
 * automation orchestrator. True iff a controller exists AND `intentId` is its
 * `currentIntentId` — exactly the condition under which `onTurnSettled` claims a
 * settled turn as its own (Case 1). The session-end manual Git/PR cleanup uses
 * this to skip automation-owned sessions, giving manual vs automation a
 * deterministic, mutually-exclusive split (MSC-R1).
 */
export function isIntentDrivenByWorkflow(workspacePath: string, intentId: string): boolean {
  const c = controllers.get(workspacePath)
  return !!c && c.status.currentIntentId === intentId
}

/** Stop the orchestrator for a project (aborts the current dev run). */
export function stopWorkflow(workspacePath: string): WorkflowStatus {
  const c = controllers.get(workspacePath)
  if (c) c.stop()
  return getWorkflowStatus(workspacePath)
}

/**
 * Notify a project's automation controller that an intent-linked session
 * just settled. Called from the resident `run:settled` subscription in
 * `wiring/run-domain-subscriptions.ts`. No-op if the controller does not
 * exist or is not in a relevant state.
 *
 * Returns a promise that resolves when the controller's async settle
 * processing completes (used by tests to sequence assertions).
 */
export function notifyTurnSettled(
  workspacePath: string,
  sessionId: string,
  reason: RunEndReason,
  intentId: string,
): Promise<void> | undefined {
  const controller = controllers.get(workspacePath)
  if (!controller) return undefined
  controller.onTurnSettled(sessionId, reason, intentId)
  return controller['_processingPromise'] ?? undefined
}
