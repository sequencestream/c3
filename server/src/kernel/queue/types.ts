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
  SpecReviewVerdict,
  SpecStatus,
} from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'

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

/**
 * Hard ceiling on spec rework rounds before the queue stops re-launching the
 * author and escalates to a human todo. Mirrors the protocol constant; the kernel
 * keeps its own name so a reader of `reconcile.ts` sees the bound locally.
 */
export const QUEUE_MAX_SPEC_REWORK = MAX_SPEC_REVIEW_REWORK_ROUNDS

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
  /**
   * The spec document's lifecycle state — the authoritative spec-gate input.
   * `raw` means "still being authored" (no spec, or only the server's seed): it
   * is never reviewed and never blocks as "awaiting approval".
   */
  specStatus: SpecStatus
  /**
   * The intent's AGGREGATE PR status — one value reduced from every PR it owns
   * (`deriveIntentPrAggregate`), `null` when it owns none. The kernel gates on one
   * status per intent; the reduction happens at the assembly boundary so the
   * kernel stays a pure function and the UI cannot disagree with the gate.
   */
  prStatus: IntentPrStatus | null
  lastWorkSessionId: string | null
  createdAt: number
  // ── Spec-phase facts (SDD workspaces only) ──
  /** `null` when no spec has been authored yet. */
  specPath: string | null
  /** The spec-authoring session, when one exists. */
  specSessionId: string | null
  /** The most recent review session, when one exists. */
  specReviewSessionId: string | null
  /**
   * The spec file's fingerprint as the assembly layer just read it. `null` means
   * "no spec, or unreadable right now" — the kernel treats that as "cannot
   * review", never as changed content.
   */
  specFingerprint: string | null
  /** The stored conclusion, and the fingerprint it was produced against. */
  specReviewVerdict: SpecReviewVerdict | null
  specReviewFingerprint: string | null
  /** Rework rounds already spent; compared against {@link QUEUE_MAX_SPEC_REWORK}. */
  specReviewReworkRounds: number
  /** A human revoked an approval while THIS conclusion stood — do not re-approve it. */
  specReviewMachineApprovalBlocked: boolean
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
 * Every structured, displayable reason code, as a runtime list. The union type
 * is derived from it so the two can never drift, and a persistence boundary that
 * must reject an unknown value (the funnel event store) has a set to check
 * against instead of re-typing the union as data.
 */
export const QUEUE_REASON_CODES = [
  // progress
  'selected',
  'attached_running',
  'resumed',
  'running',
  // queue-level
  'queue_idle',
  'queue_paused',
  'snapshot_unavailable',
  // gates
  'blocked_concurrency_gate',
  'blocked_dependency',
  'blocked_dependency_pr_unmerged',
  'blocked_spec_not_approved',
  // spec phase (SDD): the sub-states `blocked_spec_not_approved` decomposes into
  // once the queue drives authoring → review → rework itself.
  'spec_authoring',
  'spec_reviewing',
  'spec_rework',
  'spec_review_running',
  'spec_awaiting_approval',
  'spec_machine_approved',
  'spec_rework_exhausted',
  'spec_unreadable',
  'blocked_backoff',
  'blocked_parked',
  'blocked_cooldown',
  'blocked_force_skipped',
  'blocked_chain_depth',
  // terminal / human
  'launch_failed',
  'needs_human_decision',
  'permission_wait_timeout',
  'max_attempts_reached',
  'budget_exhausted',
  'commit_failed',
  'turn_error',
  'judge_stuck',
  // The completion judge itself could not run (provider/model misconfigured, the
  // one-shot died). Distinct from `judge_stuck`: nothing was judged about the
  // intent, so this never reads as "a human is needed on the work".
  'judge_unavailable',
] as const

/**
 * Structured, displayable reason codes. Never carries prompts, credentials,
 * permission bodies or transcript text.
 */
export type QueueReasonCode = (typeof QUEUE_REASON_CODES)[number]

/** What the kernel chose to do with one intent this pass. */
export type QueueDecisionAction =
  | 'launch'
  | 'resume'
  | 'attach'
  | 'wait'
  | 'park'
  | 'block'
  | 'skip'
  // Spec-phase actions. Kept distinct from `launch`/`resume` (the work-session
  // verbs) so a decision log never conflates "started writing a spec" with
  // "started developing".
  | 'launch_spec'
  | 'launch_spec_review'
  | 'approve_spec'

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
  /**
   * 1-based place in the line among the candidates THIS pass left waiting on the
   * concurrency gate; `null` for every other verdict. Purely derived from this
   * pass's ordering and never persisted — the next pass recomputes it from the
   * facts it then sees, so a position may go up as well as down.
   */
  queuePosition: number | null
}

/** A side effect the assembly layer performs after a pass. */
export type QueueAction =
  | { kind: 'launch'; intentId: string; origin: string }
  | { kind: 'resume'; intentId: string; sessionId: string; origin: string }
  | { kind: 'attach'; intentId: string; sessionId: string; origin: string }
  | { kind: 'park'; intentId: string; reason: QueueReasonCode; detail: string }
  | { kind: 'wait_user_involve'; intentId: string; reason: QueueReasonCode; detail: string }
  | { kind: 'sync_dependency_prs'; intentIds: string[] }
  /**
   * Start or resume the spec-AUTHORING session. `rework` is set after a
   * `changes_requested` conclusion: the assembly layer then hands the author the
   * reviewer's findings instead of a plain "continue".
   */
  | {
      kind: 'launch_spec'
      intentId: string
      origin: string
      rework: boolean
      /** Which rework round this is (1-based); `0` for a first authoring pass. */
      reworkRound: number
    }
  /** Start a read-only review of the spec content identified by `fingerprint`. */
  | { kind: 'launch_spec_review'; intentId: string; origin: string; fingerprint: string }
  /**
   * Approve the spec on the machine's behalf. Only ever emitted when the
   * workspace opt-in is ON and the conclusion is a `pass` bound to `fingerprint`;
   * the assembly layer re-checks every one of those facts transactionally before
   * writing, so a spec edited or an approval revoked in between approves nothing.
   */
  | { kind: 'machine_approve_spec'; intentId: string; fingerprint: string }

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
  /**
   * The workspace's explicit machine-approval opt-in. `false` by default and for
   * every migrated workspace: with it off, a `pass` conclusion still stops at the
   * human approval checkpoint and no `machine_approve_spec` action is ever
   * produced — the kernel does not merely skip executing one, it never emits one.
   */
  machineApprovalEnabled: boolean
  /**
   * The workspace's automation-queue concurrent-DEV cap. Effective cap is this
   * value under `worktree`, and hard-coded 1 under `current-branch` (shared
   * checkout, RM-A12 file safety). Spec authoring/review is never counted, and
   * lowering the cap never cancels in-flight runs.
   */
  automationConcurrency: number
  /**
   * Liveness of the spec-authoring / spec-review sessions, probed the same way as
   * {@link runs}. An intent with a live spec-phase run is waited on, never
   * re-launched.
   */
  specRuns: readonly QueueSpecRunFact[]
  /** Intents the kernel currently holds an in-flight SPEC-PHASE run for. */
  specInFlight: readonly string[]
}

/** Liveness of one spec-phase session (authoring or review). */
export interface QueueSpecRunFact {
  sessionId: string
  alive: boolean
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
