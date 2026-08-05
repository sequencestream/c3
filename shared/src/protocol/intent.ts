/**
 * Intent engineering: intents, specs, dev sessions, logs, workflow and queue.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { CheckpointConsensusOutcome } from './consensus.js'
import type { VendorId } from './vendor.js'

// ---- Intent management ----

/** Intent priority. `P0` highest … `P3` lowest. */
export type IntentPriority = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * Intent lifecycle status.
 * - `draft` — captured but not yet finalized (optional).
 * - `todo` — finalized, not started (the state save-to-db produces).
 * - `in_progress` — work launched (work session running).
 * - `done` / `cancelled` — terminal, set by the user (never auto-set).
 * - `blocked` — interrupted by a dependency rollback, rebase conflict, etc.
 *   May re-enter `todo` once unblocked.
 * - `failed` — CI / build / test failure hit while `in_progress`.
 *   May re-enter `todo` for a retry.
 */
export type IntentStatus =
  'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled' | 'blocked' | 'failed'

/**
 * Coarse-grained phase of a manual `start_development` launch, carried by the
 * connection-directed {@link dev_launch_progress} event so the client can drive
 * a startup-progress overlay. Deliberately minimal — only the user-meaningful
 * phases, never paths / commands / error detail (so no internal information
 * leaks). The success terminal is NOT a stage: it is derived from the intent
 * flipping to `in_progress` in the regular `intents` broadcast.
 * - `fetching-remote-main` — before the worktree base fetch.
 * - `preparing-worktree` — before worktree create / branch pull.
 * - `launching` — before the dev agent process is spawned.
 * - `failed` — asynchronous launch failure (after the handler returned).
 */
export const DEV_LAUNCH_STAGES = [
  'fetching-remote-main',
  'preparing-worktree',
  'launching',
  'failed',
] as const
export type DevLaunchStage = (typeof DEV_LAUNCH_STAGES)[number]

/**
 * Coarse-grained phase of a manual `create_pr` run, carried by the
 * connection-directed {@link create_pr_progress} event so the client can drive a
 * PR-creation progress overlay. Like {@link DevLaunchStage} it is deliberately
 * minimal — only the user-meaningful phases, never paths / commands / error
 * detail. Stages advance one-way and are never re-sent for the same run; the
 * terminals are NOT stages: success is the existing `create_pr_response`, and
 * failure is the existing intent-action `error` frame.
 * - `analyzing-changes` — before the worktree-vs-local-`main` diff check.
 * - `committing` — before staging + committing in the intent worktree.
 * - `pushing` — before pushing the branch to the remote.
 * - `creating-pr` — before the forge PR-create call.
 */
export const CREATE_PR_STAGES = [
  'analyzing-changes',
  'committing',
  'pushing',
  'creating-pr',
] as const
export type CreatePrStage = (typeof CREATE_PR_STAGES)[number]

/** Coarse startup phases for a manual spec-authoring session. */
export const SPEC_LAUNCH_STAGES = [
  'checking-dependencies',
  'pulling-code',
  'launching',
  'failed',
] as const
export type SpecLaunchStage = (typeof SPEC_LAUNCH_STAGES)[number]

/**
 * Derived run-state of an in_progress intent, computed by reconciling the
 * intent's lastWorkSessionId liveness against the process table.
 * - `running` — the work session's process is still alive (tracking in-flight).
 * - `dangling` — the dev process is dead but the intent is still in_progress
 *   (service restart / crash); a completion judge found the intent not done.
 * - `idle` — not in_progress, or the dev process ended and the judge confirmed done
 *   (just done, or never started).
 */
export type IntentRunStatus = 'running' | 'dangling' | 'idle'

/**
 * PR (Pull Request) lifecycle status for an intent.
 * - `reviewing` — PR created, awaiting review.
 * - `rejected` — review rejected (changes requested).
 * - `failed` — CI / merge check failed.
 * - `merged` — PR merged into target branch.
 * - `closed` — PR closed without merging.
 * - `null` — no PR has been created yet (or PR status is unknown).
 * Independent of the intent's own `status` — a PR has its own lifecycle.
 */
export type IntentPrStatus = 'reviewing' | 'rejected' | 'failed' | 'merged' | 'closed'

/**
 * Dependency type for an intent_deps edge.
 * - `blocks` — hard dependency: the dependent intent cannot proceed until this dep is done.
 * - `informs` — knowledge dependency: information from the dep informs the dependent, but
 *   does not block it. The dep's content / code provides context or reference.
 * - `soft_after` — soft ordering: the dependent should run after the dep (avoid conflict),
 *   but can proceed without it if needed.
 */
export type DepType = 'blocks' | 'informs' | 'soft_after'

/**
 * The conclusion a read-only `spec_review` session reports through its narrow
 * submit tool. Deliberately a closed enum submitted explicitly — a conclusion is
 * never inferred from free text or from how the review run happened to end.
 * - `pass`              — the spec is good enough to develop against.
 * - `changes_requested` — the spec needs rework before development may start.
 */
export type SpecReviewVerdict = 'pass' | 'changes_requested'

/** All {@link SpecReviewVerdict} values, for runtime validation. */
export const SPEC_REVIEW_VERDICTS = [
  'pass',
  'changes_requested',
] as const satisfies readonly SpecReviewVerdict[]

/**
 * The reserved identity written into `Intent.specApproveUser` when the queue
 * approved a spec under the workspace's machine-approval opt-in. It is NOT a
 * login subject and can never collide with one (the `c3:` prefix is reserved), so
 * "who approved this" stays honest and the UI can render machine vs human
 * approval differently.
 */
export const MACHINE_SPEC_APPROVER = 'c3:machine-spec-approver'

/**
 * Hard ceiling on spec rework rounds. After this many `changes_requested`
 * conclusions the queue stops re-launching the author and escalates to a human
 * todo instead — bounding both token spend and the risk of never converging.
 */
export const MAX_SPEC_REVIEW_REWORK_ROUNDS = 3

// ---- Action descriptor (derived next-step projection) ----

/**
 * The stable reason code behind a derived {@link ActionDescriptor}. It is a
 * localization code, not a message: the client owns the wording, the server only
 * says which situation it is. Deliberately closed and narrow — a code is added
 * only when a concrete blocked state needs its own next step.
 * - `vendor_auth_invalid`          — the vendor rejected the agent's credentials
 *   (401 / unauthorized / invalid api key or token).
 * - `vendor_quota_exhausted`       — the vendor reports no usable quota left and
 *   no automatic recovery is scheduled for it.
 * - `spec_awaiting_approval`       — SDD is on, the intent has a written spec, and
 *   it has not been approved yet.
 * - `spec_rework_exhausted`        — automatic spec rework has run out of rounds
 *   and the still-valid conclusion asks for changes: only a human moves it now.
 * - `permission_pending`           — a gated tool call is waiting on Allow/Deny.
 * - `ask_user_question_pending`    — an unanswered `AskUserQuestion` is waiting.
 */
export const ACTION_LABEL_CODES = [
  'vendor_auth_invalid',
  'vendor_quota_exhausted',
  'spec_awaiting_approval',
  'spec_rework_exhausted',
  'permission_pending',
  'ask_user_question_pending',
] as const

export type ActionLabelCode = (typeof ACTION_LABEL_CODES)[number]

/**
 * Open the system-settings Agent tab at one specific agent row. `vendor` gives
 * the configuration context (and is the fallback anchor when the agent row is
 * gone), `agentId` pins the exact row that failed.
 */
export interface SystemSettingsAgentTarget {
  type: 'system-settings-agent'
  vendor: VendorId
  agentId: string
}

/**
 * Open an intent's detail page on the spec document tab — where a human reads the
 * review facts and either approves the spec or takes the rework over by hand.
 */
export interface IntentSpecTarget {
  type: 'intent-spec'
  intentId: string
}

/**
 * Open WorkCenter notifications and select one wait-user-involve event — the
 * Allow/Deny or AskUserQuestion answer surface for that pending item.
 */
export interface WorkcenterEventTarget {
  type: 'workcenter-event'
  eventId: string
}

/**
 * Where a next-step action navigates to. A discriminated union on `type` so a
 * later blocked state adds an arm instead of widening this one. Navigation only:
 * a target never carries a URL, a command, or free-text payload, so a client can
 * never be steered anywhere the union does not already name.
 */
export type ActionTarget = SystemSettingsAgentTarget | IntentSpecTarget | WorkcenterEventTarget

/**
 * One derived "next step" for a blocked state — the minimal pair of what to show
 * ({@link labelCode}) and where it goes ({@link target}).
 *
 * A **runtime display projection**, never a business state: it is re-derived on
 * every send from facts that already exist, is not persisted, and carries no
 * credential, raw vendor error, or provider response body.
 */
export interface ActionDescriptor {
  /** Stable localization code for the prompt + button wording. */
  labelCode: ActionLabelCode
  /** Where the action navigates. */
  target: ActionTarget
}

/** One dependency edge in intent_deps, with type metadata. */
export interface DependencyInfo {
  /** The id of the depended-on intent. */
  dependsOnId: string
  /** The type of this dependency relationship. */
  depType: DepType
  /** When this dependency was created (epoch ms). */
  createdAt: number
}

/** One persisted intent, scoped to a project (workspace path). */
export interface Intent {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  workspaceId: string
  title: string
  /**
   * Short ASCII English title (≤128 chars persisted), the stable source for
   * deriving the branch / worktree slug. `null` for historic rows created before
   * this field existed (backfilled only when the intent is next refined).
   */
  shortEnTitle: string | null
  content: string
  priority: IntentPriority
  /** Owning module name, inferred by the comm agent from title/content. `''` when historic/unidentified. */
  module: string
  status: IntentStatus
  /** Ids of other intents (same project) this one depends on. */
  dependsOn: string[]
  /** Dep types keyed by depended-on intent id. Absent entries default to 'blocks'. */
  dependsOnTypes?: Record<string, DepType>
  /** The last work session launched for this intent, for the detail back-link. */
  lastWorkSessionId: string | null
  /**
   * Whether the automation orchestrator may pick this intent up. User-toggled
   * (a checkbox per intent); `false` by default. Only `automate` intents
   * are developed by `start_workflow`.
   */
  automate: boolean
  createdAt: number
  updatedAt: number
  /** When the intent entered `done`; `null` until completed, cleared if it leaves `done`. */
  completedAt: number | null
  /**
   * Derived run-state of an `in_progress` intent, computed at list-time by
   * the server's reconcile logic. `'idle'` for other statuses. Clients use this
   * to render a "tracking" badge or a "dangling" warning next to an in_progress item.
   */
  runStatus: IntentRunStatus
  /** Git branch name the work session operates on; `null` when unknown. */
  branchName: string | null
  /** Latest known commit hash on the dev branch; `null` when unknown. */
  latestCommitHash: string | null
  /** PR / Merge Request id (e.g. GitHub PR number); `null` when no PR yet. */
  prId: string | null
  /** Clickable PR link (e.g. the GitHub PR URL); `null` when no PR yet. Distinct from `prId`. */
  prUrl: string | null
  /** PR lifecycle status; `null` when no PR yet or status is unknown. */
  prStatus: IntentPrStatus | null
  /**
   * Path (relative to the workspace) of this intent's written spec document;
   * `null` until a spec has been authored. The source of truth for the spec
   * quality gate's "spec exists" check.
   */
  specPath: string | null
  /**
   * Whether the intent's spec has passed the human approval checkpoint. `false`
   * by default (and for historic rows); set `true` only at explicit approval.
   * Persisted so the quality-gate state survives reconnect / refresh.
   */
  specApproved: boolean
  /**
   * Who approved the spec; `null` until approved. Either the approving user's
   * id/handle, or the reserved {@link MACHINE_SPEC_APPROVER} constant when the
   * queue approved it under the workspace's machine-approval opt-in. The constant
   * never impersonates a login subject, so the UI can always tell the two apart.
   */
  specApproveUser: string | null
  /**
   * The c3SessionId of the session that authored / refined the spec; `null` when
   * none. Distinct from `lastWorkSessionId` (the work session).
   */
  specSessionId: string | null
  /**
   * The c3SessionId of the read-only session that last reviewed the spec; `null`
   * when the spec was never reviewed. Distinct from {@link specSessionId} — the
   * author and the reviewer are separate sessions with separate permissions.
   */
  specReviewSessionId: string | null
  /** The current review conclusion; `null` when no valid conclusion exists. */
  specReviewVerdict: SpecReviewVerdict | null
  /** The reviewer's rationale for {@link specReviewVerdict}; `null` when none. */
  specReviewReason: string | null
  /** When the current conclusion was produced (epoch ms); `null` when none. */
  specReviewAt: number | null
  /**
   * The spec-content fingerprint the current conclusion was produced against. A
   * conclusion is only valid while this equals the spec file's live fingerprint —
   * editing the spec invalidates it and the flow reviews the new content.
   */
  specReviewFingerprint: string | null
  /**
   * How many rework rounds this intent's spec has been through (a
   * `changes_requested` conclusion that sent the author back). `0` for historic
   * rows; capped by {@link MAX_SPEC_REVIEW_REWORK_ROUNDS}.
   */
  specReviewReworkRounds: number
  /**
   * `true` when a human revoked an approval while this exact conclusion stood, so
   * the queue must not machine-approve the SAME conclusion again on the next tick.
   * Only a fresh valid conclusion or a human approval clears it.
   */
  specReviewMachineApprovalBlocked: boolean
  /**
   * The c3SessionId of the intent's refine / communication session; `null` when
   * none. Distinct from `lastWorkSessionId` (the work session) — this is the
   * conversation that shapes the intent itself.
   */
  intentSessionId: string | null
  /**
   * Derived, send-time boolean: `true` when ANY of `intentSessionId`,
   * `specSessionId`, or `lastWorkSessionId` is a non-null id that the run
   * registry reports as `isRunning` (a turn is executing right now). Covers all
   * three session kinds and is a transient liveness signal independent of the
   * intent's `status`. Distinct from `runStatus`, which describes ONLY the
   * `in_progress` work session's alive/dangling/idle reconcile state:
   * `sessionActive=true` may co-exist with `runStatus='idle'` or `'dangling'`.
   * Re-derived from the live registry on every send (list / refresh / broadcast);
   * never stored, never cached, never inferred from a missing field.
   */
  sessionActive: boolean
  /**
   * Derived, send-time next step for a blocked intent; `null` when nothing
   * blocks it. Re-derived from the run layer's existing failure facts on every
   * send (list / refresh / broadcast), so list and detail always agree. Never
   * stored, and it never changes the intent's `status`, the queue's decision, or
   * any gate — it only says what the human can do about it.
   */
  actionDescriptor: ActionDescriptor | null
}

/**
 * One intent communication session, as listed by `list_intent_sessions`.
 * Title is nullable — the client falls back to `'New Intent'` or a first-prompt /
 * timestamp derivation when null. `runStates` on the envelope provides liveness.
 */
export interface IntentSessionInfo {
  /** The SDK session id (may be a `pending:` id before first run binds it). */
  sessionId: string
  /** User-assigned title; null means use client fallback. */
  title: string | null
  /** Last mutation (open, rename, run) timestamp (epoch ms). */
  updatedAt: number
}

/**
 * Exit code for an intent work session execution.
 * - `success` — the work session completed normally.
 * - `failure` — the work session errored / CI failed.
 * - `cancelled` — the work session was aborted by the user.
 */
export type IntentDevSessionExitCode = 'success' | 'failure' | 'cancelled'

/**
 * One intent work session execution record (审计追踪).
 * Each time an intent launches a work session, a new row is appended (never overwritten).
 * The primary key is an auto-increment integer; use `listIntentSessions(intentId)`
 * (ordered by recency) for the per-intent history, and `getIntentSession(id)` for
 * a single record detail.
 */
export interface IntentDevSession {
  /** Auto-increment primary key. */
  id: number
  /** Owning intent id (UUID). */
  intentId: string
  /** The work session's c3SessionId. */
  sessionId: string
  /** Which vendor executed the session. */
  vendor: VendorId
  /** JSON frontmatter + Markdown summary (nullable until the session completes). */
  summary: string | null
  /** Session start timestamp (epoch ms); null until started. */
  startAt: number | null
  /** Session end timestamp (epoch ms); null until finished. */
  endAt: number | null
  /** Exit code; null while the session is in-flight. */
  exitCode: IntentDevSessionExitCode | null
  /** The agent id that executed this session; null when unknown. */
  agentId: string | null
  /** Record creation timestamp (epoch ms). */
  createdAt: number
}

/**
 * Intent lifecycle-log operation kinds — the auditable moments of an intent's
 * life. `spec_unapproved` is written when a direct spec edit or an explicit
 * revoke takes back a prior approval; `spec_updated` records a direct spec-source
 * overwrite (no diff); `spec_reviewed` records one read-only review conclusion
 * (pass / changes-requested, with the reviewer's reason in the summary).
 */
export const INTENT_LOG_OPERATIONS = [
  'intent_created',
  'intent_updated',
  'status_changed',
  'spec_created',
  'spec_updated',
  'spec_reviewed',
  'spec_approved',
  'spec_unapproved',
  'pr_created',
  'pr_merged',
  'pr_closed',
  'pr_updated',
] as const

export type IntentLogOperation = (typeof INTENT_LOG_OPERATIONS)[number]

/**
 * One intent lifecycle-log entry (who did what, when). Append-only audit trail:
 * every lifecycle operation (create / update / status transition / spec authored
 * or approved / PR created or merged or closed / PR updated) appends a row; rows are never
 * edited or deleted. Work-session start/stop is NOT logged here — that audit
 * trail lives in `intent_sessions` ({@link IntentDevSession}).
 */
export interface IntentLog {
  /** Row id (uuid). */
  id: string
  /** Owning intent id (UUID). */
  intentId: string
  /** What happened. */
  operationType: IntentLogOperation
  /** Human-readable one-line summary (e.g. `状态变更: todo → in_progress`). */
  summary: string
  /** Who did it: a login subject, `'system'` (no user context), or `'automation'`. */
  actor: string
  /** When it happened (epoch ms). */
  createdAt: number
}

/**
 * Lifecycle of the per-project automation queue (the deterministic scheduling
 * kernel that develops `automate` intents by priority + dependencies).
 * - `idle` — not running (never started, or stopped by the user).
 * - `running` — started; candidates exist but none is being developed right now
 *   (backing off, parked, or held by a gate). NOT a finished queue.
 * - `paused` — started but deliberately muted by the user; facts and per-intent
 *   scheduling metadata are preserved and nothing is launched.
 * - `awaiting_gate` — the workspace-global concurrency gate is shut.
 * - `developing` / `fixing` — a queue-owned dev turn (or lint-fix turn) is live.
 * - `done` — no pending automation candidate and no blocked chain remains.
 * - `error` — legacy whole-queue stop reason. The kernel isolates failures per
 *   intent instead, so it is no longer produced; kept for wire compatibility.
 */
export type WorkflowState =
  'idle' | 'running' | 'paused' | 'awaiting_gate' | 'developing' | 'fixing' | 'done' | 'error'

/** A project's workflow orchestrator status, broadcast to every connection. */
export interface WorkflowStatus {
  /** Owning project — the workspace absolute path (resolved). */
  workspaceId: string
  state: WorkflowState
  /** The intent currently being developed (null when not running). */
  currentIntentId: string | null
  /** The work session of the current intent, for a back-link (null when none). */
  currentSessionId: string | null
  /**
   * True while the current dev turn is paused on a permission prompt awaiting a
   * human answer (automation mirrors manual: it does NOT abort, it waits for the
   * watching human to answer in the browser). Cleared once the turn settles.
   */
  awaitingPermission: boolean
  /**
   * The most recent park reason, as a short displayable summary; `null` when
   * nothing is parked. Historically this was the whole-queue stop reason — the
   * field and its wire shape are unchanged, but a failure now isolates to one
   * intent rather than stopping the queue.
   */
  error: string | null
  /** Intent ids completed (committed + pushed) in this run. */
  completedIds: string[]
  /** When the orchestrator was started, ms since epoch; null when never started. */
  startedAt: number | null
  /**
   * The result of the latest checkpoint consensus round, if any. Set when the
   * orchestrator ran a vote over whether to continue past a checkpoint, and
   * cleared when the next dev turn is launched. The UI/events use this to render
   * the consensus process and result.
   */
  checkpointConsensus?: CheckpointConsensusOutcome | null
}

/**
 * One automation candidate as the queue currently sees it. This is the queue
 * page's read contract; it is deliberately NOT folded into {@link WorkflowStatus},
 * which stays a compact list/button summary.
 *
 * Reason codes are structured and displayable. They never carry prompts,
 * credentials, permission-request bodies or transcript text.
 */
export interface QueueIntentDetail {
  intentId: string
  title: string
  status: IntentStatus
  priority: IntentPriority
  /** Why this intent is not being developed right now; `''` when nothing blocks it. */
  blockedReason: string
  /** Short human-readable elaboration of `blockedReason` (dependency title, …). */
  blockedDetail: string
  /** When the queue will look at this intent again; `null` = next regular tick. */
  nextWakeupAt: number | null
  /** The action the queue last chose for this intent (`launch`/`block`/`park`/…). */
  lastAction: string
  /** When that decision was recorded; `null` when the queue never decided on it. */
  lastDecidedAt: number | null
  /** Consecutive failed attempts since the last real progress. */
  attemptCount: number
  /** How many backoff waits this intent has served (audit counter). */
  backoffCount: number
  /** No retry before this instant; `null` when not backing off. */
  backoffUntil: number | null
  /** Parked: never auto-launched again until a human unparks it. */
  parked: boolean
  parkReason: string | null
  parkDetail: string | null
  /** The user force-skipped this intent for the queue's selection. */
  forceSkipped: boolean
}

/** A workspace queue's per-intent detail projection. */
export interface QueueDetail {
  workspaceId: string
  state: WorkflowState
  /** Id of the reconcile pass this projection came from; `''` before the first. */
  tickId: string
  nextWakeupAt: number | null
  items: QueueIntentDetail[]
}

/**
 * One workspace's LOCAL park→recovery observation, derived from the machine's own
 * park state transitions. Read-only: it is never an input to scheduling, is never
 * sent anywhere, and carries no per-event detail — no intent id, no reason code,
 * no text of any kind, only counts over a window.
 *
 * `eligible` counts the parks old enough to have finished the observation window,
 * `recovered` the subset a human brought back inside it, and `pending` the parks
 * still too recent to judge — surfaced so a handful of samples cannot be mistaken
 * for a verdict. `rate` is `recovered / eligible`, or `null` when nothing has
 * matured yet: an empty denominator means "not enough samples", never 0%.
 */
export interface ParkRecoveryStats {
  /** The observation window in ms — how long a park has to be recovered within. */
  windowMs: number
  eligible: number
  recovered: number
  pending: number
  rate: number | null
}

/**
 * A human taking control back from the queue. Every action maps one-to-one onto
 * a kernel action, and none of them can bypass a hard gate: `force_skip` never
 * marks an intent `done` nor satisfies a dependency, and `override_*` only picks
 * among the follow-ups the kernel would already consider.
 */
export type QueueControlAction =
  'pause' | 'resume' | 'force_skip' | 'unskip' | 'unpark' | 'override_continue' | 'override_block'

/**
 * One intent proposed by the intent-communication agent via the
 * `save_intents` tool. The agent lists it in full in the conversation and waits
 * for the user's textual confirmation; the confirmed call persists it with
 * status `todo`.
 */
export interface ProposedIntent {
  /**
   * Optional id of an EXISTING intent to update in place (upsert). When set, the
   * save resolves the id within the same project and patches title/content/priority/
   * module/dependsOn instead of inserting a new row — the path the `refine_intent`
   * flow uses so a refined intent updates its original entry rather than duplicating
   * it. The target must be modifiable: `draft`/`todo` keep their status, `cancelled`
   * is reactivated to `todo`, and `in_progress`/`done` are immutable (the whole batch
   * is rejected). Omit to insert a brand-new intent (status `todo`).
   */
  id?: string
  title: string
  /**
   * Required short ASCII English title — the stable source for the derived
   * branch / worktree slug. The agent should produce ≤64 ASCII chars; the store
   * truncates to 128 before persisting. Required on both insert and update.
   */
  shortEnTitle: string
  content: string
  priority: IntentPriority
  /** Module name the comm agent inferred from title/content; persisted as `''` when omitted. */
  module?: string
  /** Optional ids of existing intents (same project) it depends on. */
  dependsOn?: string[]
  /**
   * Optional 0-based indexes into THIS batch's `intents` array, naming
   * sibling proposed intents this item depends on. Sibling ids don't exist
   * yet at proposal time, so intra-batch ordering can only be expressed by index;
   * `insertIntents` resolves each index to the sibling's freshly-minted id and
   * merges it into `dependsOn`. Complements (does not replace) `dependsOn`.
   * Validated on save: an out-of-range, self, or cyclic reference rejects the whole
   * batch (nothing is written). See RM-R17.
   */
  dependsOnIndexes?: number[]
  /**
   * Optional back-link to the intent-communication session that produced this
   * intent. ONLY meaningful when the batch saves exactly ONE intent: it lets the
   * detail view jump back to the originating conversation. When more than one
   * intent is saved in a batch the field is ignored — there is no single source
   * session to attribute the batch to. The model fills it with the current
   * session id injected into its prompt; the save handler normalizes that to the
   * bound comm-session id so it resolves against `open_intent_session`. The
   * `save_intent_directly` (automation) path never carries it.
   */
  intentSessionId?: string
}
