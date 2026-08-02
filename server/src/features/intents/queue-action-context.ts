/**
 * Shared vocabulary between the queue controller and its action executors.
 *
 * The controller (`workflow.ts`) owns the queue's lifecycle: it collects facts,
 * calls the pure kernel, writes decisions and projects status. The action
 * families own the side effects. This module carries only what the two must
 * agree on — the injected hooks bag, the in-flight run record, and the narrow
 * window an executor gets onto controller state.
 *
 * Deliberately NOT here: fact collection, decision-log writes and the
 * `WorkflowStatus` / queue-detail projections. Those stay in the control layer,
 * so an executor can never quietly become a second scheduler.
 */
import type { WorkflowStatus } from '@ccc/shared/protocol'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import type { SessionRuntime } from '../../runs.js'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import type { QueueAction, QueueReasonCode } from '../../kernel/queue/index.js'

// ---------------------------------------------------------------------------
// Injected side effects
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
  /**
   * Launch one turn on a spec-phase runtime (authoring or review). The queue
   * hands this straight to the shared session launchers, so a spec session the
   * queue starts is byte-for-byte the same launch a human button produces —
   * including the read-only / write-confined profile locks. Injected rather than
   * imported so this module keeps no `kernel/run` dependency.
   */
  launchSpecRun(rt: SessionRuntime, prompt: string): Promise<void>
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
// Execution context
// ---------------------------------------------------------------------------

/** One kernel-owned run in flight. */
export interface InFlightRun {
  intentId: string
  phase: 'developing' | 'fixing'
  sessionId: string | null
  /** Settles when the whole develop loop for this intent is over. */
  settled: Promise<void>
}

/**
 * What an action executor is allowed to touch. Everything here is a capability
 * the controller hands out per pass — executors hold no module-level singleton
 * of their own, so the controller stays the single owner of queue state.
 */
export interface QueueActionContext {
  readonly workspacePath: string
  readonly hooks: WorkflowHooks
  /**
   * Abort signal of the controller generation that issued this action. A user
   * stop swaps the controller's signal, so an executor started before the stop
   * still observes the abort it was launched under.
   */
  readonly signal: AbortSignal
  /** The controller was disposed — unwind without further effects. */
  isDisposed(): boolean
  /** Tick id of the pass that produced this action; stamped on decision rows. */
  tickId(): string
  /** Ask the controller for another reconcile pass. */
  requestPass(): void
  /** Assign the coarse queue state and emit (the lint-fix phase does this). */
  setState(state: WorkflowStatus['state']): void
  /** Assign the latest checkpoint consensus and emit. */
  setCheckpointConsensus(consensus: WorkflowStatus['checkpointConsensus']): void
  /** Assign `awaitingPermission` and emit, but only when it actually changed. */
  setAwaiting(awaiting: boolean): void
  /** Assign the current session id WITHOUT emitting — an intents broadcast follows. */
  setCurrentSessionId(sessionId: string): void
  /** Append to the completed projection WITHOUT emitting — a broadcast follows. */
  markCompleted(intentId: string): void
}

// ---------------------------------------------------------------------------
// The dispatch contract
// ---------------------------------------------------------------------------

/**
 * One executor per kernel action kind. Keyed by a mapped type over
 * `QueueAction['kind']`, so a dispatch table typed with it is exhaustive at
 * COMPILE time: dropping an existing kind, or adding a new one to the kernel
 * without registering an executor, fails `tsc`. There is deliberately no
 * parallel `switch` — the table is the only route from an action to an effect.
 */
export type QueueActionExecutors = {
  [K in QueueAction['kind']]: (action: Extract<QueueAction, { kind: K }>, now: number) => void
}

/**
 * Invoke one entry. The single cast is where the discriminated union is
 * re-joined; {@link QueueActionExecutors} is what carries the exhaustiveness
 * guarantee, so nothing is weakened by it.
 */
export function runQueueAction(
  table: QueueActionExecutors,
  action: QueueAction,
  now: number,
): void {
  const exec = table[action.kind] as (a: QueueAction, now: number) => void
  exec(action, now)
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * The actor recorded for spec sessions the QUEUE starts. Distinct from the
 * machine APPROVER identity: this only says "the automation started this
 * session", which carries no authority, whereas `MACHINE_SPEC_APPROVER` records
 * who cleared a human gate.
 */
export const QUEUE_ACTOR = 'automation'

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
