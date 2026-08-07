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
 *     → actions dispatched to the action families
 *
 * Nothing depends on a particular event arriving. Events do not carry decision
 * material; they only say "look again". A dropped `run:settled` therefore costs
 * one tick of latency instead of stalling the queue forever, and a crash or
 * restart is recovered by re-deriving state from the ledger.
 *
 * ── What lives here, and what does not ───────────────────────────────────────
 * This file is the queue's CONTROL layer: the hooks bag, `pickNext`, the
 * per-workspace controller and its lifecycle, the manual control surface, the
 * tick loop and the startup reconcile — plus one exhaustive
 * `QueueAction.kind → executor` table, the only route from a kernel action to a
 * side effect. Its control-layer companions are `queue-ledger.ts` (facts in,
 * decision rows out) and `queue-projection.ts` (the read models).
 *
 * The side effects belong to the action families, one module each:
 * `queue-spec-actions.ts` (spec authoring, review, machine approval),
 * `queue-dev-actions.ts` (the development loop, commit/push, PR) and
 * `queue-outcome-actions.ts` (park, human todos, the failure ladder — where the
 * per-intent backoff → park ladder that isolates every failure is enforced).
 *
 * Nothing in this driver answers a permission prompt, marks an intent `done`
 * outside the existing judge → commit → push path, or relaxes a hard gate.
 */
import { randomUUID } from 'node:crypto'
import type { WorkflowStatus, Intent, RunEndReason } from '@ccc/shared/protocol'
import type { QueueAction, QueueDecision, QueueReconcileOutput } from '../../kernel/queue/index.js'
import {
  CoalescingRunner,
  QUEUE_COOLDOWN_MS,
  QUEUE_TICK_MS,
  reconcileQueue,
} from '../../kernel/queue/index.js'
import { getIntent, isStoreAvailable, listIntents } from './store.js'
import {
  getQueueControl,
  getQueueIntentMeta,
  getQueueIntentMetaById,
  isQueueStoreAvailable,
  listActiveQueueWorkspaces,
  putQueueIntentMeta,
  setQueueControl,
  type QueueControlRow,
} from './queue-store.js'
import {
  getAutomationConcurrency,
  getDefaultMainBranch,
  getGitBranchMode,
  getSddEnabled,
  getSpecMachineApprovalEnabled,
} from '../../kernel/config/index.js'
import {
  errText,
  runQueueAction,
  type InFlightRun,
  type QueueActionContext,
  type QueueActionExecutors,
  type WorkflowHooks,
} from './queue-action-context.js'
import { persistNewDecisions, probeRunFacts, probeSpecRunFacts, toFact } from './queue-ledger.js'
import { deliveryGateFacts } from './delivery-context.js'
import {
  buildQueueDetail,
  idleStatus,
  projectStatus,
  type QueueDetailView,
} from './queue-projection.js'
import { executeMachineApproveSpec, runSpecPhase } from './queue-spec-actions.js'
import { runDevelopLoop } from './queue-dev-actions.js'
import {
  applyHumanOverride,
  clearPark,
  executePark,
  executeSyncDependencyPrs,
  executeUnpark,
  executeWaitUserInvolve,
  recordFailure,
} from './queue-outcome-actions.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Defined in `queue-action-context.ts` (the executors need them too) and
// re-exported here, so every existing importer of `workflow.js` is unchanged.
export type {
  DevTurnResult,
  RunDevTurnInput,
  QueueUserTodoInput,
  WorkflowHooks,
} from './queue-action-context.js'

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
// Selection probe
// ---------------------------------------------------------------------------

/**
 * The next intent the queue would select, by the CURRENT facts. Exported for
 * tests and for the intent list's "eligible" affordance; it reads the same pure
 * kernel the driver does, so the two can never disagree.
 */
export function pickNext(workspacePath: string): Intent | null {
  if (!isStoreAvailable()) return null
  const intents = listIntents(workspacePath)
  const sddEnabled = getSddEnabled(workspacePath)
  const out = reconcileQueue({
    now: Date.now(),
    tickId: 'probe',
    workspacePath,
    control: { state: 'running', startedAt: null, forceSkipped: [] },
    snapshotOk: true,
    intents: intents.map((r) => toFact(r, workspacePath, sddEnabled)),
    runs: [],
    meta: getQueueIntentMeta(workspacePath),
    inFlight: [],
    gitBranchMode: getGitBranchMode(workspacePath),
    defaultMainBranch: getDefaultMainBranch(workspacePath) ?? null,
    deliveries: deliveryGateFacts(workspacePath),
    sddEnabled,
    // A probe answers "which intent would be DEVELOPED next", so it deliberately
    // reports the world as if no spec phase were running: it reads no spec
    // liveness and never lets the machine-approval path colour the answer.
    machineApprovalEnabled: false,
    // The probe reports an empty world (no in-flight runs, no live sessions), so
    // the concurrency cap is never reached here; the real value is passed so the
    // kernel contract stays honest and the preview matches a cold queue.
    automationConcurrency: getAutomationConcurrency(workspacePath),
    specRuns: [],
    specInFlight: [],
  })
  const chosen = out.actions.find((a) => a.kind === 'launch' || a.kind === 'resume')
  if (!chosen) return null
  return intents.find((r) => r.id === chosen.intentId) ?? null
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class QueueController {
  readonly status: WorkflowStatus
  private abort = new AbortController()
  private readonly runner: CoalescingRunner
  private readonly inFlight = new Map<string, InFlightRun>()
  /**
   * Spec-phase runs in flight, keyed by intent id. Deliberately NOT merged into
   * {@link inFlight}: that map answers "is the kernel developing this intent",
   * which the concurrency gate and the manual-cleanup skip both read. A spec
   * session appearing there would read as development that never happened.
   */
  private readonly specInFlight = new Map<string, Promise<void>>()
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
    this.specInFlight.clear()
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

  /** Await every in-flight kernel run — work AND spec phase (tests sequence on this). */
  async settleRuns(): Promise<void> {
    // A run that finishes may start another (the queue moves on), so drain.
    for (let i = 0; i < 50 && (this.inFlight.size > 0 || this.specInFlight.size > 0); i++) {
      await Promise.allSettled([
        ...[...this.inFlight.values()].map((r) => r.settled),
        ...this.specInFlight.values(),
      ])
    }
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

    const sddEnabled = getSddEnabled(this.workspacePath)
    const output = reconcileQueue({
      now,
      tickId,
      workspacePath: this.workspacePath,
      control,
      snapshotOk,
      intents: (intents ?? []).map((r) => toFact(r, this.workspacePath, sddEnabled)),
      runs: probeRunFacts(intents ?? [], now, this.hooks, this.awaitingSince),
      meta: getQueueIntentMeta(this.workspacePath),
      inFlight: this.inFlightIntentIds,
      gitBranchMode: getGitBranchMode(this.workspacePath),
      defaultMainBranch: getDefaultMainBranch(this.workspacePath) ?? null,
      deliveries: deliveryGateFacts(this.workspacePath),
      sddEnabled,
      // Read fresh every pass: turning the opt-in off must take effect on the very
      // next tick, without restarting the queue.
      machineApprovalEnabled: getSpecMachineApprovalEnabled(this.workspacePath),
      // Read fresh every pass too: a saved concurrency cap takes effect on the
      // very next tick, without restarting the queue.
      automationConcurrency: getAutomationConcurrency(this.workspacePath),
      specRuns: probeSpecRunFacts(intents ?? [], this.hooks, now),
      specInFlight: [...this.specInFlight.keys()],
    })

    this.decisions = output.decisions
    this.nextWakeupAt = output.nextWakeupAt
    persistNewDecisions(this.workspacePath, output, now)
    this.execute(output.actions, now)
    this.project(output, control)
  }

  // ── Action dispatch ───────────────────────────────────────────────────────

  /**
   * Dispatch this pass's actions in the order the kernel produced them. Sync
   * actions take effect immediately; the two run-starting families register
   * their in-flight entry synchronously and then run for minutes, so a pass
   * never waits on one.
   */
  private execute(actions: readonly QueueAction[], now: number): void {
    const ctx = this.actionContext()
    // The table is typed exhaustively over `QueueAction['kind']`: a kernel
    // action with no executor here is a compile error, never a silent no-op.
    const table: QueueActionExecutors = {
      park: (a) => executePark(ctx, a),
      unpark: (a) => executeUnpark(ctx, a),
      wait_user_involve: (a) => executeWaitUserInvolve(ctx, a),
      sync_dependency_prs: (a) => executeSyncDependencyPrs(ctx, a),
      launch: (a, at) => this.startRun(ctx, a, at),
      resume: (a, at) => this.startRun(ctx, a, at),
      attach: (a, at) => this.startRun(ctx, a, at),
      launch_spec: (a, at) => this.startSpecRun(ctx, a, at),
      launch_spec_review: (a, at) => this.startSpecRun(ctx, a, at),
      machine_approve_spec: (a) => executeMachineApproveSpec(ctx, a),
    }
    for (const action of actions) runQueueAction(table, action, now)
  }

  /**
   * The narrow window the executors get onto controller state. Rebuilt each pass
   * so an executor always observes the CURRENT abort generation; nothing here
   * hands out a second copy of scheduling state.
   */
  private actionContext(): QueueActionContext {
    const signal = this.abort.signal
    return {
      workspacePath: this.workspacePath,
      hooks: this.hooks,
      signal,
      isDisposed: () => this.disposed,
      tickId: () => this.lastTickId,
      requestPass: () => void this.request(),
      setState: (state) => {
        this.status.state = state
        this.emit()
      },
      setCheckpointConsensus: (consensus) => {
        this.status.checkpointConsensus = consensus
        this.emit()
      },
      setAwaiting: (awaiting) => this.setAwaiting(awaiting),
      setCurrentSessionId: (sessionId) => {
        this.status.currentSessionId = sessionId
      },
      markCompleted: (intentId) => {
        this.status.completedIds.push(intentId)
      },
    }
  }

  /**
   * Start ONE development run for an intent. The cooldown is written before the
   * run exists and the in-flight entry is registered synchronously, so a tick and
   * a lifecycle event racing each other can never produce a second launch.
   */
  private startRun(
    ctx: QueueActionContext,
    action: Extract<QueueAction, { kind: 'launch' | 'resume' | 'attach' }>,
    now: number,
  ): void {
    const intentId = action.intentId
    if (this.inFlight.has(intentId)) return
    const req = getIntent(intentId)
    if (!req) return

    this.writeCooldown(intentId, now)
    const record: InFlightRun = {
      intentId,
      phase: 'developing',
      sessionId: action.kind === 'launch' ? null : action.sessionId,
      settled: Promise.resolve(),
    }
    this.inFlight.set(intentId, record)
    record.settled = this.observe(ctx, runDevelopLoop(ctx, action, req, record), {
      intentId,
      title: req.title,
      label: '内核 run',
      unregister: () => this.inFlight.delete(intentId),
    })
  }

  /**
   * Start ONE spec-phase run (authoring or review). Tracked in its own in-flight
   * map, separate from work runs: sharing a map would let a spec session
   * masquerade as a development run to the concurrency gate. The cooldown IS
   * shared — it is a per-intent self-excitation guard, and an intent in its spec
   * phase is blocked from development anyway.
   */
  private startSpecRun(
    ctx: QueueActionContext,
    action: Extract<QueueAction, { kind: 'launch_spec' | 'launch_spec_review' }>,
    now: number,
  ): void {
    const intentId = action.intentId
    if (this.specInFlight.has(intentId)) return
    const req = getIntent(intentId)
    if (!req) return

    this.writeCooldown(intentId, now)
    this.specInFlight.set(
      intentId,
      this.observe(ctx, runSpecPhase(ctx, action, req), {
        intentId,
        title: req.title,
        label: '规格阶段 run',
        unregister: () => this.specInFlight.delete(intentId),
      }),
    )
  }

  /**
   * Observe a run the pass does not await — a dev turn outlives a tick by
   * minutes. Both families go through here, so no path can leave an exception
   * unobserved: a throw is ONE failed attempt for THAT intent (backoff, then
   * park at the cap), and either way the queue is marked dirty once it settles.
   */
  private observe(
    ctx: QueueActionContext,
    run: Promise<void>,
    on: { intentId: string; title: string; label: string; unregister: () => void },
  ): Promise<void> {
    return run
      .catch((err) => {
        console.error(`[c3:queue]「${on.title}」${on.label} 异常:`, err)
        recordFailure(ctx, on.intentId, 'launch_failed', errText(err))
      })
      .finally(() => {
        on.unregister()
        void this.request()
      })
  }

  /** The per-intent quiet window, written BEFORE the run exists. */
  private writeCooldown(intentId: string, now: number): void {
    const meta = getQueueIntentMetaById(intentId)
    putQueueIntentMeta(this.workspacePath, {
      ...meta,
      intentId,
      cooldownUntil: now + QUEUE_COOLDOWN_MS,
      updatedAt: now,
    })
  }

  // ── Status projection ─────────────────────────────────────────────────────

  private project(output: QueueReconcileOutput, control: QueueControlRow): void {
    const fixing = [...this.inFlight.values()].some((r) => r.phase === 'fixing')
    projectStatus(this.status, output, control, fixing)
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

/** Clear an intent's park mark so the next pass re-evaluates every gate afresh. */
export function unparkIntent(workspacePath: string, intentId: string): boolean {
  if (!clearPark(workspacePath, intentId)) return false
  void controllerFor(workspacePath).request()
  return true
}

/**
 * Explicit human ruling over the queue's latest automatic verdict for an intent.
 * It only rewrites this intent's scheduling metadata — every hard gate is
 * re-checked by the pass it then requests.
 */
export function overrideIntentDecision(
  workspacePath: string,
  intentId: string,
  decision: 'continue' | 'block',
  actor: string,
): boolean {
  const tickId = controllers.get(workspacePath)?.tickId || 'override'
  if (!applyHumanOverride(workspacePath, intentId, decision, actor, tickId)) return false
  void controllerFor(workspacePath).request()
  return true
}

/**
 * Whether an intent's work session is currently driven by this workspace's
 * queue kernel — i.e. the kernel holds an in-flight run for it. The session-end
 * manual Git/PR cleanup uses this to skip queue-owned sessions.
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

// ---------------------------------------------------------------------------
// Queue detail projection
// ---------------------------------------------------------------------------

export type { QueueIntentView } from './queue-projection.js'

/** Build the queue detail projection for a workspace. */
export function getQueueDetail(workspacePath: string): QueueDetailView {
  const c = controllers.get(workspacePath)
  return buildQueueDetail(workspacePath, {
    state: getWorkflowStatus(workspacePath).state,
    tickId: c?.tickId ?? '',
    nextWakeupAt: c?.wakeupAt ?? null,
    decisions: c?.lastDecisions ?? [],
  })
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
