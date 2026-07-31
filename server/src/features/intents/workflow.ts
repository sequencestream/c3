/**
 * Automation queue driver — the assembly around the deterministic scheduling
 * kernel (`kernel/queue`).
 *
 * ── How the queue moves ──────────────────────────────────────────────────────
 * A fixed 10s tick, a coalesced dirty mark from a lifecycle event, and the
 * one-shot pass at server startup all enter the SAME idempotent pass:
 *
 *   facts (ledger snapshot + run liveness + persisted scheduling metadata)
 *     → `reconcileQueue` (pure)
 *     → decisions written to `queue_decision_log`
 *     → actions executed here
 *
 * Nothing depends on a particular event arriving. Events do not carry decision
 * material; they only say "look again". A dropped `run:settled` therefore costs
 * one tick of latency instead of stalling the queue forever, and a crash or
 * restart is recovered by re-deriving state from the ledger.
 *
 * ── Failure isolation ────────────────────────────────────────────────────────
 * Every run the queue starts is awaited and its errors caught. A failure counts
 * against THAT intent only: exponential backoff first, park after three
 * consecutive failures. A parked intent is never auto-launched again, but it is
 * NOT `done` — so the dependency gate keeps its downstream blocked exactly as
 * before. Unrelated intents keep flowing.
 *
 * ── What this module deliberately does not do ────────────────────────────────
 * It never answers a permission prompt, never marks an intent `done` outside the
 * existing judge → commit → push path, and never relaxes a hard gate. A queue
 * wait that outlives its window parks the intent and asks a human; the decision
 * itself stays with the human forever (C-SEC-3).
 */
import { randomUUID } from 'node:crypto'
import type { WorkflowStatus, Intent, RunEndReason } from '@ccc/shared/protocol'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { MAX_CONTINUATIONS, hasPendingQuestion } from './turn-guards.js'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import type {
  QueueAction,
  QueueDecision,
  QueueIntentFact,
  QueueReasonCode,
  QueueReconcileOutput,
  QueueRunFact,
} from '../../kernel/queue/index.js'
import {
  CoalescingRunner,
  QUEUE_COOLDOWN_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_TICK_MS,
  backoffDelayMs,
  emptyQueueIntentMeta,
  reconcileQueue,
} from '../../kernel/queue/index.js'
import {
  getIntent,
  isStoreAvailable,
  listIntents,
  safeInsertIntentLog,
  setBranchName,
  setLastWorkSession,
  setPrInfo,
  updateStatus,
} from './store.js'
import {
  getQueueControl,
  getQueueIntentMeta,
  getQueueIntentMetaById,
  isQueueStoreAvailable,
  latestQueueDecisionByIntent,
  listActiveQueueWorkspaces,
  putQueueIntentMeta,
  appendQueueDecisions,
  setQueueControl,
  type QueueControlRow,
} from './queue-store.js'
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
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'

// ---------------------------------------------------------------------------
// Public types
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

/** A deduplicated human-todo request raised by the queue. */
export interface QueueUserTodoInput {
  workspacePath: string
  intentId: string
  sessionId: string | null
  title: string
  reasonCode: QueueReasonCode
}

export interface WorkflowHooks {
  runDevTurn(input: RunDevTurnInput): Promise<DevTurnResult>
  broadcastIntents(workspacePath: string): void
  emitStatus(status: WorkflowStatus): void
  sessionExists(workspacePath: string, sessionId: string): Promise<boolean>
  isRunning(sessionId: string): boolean
  /** Current run status of a session (`awaiting_permission`, …); null when unknown. */
  sessionStatus(sessionId: string): string | null
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Publish a normalized generic event (envelope) onto the kernel event bus. */
  publishEvent: (payload: GenericEventEnvelope) => void
  /**
   * Raise a wait-user-involve todo. Called at most once per park, because the
   * park flag itself is the dedup key — a parked intent is never re-parked.
   */
  createUserTodo(input: QueueUserTodoInput): void
  /** Push the refreshed queue detail projection to watching clients. */
  broadcastQueueDetail(workspacePath: string): void
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
// Constants
// ---------------------------------------------------------------------------

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

/**
 * The next intent the queue would select, by the CURRENT facts. Exported for
 * tests and for the intent list's "eligible" affordance; it reads the same pure
 * kernel the driver does, so the two can never disagree.
 */
export function pickNext(workspacePath: string): Intent | null {
  if (!isStoreAvailable()) return null
  const intents = listIntents(workspacePath)
  const out = reconcileQueue({
    now: Date.now(),
    tickId: 'probe',
    workspacePath,
    control: { state: 'running', startedAt: null, forceSkipped: [] },
    snapshotOk: true,
    intents: intents.map(toFact),
    runs: [],
    meta: getQueueIntentMeta(workspacePath),
    inFlight: [],
    gitBranchMode: getGitBranchMode(workspacePath),
    sddEnabled: getSddEnabled(workspacePath),
  })
  const chosen = out.actions.find((a) => a.kind === 'launch' || a.kind === 'resume')
  if (!chosen) return null
  return intents.find((r) => r.id === chosen.intentId) ?? null
}

/** Project one ledger row onto the kernel's fact shape. */
function toFact(r: Intent): QueueIntentFact {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    automate: r.automate,
    dependsOn: r.dependsOn,
    specApproved: r.specApproved,
    prStatus: r.prStatus,
    lastWorkSessionId: r.lastWorkSessionId,
    createdAt: r.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** One kernel-owned run in flight. */
interface InFlightRun {
  intentId: string
  phase: 'developing' | 'fixing'
  sessionId: string | null
  /** Settles when the whole develop loop for this intent is over. */
  settled: Promise<void>
}

class QueueController {
  readonly status: WorkflowStatus
  private abort = new AbortController()
  private readonly runner: CoalescingRunner
  private readonly inFlight = new Map<string, InFlightRun>()
  /** sessionId → when this queue FIRST observed the run waiting on a human. */
  private readonly awaitingSince = new Map<string, number>()
  private decisions: QueueDecision[] = []
  private lastTickId = ''
  private nextWakeupAt: number | null = null
  private disposed = false

  constructor(
    readonly workspacePath: string,
    private readonly hooks: WorkflowHooks,
  ) {
    this.status = idleStatus(workspacePath)
    this.runner = new CoalescingRunner(() => this.pass())
  }

  // ── Public surface ────────────────────────────────────────────────────────

  /** Request a reconcile pass. Overlapping requests coalesce into one follow-up. */
  request(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.runner.request()
  }

  get inFlightIntentIds(): string[] {
    return [...this.inFlight.keys()]
  }

  get lastDecisions(): readonly QueueDecision[] {
    return this.decisions
  }

  get wakeupAt(): number | null {
    return this.nextWakeupAt
  }

  get tickId(): string {
    return this.lastTickId
  }

  /** User stopped the queue: abort in-flight runs and return to `idle`. */
  stop(): void {
    this.abort.abort()
    this.abort = new AbortController()
    this.inFlight.clear()
    this.awaitingSince.clear()
    this.decisions = []
    this.nextWakeupAt = null
    Object.assign(this.status, idleStatus(this.workspacePath))
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
  }

  // ── The single idempotent pass ────────────────────────────────────────────

  private async pass(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const tickId = randomUUID()
    this.lastTickId = tickId

    const control = getQueueControl(this.workspacePath)
    if (control.state === 'idle') {
      Object.assign(this.status, idleStatus(this.workspacePath))
      this.decisions = []
      this.emit()
      return
    }

    // Read the whole workspace snapshot at once. An unreadable ledger fails the
    // pass closed: no launches, no failure counting, one workspace-level record.
    let intents: Intent[] | null
    try {
      intents = isStoreAvailable() ? listIntents(this.workspacePath) : null
    } catch (err) {
      console.error(`[c3:queue] 读取意图快照失败 (${this.workspacePath}):`, err)
      intents = null
    }
    const snapshotOk = intents !== null

    const output = reconcileQueue({
      now,
      tickId,
      workspacePath: this.workspacePath,
      control,
      snapshotOk,
      intents: (intents ?? []).map(toFact),
      runs: this.buildRunFacts(intents ?? [], now),
      meta: getQueueIntentMeta(this.workspacePath),
      inFlight: this.inFlightIntentIds,
      gitBranchMode: getGitBranchMode(this.workspacePath),
      sddEnabled: getSddEnabled(this.workspacePath),
    })

    this.decisions = output.decisions
    this.nextWakeupAt = output.nextWakeupAt
    this.writeDecisions(output, now)
    this.execute(output.actions, now)
    this.project(output, control)
  }

  /**
   * Probe every work session the ledger points at. A session that is not alive
   * releases `awaiting_gate` by construction — the kernel simply never sees it
   * in the live set, so a dead blocking session can no longer wedge the queue.
   */
  private buildRunFacts(intents: readonly Intent[], now: number): QueueRunFact[] {
    const facts: QueueRunFact[] = []
    const seen = new Set<string>()
    for (const r of intents) {
      const sid = r.lastWorkSessionId
      if (!sid || seen.has(sid)) continue
      seen.add(sid)
      const alive = this.hooks.isRunning(sid)
      if (!alive) {
        this.awaitingSince.delete(sid)
        facts.push({ sessionId: sid, alive: false, awaitingPermissionSince: null })
        continue
      }
      const waiting = this.hooks.sessionStatus(sid) === 'awaiting_permission'
      if (!waiting) this.awaitingSince.delete(sid)
      else if (!this.awaitingSince.has(sid)) this.awaitingSince.set(sid, now)
      facts.push({
        sessionId: sid,
        alive: true,
        awaitingPermissionSince: waiting ? (this.awaitingSince.get(sid) ?? now) : null,
      })
    }
    return facts
  }

  /**
   * Persist decisions that actually say something new. A tick that repeats the
   * previous verdict verbatim writes nothing, so a queue parked on one blocked
   * intent does not grow the log by six rows a minute; anything carrying an
   * action, or any change of action/reason/detail, is always written.
   */
  private writeDecisions(output: QueueReconcileOutput, now: number): void {
    const previous = latestQueueDecisionByIntent(this.workspacePath)
    const actionable = new Set(
      output.actions
        .filter((a) => 'intentId' in a)
        .map((a) => (a as { intentId: string }).intentId),
    )
    const rows = output.decisions
      .filter((d) => {
        if (actionable.has(d.intentId)) return true
        const prev = previous[d.intentId]
        if (!prev) return true
        return (
          prev.action !== d.action ||
          prev.blockedGate !== d.reason ||
          prev.rejectReason !== d.detail
        )
      })
      .map((d) => ({
        tickId: output.tickId,
        workspacePath: this.workspacePath,
        intentId: d.intentId,
        decidedAt: now,
        action: d.action,
        blockedGate: d.reason,
        rejectReason: d.detail || null,
        attemptCount: d.attemptCount,
        backoffCount: d.backoffCount,
        nextWakeupAt: d.nextWakeupAt,
      }))
    appendQueueDecisions(rows)
  }

  // ── Action execution ──────────────────────────────────────────────────────

  private execute(actions: readonly QueueAction[], now: number): void {
    for (const action of actions) {
      switch (action.kind) {
        case 'park':
          this.applyPark(action.intentId, action.reason, action.detail)
          break
        case 'wait_user_involve': {
          const req = getIntent(action.intentId)
          this.hooks.createUserTodo({
            workspacePath: this.workspacePath,
            intentId: action.intentId,
            sessionId: req?.lastWorkSessionId ?? null,
            title: `「${req?.title ?? action.intentId}」${action.detail}`,
            reasonCode: action.reason,
          })
          break
        }
        case 'sync_dependency_prs':
          syncUnconfirmedDependencyPrsInBackground({
            ctx: { broadcastIntents: this.hooks.broadcastIntents },
            workspacePath: this.workspacePath,
            dependsOn: action.intentIds,
            onComplete: () => void this.request(),
          })
          break
        case 'launch':
        case 'resume':
        case 'attach':
          this.startRun(action, now)
          break
      }
    }
  }

  /**
   * Start ONE kernel run for an intent. The cooldown is written before the run
   * exists and the in-flight entry is registered synchronously, so a tick and a
   * lifecycle event racing each other can never produce a second launch.
   *
   * The returned promise is tracked rather than awaited by the pass — a dev turn
   * outlives a tick by minutes. It is fully awaited and error-handled INSIDE
   * `develop`, and its completion marks the queue dirty; no path leaves an
   * exception unobserved.
   */
  private startRun(
    action: Extract<QueueAction, { kind: 'launch' | 'resume' | 'attach' }>,
    now: number,
  ): void {
    const intentId = action.intentId
    if (this.inFlight.has(intentId)) return
    const req = getIntent(intentId)
    if (!req) return

    const meta = getQueueIntentMetaById(intentId)
    putQueueIntentMeta(this.workspacePath, {
      ...meta,
      intentId,
      cooldownUntil: now + QUEUE_COOLDOWN_MS,
      updatedAt: now,
    })

    const record: InFlightRun = {
      intentId,
      phase: 'developing',
      sessionId: action.kind === 'launch' ? null : action.sessionId,
      settled: Promise.resolve(),
    }
    this.inFlight.set(intentId, record)

    record.settled = this.develop(action, req, record)
      .catch((err) => {
        console.error(`[c3:queue]「${req.title}」内核 run 异常:`, err)
        this.recordFailure(intentId, 'launch_failed', errText(err))
      })
      .finally(() => {
        this.inFlight.delete(intentId)
        void this.request()
      })
  }

  /** Await every in-flight kernel run (tests sequence assertions on this). */
  async settleRuns(): Promise<void> {
    // A run that finishes may start another (the queue moves on), so drain.
    for (let i = 0; i < 50 && this.inFlight.size > 0; i++) {
      await Promise.allSettled([...this.inFlight.values()].map((r) => r.settled))
    }
  }

  // ── The per-intent development loop ───────────────────────────────────────

  private async develop(
    action: Extract<QueueAction, { kind: 'launch' | 'resume' | 'attach' }>,
    req: Intent,
    record: InFlightRun,
  ): Promise<void> {
    const signal = this.abort.signal
    let turnInput = this.buildFirstTurn(action, req, signal)
    record.sessionId = turnInput.sessionId
    let continuations = 0

    for (;;) {
      const result = await this.hooks.runDevTurn(turnInput)
      if (signal.aborted || this.disposed) return
      const sessionId = result.sessionId || turnInput.sessionId || ''
      record.sessionId = sessionId
      this.markInProgress(req.id, sessionId)

      if (result.outcome === 'blocked') return // user stop / abort
      if (result.outcome === 'error') {
        this.recordFailure(req.id, 'turn_error', result.detail ?? '开发 turn 运行出错')
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

      const evidenceCwd = this.gitCwd(req.id)
      const [diffStat, recentLog] = await Promise.all([
        gitDiffStat(evidenceCwd),
        gitRecentLog(evidenceCwd),
      ])
      if (signal.aborted || this.disposed) return

      // RM-A11: a real human decision is never continued over. The checkpoint
      // consensus may overrule it (RM-A14); otherwise the intent is parked and a
      // human is asked — the queue itself keeps going.
      if (pendingQuestion) {
        const ck = await runCheckpointConsensus({
          workspacePath: this.workspacePath,
          intent: fresh,
          lastMessage,
          trigger: 'pending_question',
          triggerReason: '存在未作答的 AskUserQuestion',
          diffStat,
          signal,
        })
        if (signal.aborted || this.disposed) return
        if (ck?.decision === 'continue') {
          this.status.checkpointConsensus = ck
          this.emit()
          continuations += 1
          if (continuations > MAX_CONTINUATIONS) {
            this.recordFailure(req.id, 'budget_exhausted', `超过最大续跑次数(${MAX_CONTINUATIONS})`)
            return
          }
          turnInput = this.buildContinueTurn(req.id, sessionId, signal)
          continue
        }
        this.parkForHuman(fresh, 'needs_human_decision', '存在未作答的提问,需要人工决策')
        return
      }

      const verdict = await judgeCompletion({
        req: fresh,
        lastMessages: [lastMessage],
        evidence: { diffStat, recentLog },
        cwd: this.workspacePath,
        signal,
      })
      if (signal.aborted || this.disposed) return

      if (verdict.verdict === 'done') {
        const committed = await this.commitWithLintHeal(fresh, sessionId, record, signal)
        if (committed === 'aborted' || this.disposed) return
        if (committed === 'failed') return // recordFailure already applied
        await this.maybeCreatePr(fresh)
        updateStatus(fresh.id, 'done')
        publishIntentStatusTransition(this.workspacePath, fresh, fresh.status, 'done')
        this.status.completedIds.push(fresh.id)
        this.hooks.broadcastIntents(this.workspacePath)
        this.recordSuccess(fresh.id)
        console.log(`[c3:queue]「${fresh.title}」已完成 → done`)
        return
      }

      if (verdict.verdict === 'in_progress') {
        continuations += 1
        if (continuations > MAX_CONTINUATIONS) {
          this.recordFailure(
            req.id,
            'budget_exhausted',
            `超过最大续跑次数(${MAX_CONTINUATIONS}),最后状态:${verdict.reason}`,
          )
          return
        }
        turnInput = this.buildContinueTurn(req.id, sessionId, signal)
        continue
      }

      // stuck → checkpoint consensus may overrule, else this intent fails.
      const ck = await runCheckpointConsensus({
        workspacePath: this.workspacePath,
        intent: fresh,
        lastMessage,
        trigger: 'judge_stuck',
        triggerReason: verdict.reason,
        diffStat,
        signal,
      })
      if (signal.aborted || this.disposed) return
      if (ck?.decision === 'continue') {
        this.status.checkpointConsensus = ck
        this.emit()
        continuations += 1
        if (continuations > MAX_CONTINUATIONS) {
          this.recordFailure(req.id, 'budget_exhausted', `超过最大续跑次数(${MAX_CONTINUATIONS})`)
          return
        }
        turnInput = this.buildContinueTurn(req.id, sessionId, signal)
        continue
      }
      this.recordFailure(req.id, 'judge_stuck', `未真实完成:${verdict.reason}`)
      return
    }
  }

  /**
   * Build the first turn for a launch/resume/attach. Fresh launches prepare the
   * git working directory first; anything thrown here (diverged branch, worktree
   * failure) propagates to `startRun`'s catch and becomes ONE failed attempt for
   * this intent — never a stopped queue.
   */
  private buildFirstTurn(
    action: Extract<QueueAction, { kind: 'launch' | 'resume' | 'attach' }>,
    req: Intent,
    signal: AbortSignal,
  ): RunDevTurnInput {
    if (action.kind === 'attach') {
      return {
        workspacePath: this.workspacePath,
        sessionId: action.sessionId,
        prompt: '',
        intentId: req.id,
        signal,
        attach: true,
        onAwaitingPermission: (a) => this.setAwaiting(a),
      }
    }
    if (action.kind === 'resume') {
      this.ensureResumeRuntime(req, action.sessionId)
      return this.buildContinueTurn(req.id, action.sessionId, signal)
    }

    // Fresh launch — mirror the manual `startDevelopment` git strategy.
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
      setBranchName(req.id, wt.branchName)
    } else {
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
    return {
      workspacePath: this.workspacePath,
      sessionId: pendingId,
      prompt: devParts.visible,
      ...(devParts.userTurnPrefix ? { userTurnPrefix: devParts.userTurnPrefix } : {}),
      ...(devParts.systemInstruction ? { systemInstruction: devParts.systemInstruction } : {}),
      intentId: req.id,
      signal,
      onAwaitingPermission: (a) => this.setAwaiting(a),
    }
  }

  private buildContinueTurn(
    intentId: string,
    sessionId: string,
    signal: AbortSignal,
  ): RunDevTurnInput {
    return {
      workspacePath: this.workspacePath,
      sessionId,
      prompt: 'continue',
      intentId,
      signal,
      onAwaitingPermission: (a) => this.setAwaiting(a),
    }
  }

  /**
   * Commit & push, self-healing exactly once through a fix agent turn when a
   * pre-commit lint hook blocked it (RM-A13). The fix turn is awaited like every
   * other kernel run.
   */
  private async commitWithLintHeal(
    req: Intent,
    sessionId: string,
    record: InFlightRun,
    signal: AbortSignal,
  ): Promise<'ok' | 'failed' | 'aborted'> {
    const message = `feat: ${req.title}`
    const first = await commitAndPush(this.gitCwd(req.id), message)
    if (signal.aborted) return 'aborted'
    if (first.ok) return 'ok'

    if (first.failure !== 'commit-hook') {
      this.recordFailure(req.id, 'commit_failed', first.error ?? '提交失败')
      return 'failed'
    }

    console.warn(
      `[c3:queue]「${req.title}」pre-commit lint 失败,启动修复 agent 介入一次:${first.error}`,
    )
    record.phase = 'fixing'
    this.status.state = 'fixing'
    this.emit()
    try {
      await this.hooks.runDevTurn({
        workspacePath: this.workspacePath,
        sessionId,
        prompt: `pre-commit 钩子的 lint 检查未通过,本次提交被拦截。请修复以下 lint/格式报错,改完即可,无需自行 git commit:\n\n${first.error ?? 'pre-commit lint 失败'}`,
        intentId: req.id,
        signal,
        onAwaitingPermission: (a) => this.setAwaiting(a),
      })
    } finally {
      record.phase = 'developing'
    }
    if (signal.aborted || this.disposed) return 'aborted'

    const second = await commitAndPush(this.gitCwd(req.id), message)
    if (signal.aborted) return 'aborted'
    if (second.ok) return 'ok'
    this.recordFailure(
      req.id,
      'commit_failed',
      `lint 自动修复后仍未通过:${second.error ?? '未知 lint 错误'}`,
    )
    return 'failed'
  }

  // ── Scheduling metadata transitions ───────────────────────────────────────

  /**
   * One failed attempt for ONE intent. Exponential backoff first; the third
   * consecutive failure parks it. The queue itself never stops — other intents
   * that do not depend on this one keep being selected, while its downstream
   * stays blocked by the dependency gate because a parked intent is not `done`.
   */
  private recordFailure(intentId: string, reason: QueueReasonCode, detail: string): void {
    const now = Date.now()
    const prev = getQueueIntentMetaById(intentId)
    const failureCount = prev.failureCount + 1
    const park = failureCount >= QUEUE_MAX_ATTEMPTS
    putQueueIntentMeta(this.workspacePath, {
      ...prev,
      intentId,
      failureCount,
      backoffCount: park ? prev.backoffCount : prev.backoffCount + 1,
      backoffUntil: park ? null : now + backoffDelayMs(failureCount),
      parked: park,
      parkReason: park ? reason : prev.parkReason,
      parkDetail: park ? detail : prev.parkDetail,
      updatedAt: now,
    })
    appendQueueDecisions([
      {
        tickId: this.lastTickId || 'run',
        workspacePath: this.workspacePath,
        intentId,
        decidedAt: now,
        action: park ? 'park' : 'block',
        blockedGate: park ? 'max_attempts_reached' : reason,
        rejectReason: detail,
        attemptCount: failureCount,
        backoffCount: park ? prev.backoffCount : prev.backoffCount + 1,
        nextWakeupAt: park ? null : now + backoffDelayMs(failureCount),
      },
    ])
    const req = getIntent(intentId)
    if (req) publishIntentLifecycle(this.workspacePath, req, 'failed')
    console.warn(
      `[c3:queue]「${req?.title ?? intentId}」第 ${failureCount} 次失败(${reason}): ${detail}` +
        (park ? ' → 已 park,队列继续处理其他意图' : ` → 退避 ${backoffDelayMs(failureCount)}ms`),
    )
    this.hooks.broadcastQueueDetail(this.workspacePath)
  }

  /** Real progress wipes the consecutive-failure and backoff state. */
  private recordSuccess(intentId: string): void {
    const prev = getQueueIntentMetaById(intentId)
    if (prev.failureCount === 0 && prev.backoffUntil === null) return
    putQueueIntentMeta(this.workspacePath, {
      ...prev,
      intentId,
      failureCount: 0,
      backoffUntil: null,
      updatedAt: Date.now(),
    })
  }

  /** Park an intent that needs a human, and raise exactly one todo for it. */
  private parkForHuman(req: Intent, reason: QueueReasonCode, detail: string): void {
    this.applyPark(req.id, reason, detail)
    this.hooks.createUserTodo({
      workspacePath: this.workspacePath,
      intentId: req.id,
      sessionId: req.lastWorkSessionId,
      title: `「${req.title}」${detail}`,
      reasonCode: reason,
    })
    publishIntentLifecycle(this.workspacePath, req, 'failed')
    console.warn(`[c3:queue]「${req.title}」已 park(${reason}): ${detail}`)
  }

  private applyPark(intentId: string, reason: QueueReasonCode, detail: string): void {
    const prev = getQueueIntentMetaById(intentId)
    if (prev.parked) return
    putQueueIntentMeta(this.workspacePath, {
      ...prev,
      intentId,
      parked: true,
      parkReason: reason,
      parkDetail: detail,
      backoffUntil: null,
      updatedAt: Date.now(),
    })
    this.hooks.broadcastQueueDetail(this.workspacePath)
  }

  // ── Status projection ─────────────────────────────────────────────────────

  private project(output: QueueReconcileOutput, control: QueueControlRow): void {
    const fixing = [...this.inFlight.values()].some((r) => r.phase === 'fixing')
    this.status.state = fixing ? 'fixing' : output.state
    this.status.currentIntentId = output.currentIntentId
    this.status.currentSessionId = output.currentSessionId
    this.status.awaitingPermission = output.awaitingPermission
    this.status.startedAt = control.startedAt
    // The kernel isolates failures per intent, so the queue as a whole no longer
    // carries a stop reason. The most recent park is what a user needs to see.
    const parked = output.decisions.find((d) => d.action === 'park')
    this.status.error = parked ? `${parked.reason}: ${parked.detail}` : null
    this.emit()
    this.hooks.broadcastQueueDetail(this.workspacePath)
  }

  private emit(): void {
    this.hooks.emitStatus({ ...this.status, completedIds: [...this.status.completedIds] })
  }

  private setAwaiting(awaiting: boolean): void {
    if (this.status.awaitingPermission === awaiting) return
    this.status.awaitingPermission = awaiting
    this.emit()
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private markInProgress(intentId: string, sessionId: string): void {
    if (!sessionId) return
    const req = getIntent(intentId)
    if (!req) return
    if (req.lastWorkSessionId !== sessionId) setLastWorkSession(intentId, sessionId)
    if (req.status !== 'in_progress') {
      updateStatus(intentId, 'in_progress')
      publishIntentStatusTransition(this.workspacePath, req, req.status, 'in_progress')
    }
    this.status.currentSessionId = sessionId
    this.hooks.broadcastIntents(this.workspacePath)
  }

  /**
   * The git working directory for an intent's commit/push/PR/evidence ops:
   * the isolated worktree in `worktree` mode, else the project checkout itself.
   */
  private gitCwd(intentId: string): string {
    if (getGitBranchMode(this.workspacePath) === 'worktree') {
      return getWorktreePath(this.workspacePath, intentId)
    }
    return this.workspacePath
  }

  private ensureResumeRuntime(req: Intent, sessionId: string): void {
    const worktreeMode = getGitBranchMode(this.workspacePath) === 'worktree'
    const cwd = this.gitCwd(req.id)
    if (worktreeMode && !worktreeExists(cwd)) return
    const rt = ensureRuntime(
      sessionId,
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
   * Best-effort PR creation after a successful commit+push, gated by git mode:
   * `worktree` creates the PR, `current-branch` never does.
   */
  private async maybeCreatePr(req: Intent): Promise<void> {
    if (getGitBranchMode(this.workspacePath) !== 'worktree') return
    const prResult = await this.createPrForIntent(req).catch((err) => {
      console.warn(`[c3:queue]「${req.title}」PR 创建异常: ${errText(err)}`)
      return null
    })
    if (prResult?.ok) {
      setPrInfo(req.id, prResult.prId, 'reviewing', prResult.prUrl || null)
      safeInsertIntentLog(req.id, 'pr_created', `创建 PR #${prResult.prId}`, 'automation')
      console.log(`[c3:queue]「${req.title}」PR #${prResult.prId} 已创建`)

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
      console.warn(`[c3:queue]「${req.title}」PR 创建失败: ${prResult.error}`)
    }
  }

  private async createPrForIntent(
    req: Intent,
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
      this.gitCwd(req.id),
      `feat: ${req.title}`,
      bodyParts.join('\n'),
      headBranch,
      undefined,
      getForgeOverride(this.workspacePath),
    )
    if (prResult.ok && prResult.prId) {
      return { ok: true as const, prId: prResult.prId, prUrl: prResult.prUrl ?? '' }
    }
    return { ok: false as const, error: prResult.error ?? 'Unknown error' }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Per-workspace registry + public API
// ---------------------------------------------------------------------------

const controllers = new Map<string, QueueController>()

function controllerFor(workspacePath: string, hooks?: WorkflowHooks): QueueController {
  let c = controllers.get(workspacePath)
  if (!c) {
    c = new QueueController(workspacePath, hooks ?? getWorkflowHooks())
    controllers.set(workspacePath, c)
  }
  return c
}

/** Current automation status for a project (idle when never started). */
export function getWorkflowStatus(workspacePath: string): WorkflowStatus {
  return controllers.get(workspacePath)?.status ?? idleStatus(workspacePath)
}

/**
 * Start (or re-start) the queue for a project. Idempotent: starting an already
 * running queue just returns its status. The control state is PERSISTED, so a
 * server restart resumes the queue the user actually asked for instead of
 * silently going idle.
 */
export function startWorkflow(
  workspacePath: string,
  hooks: WorkflowHooks,
  now: number,
): WorkflowStatus {
  const control = getQueueControl(workspacePath)
  if (control.state !== 'running') {
    setQueueControl(workspacePath, {
      state: 'running',
      startedAt: control.startedAt ?? now,
      forceSkipped: control.forceSkipped,
    })
  }
  const c = controllerFor(workspacePath, hooks)
  c.status.startedAt = control.startedAt ?? now
  c.status.state = 'running'
  void c.request()
  return c.status
}

/** Stop the queue for a project (aborts the current dev run, returns to idle). */
export function stopWorkflow(workspacePath: string): WorkflowStatus {
  setQueueControl(workspacePath, { state: 'idle', startedAt: null, forceSkipped: [] })
  const c = controllers.get(workspacePath)
  if (c) c.stop()
  return getWorkflowStatus(workspacePath)
}

/** Pause the queue: keep all facts and metadata, launch nothing. */
export function pauseWorkflow(workspacePath: string): WorkflowStatus {
  const control = getQueueControl(workspacePath)
  if (control.state === 'idle') return getWorkflowStatus(workspacePath)
  setQueueControl(workspacePath, { ...control, state: 'paused' })
  const c = controllerFor(workspacePath)
  void c.request()
  return c.status
}

/** Resume a paused queue. */
export function resumeWorkflow(workspacePath: string): WorkflowStatus {
  const control = getQueueControl(workspacePath)
  if (control.state !== 'paused') return getWorkflowStatus(workspacePath)
  setQueueControl(workspacePath, { ...control, state: 'running' })
  const c = controllerFor(workspacePath)
  void c.request()
  return c.status
}

/**
 * Force-skip an intent for THIS queue's selection. It never marks the intent
 * `done` and never satisfies a dependency gate — downstream intents stay blocked.
 */
export function forceSkipIntent(workspacePath: string, intentId: string, skip: boolean): void {
  const control = getQueueControl(workspacePath)
  const next = new Set(control.forceSkipped)
  if (skip) next.add(intentId)
  else next.delete(intentId)
  setQueueControl(workspacePath, { ...control, forceSkipped: [...next] })
  void controllerFor(workspacePath).request()
}

/**
 * Clear an intent's park mark so the next pass re-evaluates it from scratch.
 * The consecutive-failure counter is reset too: an unpark is an explicit human
 * "try this again", and leaving the counter at the cap would re-park the intent
 * on its very first hiccup. Every hard gate is still re-checked next pass.
 */
export function unparkIntent(workspacePath: string, intentId: string): boolean {
  const prev = getQueueIntentMetaById(intentId)
  if (!prev.parked) return false
  putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    parked: false,
    parkReason: null,
    parkDetail: null,
    failureCount: 0,
    backoffUntil: null,
    updatedAt: Date.now(),
  })
  void controllerFor(workspacePath).request()
  return true
}

/**
 * Explicit human ruling over the queue's latest automatic verdict for an intent.
 * `continue` clears the park so the intent is re-evaluated; `block` parks it.
 * Neither marks the intent `done`, and neither bypasses a permission, spec,
 * dependency, concurrency, continuation-budget or commit/push gate — the next
 * pass re-checks all of them.
 */
export function overrideIntentDecision(
  workspacePath: string,
  intentId: string,
  decision: 'continue' | 'block',
  actor: string,
): boolean {
  const now = Date.now()
  const prev = getQueueIntentMetaById(intentId)
  if (decision === 'continue' && !prev.parked && prev.backoffUntil === null) return false
  putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    parked: decision === 'block',
    parkReason: decision === 'block' ? 'needs_human_decision' : null,
    parkDetail: decision === 'block' ? `人工裁决停止(${actor})` : null,
    failureCount: decision === 'continue' ? 0 : prev.failureCount,
    backoffUntil: null,
    updatedAt: now,
  })
  appendQueueDecisions([
    {
      tickId: controllers.get(workspacePath)?.tickId || 'override',
      workspacePath,
      intentId,
      decidedAt: now,
      action: decision === 'continue' ? 'launch' : 'park',
      blockedGate: 'needs_human_decision',
      rejectReason: `人工覆盖结论:${decision} by ${actor}`,
      attemptCount: prev.failureCount,
      backoffCount: prev.backoffCount,
      nextWakeupAt: null,
    },
  ])
  void controllerFor(workspacePath).request()
  return true
}

/**
 * Whether an intent's work session is currently driven by this workspace's
 * queue kernel — i.e. the kernel holds an in-flight run for it. The session-end
 * manual Git/PR cleanup uses this to skip queue-owned sessions (MSC-R1).
 */
export function isIntentDrivenByWorkflow(workspacePath: string, intentId: string): boolean {
  const c = controllers.get(workspacePath)
  return !!c && c.inFlightIntentIds.includes(intentId)
}

/**
 * Mark a workspace dirty. Events only ever say "look again" — they carry no
 * decision material, are never persisted and are never replayed, so losing one
 * costs at most one tick of latency.
 */
export function markQueueDirty(workspacePath: string): Promise<void> | undefined {
  const c = controllers.get(workspacePath)
  if (!c) return undefined
  return c.request()
}

/**
 * Notify the queue that an intent-linked session settled. Kept as the resident
 * subscription's entry point; it is now nothing more than a dirty mark.
 */
export function notifyTurnSettled(
  workspacePath: string,
  _sessionId: string,
  _reason: RunEndReason,
  _intentId: string,
): Promise<void> | undefined {
  return markQueueDirty(workspacePath)
}

/** The queue's per-intent view for the queue page. */
export interface QueueIntentView {
  intentId: string
  title: string
  blockedReason: string
  blockedDetail: string
  nextWakeupAt: number | null
  lastAction: string
  lastDecidedAt: number | null
  attemptCount: number
  backoffCount: number
  backoffUntil: number | null
  parked: boolean
  parkReason: string | null
  parkDetail: string | null
  forceSkipped: boolean
}

/** Build the queue detail projection for a workspace. */
export function getQueueDetail(workspacePath: string): {
  state: WorkflowStatus['state']
  tickId: string
  nextWakeupAt: number | null
  items: QueueIntentView[]
} {
  const c = controllers.get(workspacePath)
  const control = getQueueControl(workspacePath)
  const meta = getQueueIntentMeta(workspacePath)
  const latest = latestQueueDecisionByIntent(workspacePath)
  const decisions = new Map((c?.lastDecisions ?? []).map((d) => [d.intentId, d]))
  const skipped = new Set(control.forceSkipped)
  const intents = isStoreAvailable() ? listIntents(workspacePath) : []

  const items: QueueIntentView[] = intents
    .filter((r) => r.automate && (r.status === 'todo' || r.status === 'in_progress'))
    .map((r) => {
      const m = meta[r.id] ?? emptyQueueIntentMeta(r.id)
      const d = decisions.get(r.id)
      const prev = latest[r.id]
      return {
        intentId: r.id,
        title: r.title,
        blockedReason: d?.reason ?? prev?.blockedGate ?? '',
        blockedDetail: d?.detail ?? prev?.rejectReason ?? '',
        nextWakeupAt: d?.nextWakeupAt ?? prev?.nextWakeupAt ?? null,
        lastAction: d?.action ?? prev?.action ?? '',
        lastDecidedAt: prev?.decidedAt ?? null,
        attemptCount: m.failureCount,
        backoffCount: m.backoffCount,
        backoffUntil: m.backoffUntil,
        parked: m.parked,
        parkReason: m.parkReason,
        parkDetail: m.parkDetail,
        forceSkipped: skipped.has(r.id),
      }
    })

  return {
    state: getWorkflowStatus(workspacePath).state,
    tickId: c?.tickId ?? '',
    nextWakeupAt: c?.wakeupAt ?? null,
    items,
  }
}

// ---------------------------------------------------------------------------
// Tick loop + startup reconcile
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the fixed-cadence reconcile loop. Every workspace whose queue is running
 * or paused is woken on the same 10s cadence the automation scheduler uses; a
 * pass is idempotent, so an extra wake-up costs nothing but a re-derivation.
 */
export function startQueueTickLoop(tickMs = QUEUE_TICK_MS): void {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    for (const workspacePath of listActiveQueueWorkspaces()) {
      void controllerFor(workspacePath)
        .request()
        .catch((err) => console.error('[c3:queue] tick 失败:', err))
    }
  }, tickMs)
  // Never hold the process open for a background loop.
  tickTimer.unref?.()
}

/** Stop the reconcile loop (graceful shutdown / tests). */
export function stopQueueTickLoop(): void {
  if (tickTimer === null) return
  clearInterval(tickTimer)
  tickTimer = null
}

/**
 * Reconcile every workspace whose queue was left running before this process
 * started. Recovery is derived entirely from persisted facts: nothing is
 * invented when the database is unavailable, and nothing is cleared either —
 * a later tick reconciles once it comes back.
 */
export async function reconcileQueuesOnStartup(hooks: WorkflowHooks): Promise<number> {
  if (!isQueueStoreAvailable()) return 0
  const workspaces = listActiveQueueWorkspaces()
  for (const workspacePath of workspaces) {
    await controllerFor(workspacePath, hooks)
      .request()
      .catch((err) => console.error(`[c3:queue] 启动对账失败 (${workspacePath}):`, err))
  }
  return workspaces.length
}

/**
 * Test hook: run one pass, then await every kernel run it started (and any run
 * those starts in turn). Lets a test assert on the settled world rather than on
 * a timer.
 */
export async function settleQueueForTests(workspacePath: string): Promise<void> {
  const c = controllers.get(workspacePath)
  if (!c) return
  await c.request()
  await c.settleRuns()
  await c.request()
}

/** Test hook: drop every controller and stop the loop. */
export function resetWorkflowForTests(): void {
  stopQueueTickLoop()
  for (const c of controllers.values()) c.dispose()
  controllers.clear()
}
