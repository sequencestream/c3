/**
 * Queue scheduling kernel — fact/decision vocabulary.
 *
 * Everything here is data: the facts a reconcile pass reads, the decisions it
 * emits and the actions the assembly layer executes afterwards. No side effects,
 * no feature imports (ADR-0009 R1: kernel never imports features/transport).
 */
import type {
  GitBranchMode,
  IntentPrStatus,
  IntentPriority,
  IntentStatus,
} from '@ccc/shared/protocol'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Fixed reconcile cadence, matching the automation scheduler's tick. */
export const QUEUE_TICK_MS = 10_000

/** Consecutive failures after which an intent is parked instead of retried. */
export const QUEUE_MAX_ATTEMPTS = 3

/** First retry delay; doubles per consecutive failure. */
export const QUEUE_BACKOFF_BASE_MS = 30_000

/** Upper bound on the exponential backoff. */
export const QUEUE_BACKOFF_MAX_MS = 15 * 60_000

/**
 * Per-intent quiet window after the kernel issued a run for it. Prevents a tick
 * and a lifecycle event arriving back-to-back from launching the same intent
 * twice (self-excitation guard).
 */
export const QUEUE_COOLDOWN_MS = 5_000

/**
 * How long the QUEUE waits on a run that is paused on a permission prompt before
 * it stops tracking that intent. The permission DECISION itself never times out
 * and is never auto-answered (C-SEC-3) — only the queue's own waiting does.
 */
export const QUEUE_PERMISSION_WAIT_MS = 30 * 60_000

/** Stable tag stamped on every run the queue kernel itself starts. */
export const QUEUE_RUN_ORIGIN = 'queue-kernel'

/** Exponential backoff for the n-th consecutive failure (n ≥ 1). */
export function backoffDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0
  const raw = QUEUE_BACKOFF_BASE_MS * 2 ** (failureCount - 1)
  return Math.min(raw, QUEUE_BACKOFF_MAX_MS)
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** The ledger projection one reconcile pass reads per intent. */
export interface QueueIntentFact {
  id: string
  title: string
  status: IntentStatus
  priority: IntentPriority
  automate: boolean
  dependsOn: string[]
  specApproved: boolean
  prStatus: IntentPrStatus | null
  lastWorkSessionId: string | null
  createdAt: number
}

/** Liveness of one work session, probed against the run registry. */
export interface QueueRunFact {
  sessionId: string
  /** A turn is executing right now. */
  alive: boolean
  /**
   * Since when this run has been paused on a permission prompt (epoch ms), or
   * `null` when it is not waiting on a human.
   */
  awaitingPermissionSince: number | null
}

/**
 * The only scheduling state that is persisted. Everything else (run phase,
 * current session, gate results) is re-derived from the ledger + liveness on
 * every pass, so a lost row costs a retry at worst, never a stuck queue.
 */
export interface QueueIntentMeta {
  intentId: string
  /** Consecutive failures since the last real progress. */
  failureCount: number
  /** Total backoff waits served (audit counter, never reset by unpark). */
  backoffCount: number
  /** No retry before this instant; `null` when not backing off. */
  backoffUntil: number | null
  parked: boolean
  parkReason: QueueReasonCode | null
  parkDetail: string | null
  /** Self-excitation guard: no kernel run for this intent before this instant. */
  cooldownUntil: number | null
  updatedAt: number
}

/** Zero-value metadata for an intent the queue has never touched. */
export function emptyQueueIntentMeta(intentId: string): QueueIntentMeta {
  return {
    intentId,
    failureCount: 0,
    backoffCount: 0,
    backoffUntil: null,
    parked: false,
    parkReason: null,
    parkDetail: null,
    cooldownUntil: null,
    updatedAt: 0,
  }
}

/** User-controlled queue state for a workspace. */
export type QueueRunState = 'idle' | 'running' | 'paused'

export interface QueueControlFact {
  state: QueueRunState
  startedAt: number | null
  /**
   * Intents the user force-skipped. A skip only changes THIS queue's selection —
   * it never marks the intent `done` and never satisfies a dependency gate.
   */
  forceSkipped: readonly string[]
}

// ---------------------------------------------------------------------------
// Decisions & actions
// ---------------------------------------------------------------------------

/**
 * Structured, displayable reason codes. Never carries prompts, credentials,
 * permission bodies or transcript text.
 */
export type QueueReasonCode =
  // progress
  | 'selected'
  | 'attached_running'
  | 'resumed'
  | 'running'
  // queue-level
  | 'queue_idle'
  | 'queue_paused'
  | 'snapshot_unavailable'
  // gates
  | 'blocked_concurrency_gate'
  | 'blocked_dependency'
  | 'blocked_dependency_pr_unmerged'
  | 'blocked_spec_not_approved'
  | 'blocked_backoff'
  | 'blocked_parked'
  | 'blocked_cooldown'
  | 'blocked_force_skipped'
  // terminal / human
  | 'launch_failed'
  | 'needs_human_decision'
  | 'permission_wait_timeout'
  | 'max_attempts_reached'
  | 'budget_exhausted'
  | 'commit_failed'
  | 'turn_error'
  | 'judge_stuck'

/** What the kernel chose to do with one intent this pass. */
export type QueueDecisionAction =
  'launch' | 'resume' | 'attach' | 'wait' | 'park' | 'block' | 'skip'

export interface QueueDecision {
  intentId: string
  action: QueueDecisionAction
  reason: QueueReasonCode
  /** Short, displayable detail (dependency id, remaining backoff, …). */
  detail: string
  attemptCount: number
  backoffCount: number
  /** When this intent should be re-evaluated; `null` = next regular tick. */
  nextWakeupAt: number | null
}

/** A side effect the assembly layer performs after a pass. */
export type QueueAction =
  | { kind: 'launch'; intentId: string; origin: string }
  | { kind: 'resume'; intentId: string; sessionId: string; origin: string }
  | { kind: 'attach'; intentId: string; sessionId: string; origin: string }
  | { kind: 'park'; intentId: string; reason: QueueReasonCode; detail: string }
  | { kind: 'wait_user_involve'; intentId: string; reason: QueueReasonCode; detail: string }
  | { kind: 'sync_dependency_prs'; intentIds: string[] }

// ---------------------------------------------------------------------------
// Reconcile I/O
// ---------------------------------------------------------------------------

export interface QueueReconcileInput {
  now: number
  /** Stable id for this pass; stamped on every decision row it writes. */
  tickId: string
  workspacePath: string
  control: QueueControlFact
  /**
   * `false` when the ledger snapshot could not be read. The pass then fails
   * closed: no launches, no failure counting, one workspace-level decision.
   */
  snapshotOk: boolean
  intents: readonly QueueIntentFact[]
  runs: readonly QueueRunFact[]
  meta: Readonly<Record<string, QueueIntentMeta>>
  /** Intents the kernel currently holds an in-flight run for. */
  inFlight: readonly string[]
  gitBranchMode: GitBranchMode
  sddEnabled: boolean
}

/** Coarse queue state projected onto `WorkflowStatus.state`. */
export type QueueProjectedState =
  'idle' | 'paused' | 'running' | 'awaiting_gate' | 'developing' | 'done'

export interface QueueReconcileOutput {
  tickId: string
  state: QueueProjectedState
  actions: QueueAction[]
  decisions: QueueDecision[]
  /** Earliest instant the queue must wake up again. */
  nextWakeupAt: number
  currentIntentId: string | null
  currentSessionId: string | null
  awaitingPermission: boolean
}
