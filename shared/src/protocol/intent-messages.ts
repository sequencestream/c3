/**
 * Intent engineering wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  CreateIntentBase,
  CreatePrStage,
  DepType,
  DevLaunchStage,
  Intent,
  IntentLog,
  IntentPrStatus,
  IntentSessionInfo,
  IntentSpecMode,
  IntentStatus,
  ParkRecoveryStats,
  QueueControlAction,
  QueueDetail,
  SpecLaunchStage,
  WorkflowStatus,
} from './intent.js'
import type { PromptImage } from './session.js'
import type { UiError } from '../ui-codes.js'

/** List a project's intents (reply: `intents`), optionally filtered by status. */
export type ClientListIntents = {
  type: 'list_intents'
  workspaceName: string
  status?: IntentStatus
}

/**
 * Create one draft intent and return its exact server-generated id.
 *
 * Both payload fields are optional so the pre-existing blank-creation callers
 * (and any older client) keep working unchanged: no `base` resolves the
 * workspace base branch as before, and no `content` creates the empty
 * placeholder without starting a session. When `content` is a non-empty string
 * the server continues into the intent-communication session in the SAME
 * handler — the intent is persisted first, then bound and launched with that
 * content as its first turn.
 */
export type ClientCreateIntent = {
  type: 'create_intent'
  workspaceName: string
  /** First-turn input, also persisted as the intent's body. Empty/absent = no session. */
  content?: string
  base?: CreateIntentBase
}

/** Create and bind an intent-owned communication session, then send its first turn. */
export type ClientStartIntentSession = {
  type: 'start_intent_session'
  workspaceName: string
  intentId: string
  text: string
  images?: PromptImage[]
}

/**
 * Enter the intent view for a project: open or resume a communication session
 * and return the intent list. `sessionId` is optional — when provided the
 * server opens that specific session (switching to it); when absent it opens
 * the project's current (`is_current`) session (same as before). Replies with
 * a `session_selected` for the comm session plus an `intents` list.
 */
export type ClientOpenIntentSession = {
  type: 'open_intent_session'
  workspaceName: string
  sessionId?: string
}

/**
 * List a project's intent communication sessions (reply: `intent_sessions`).
 * Each session carries id, title (nullable), and updatedAt. The response also
 * carries a `runStates` snapshot of which sessions have a live agent run.
 */
export type ClientListIntentSessions = { type: 'list_intent_sessions'; workspaceName: string }

/**
 * List one intent's lifecycle-log entries (reply: `intent_logs_list`,
 * newest-first, full set — no pagination in this phase). Sent lazily when the
 * detail's changelog tab is opened.
 */
export type ClientListIntentLogs = { type: 'list_intent_logs'; intentId: string }

/**
 * Rename an intent communication session (must exist; error otherwise).
 * The server broadcasts the refreshed `intent_sessions` list on success.
 */
export type ClientRenameIntentSession = {
  type: 'rename_intent_session'
  workspaceName: string
  sessionId: string
  title: string
}

/**
 * Delete an intent communication session: removes the db row, removes the
 * runtime (aborts any active run), and broadcasts the refreshed list. If the
 * deleted session was `is_current`, the most recent remaining session becomes
 * the new default. Error if the session does not exist.
 */
export type ClientDeleteIntentSession = {
  type: 'delete_intent_session'
  workspaceName: string
  sessionId: string
}

/** Permanently delete one intent and its c3-managed local resources. */
export type ClientDeleteIntent = { type: 'delete_intent'; workspaceName: string; intentId: string }

/**
 * Start a brand-new communication session for a project: resets the previous
 * `is_current` comm session to 0, creates a fresh one marked current, and
 * replies with a `session_selected` (empty history) plus the `intents`
 * list. The "+" button in the intent list title bar triggers this.
 */
export type ClientNewIntentSession = { type: 'new_intent_session'; workspaceName: string }

/**
 * Restart the comm session as a fresh one seeded with a intent to refine;
 * the server injects the first prompt with the intent's id and content.
 */
export type ClientRefineIntent = { type: 'refine_intent'; workspaceName: string; intentId: string }

/**
 * Bridge a completed discussion's conclusion into the intent domain, using the
 * same two steps as the "add intent" path. The server resolves the project from
 * the discussion, creates ONE empty `draft` intent (as `create_intent` does) and
 * echoes it as `create_intent_result` — so the conversion is on the ledger before
 * the agent saves anything — then binds an intent-communication session **owned by
 * that intent** (its `intentSessionId`), whose first prompt carries the discussion
 * title + conclusion, replying `session_selected` (empty history) plus the refreshed
 * `intents` list. Rejected — before any intent is created — if the discussion is
 * missing, not `completed`, or has no conclusion; a failed launch unwinds the
 * session but keeps the intent. The agent then splits it into intents via the
 * unchanged `save_intents` flow (upserting onto that intent's id).
 */
export type ClientDiscussionToIntent = { type: 'discussion_to_intent'; discussionId: string }

/** Launch a background work session for a `todo` intent via the configurable development skill. */
export type ClientStartDevelopment = {
  type: 'start_development'
  workspaceName: string
  intentId: string
  /**
   * The DELIVERY CONTEXT this session develops against — what decides its
   * worktree baseline and how its dependency gate reads "is that output on my
   * base". Optional: an intent linked to zero or exactly one delivery needs
   * none. An intent linked to SEVERAL is rejected with
   * `intent.deliveryContextRequired` unless this says which — the server never
   * defaults, because picking one silently would develop against a branch the
   * user did not choose.
   */
  deliveryId?: string | null
  /**
   * One-shot override of the DEPENDENCY gate. That gate is advice ("what you
   * depend on is probably not on your base"), not a physical constraint, so a
   * human who has seen the risk may proceed. It skips only that gate — SDD
   * approval, concurrency, delivery status and the worktree baseline are still
   * evaluated — is never persisted (every later launch and resume re-evaluates
   * the gate), and leaves an `intent_logs` audit row. The automation queue never
   * sets it.
   */
  forceDependencyGate?: boolean
}

/**
 * Repair a worktree whose BASELINE no longer contains the delivery branch it
 * should be rooted at. c3 never does either of these by itself: a rebuild
 * discards uncommitted work, a merge rewrites the user's branch.
 *
 * - `mode: 'rebuild'` — remove the worktree (and its local intent branch) so the
 *   next launch creates a fresh one at the baseline. Refused when the worktree
 *   holds uncommitted work (`intent.worktreeDirty`); committing or stashing is
 *   the user's call.
 * - `mode: 'merge'`   — merge `origin/<delivery branch>` into the worktree's
 *   current branch, in place. A conflict is surfaced verbatim, never resolved.
 *
 * Reply: `intent_worktree_repair_result`.
 */
export type ClientRepairIntentWorktree = {
  type: 'repair_intent_worktree'
  workspaceName: string
  intentId: string
  mode: 'rebuild' | 'merge'
  /** The delivery whose branch is the baseline; omitted = the intent's single one. */
  deliveryId?: string | null
}

/**
 * Author a spec document for an intent: scaffold the dated spec directory,
 * seed `spec.md`, and launch a write-confined spec session (writes limited to
 * the spec directory, the project read-only) on the configured spec agent.
 */
export type ClientWriteSpec = { type: 'write_spec'; workspaceName: string; intentId: string }

/**
 * Approve an intent's authored spec — the human approval checkpoint that gates
 * entry into development. Only a `pending` spec may be approved (a `raw` one is
 * still being authored). Sets `spec_status='approved'` (compat `spec_approved=true`
 * in the same transaction) and records the approving user (the current login
 * subject) in `spec_approve_user`. Single-person confirmation; no multi-sign.
 * Revocable via `revoke_spec_approval`.
 */
export type ClientApproveSpec = { type: 'approve_spec'; workspaceName: string; intentId: string }

/**
 * Revoke an intent's spec approval — the explicit undo for BOTH human and
 * machine approval (2026-07-31). Returns the spec to `pending`: clears
 * `spec_status` / `spec_approved` and the approver identity, appends a
 * `spec_unapproved` audit entry and re-broadcasts, so the intent returns to
 * "awaiting approval" and development is not started.
 *
 * It also marks the CURRENT review conclusion as human-vetoed, so the very next
 * queue tick cannot machine-approve the same conclusion straight back; only a
 * fresh valid conclusion or a human approval lifts that. Already-running
 * development sessions are NOT force-killed — a revoke governs admission from
 * here on, not work already in flight.
 */
export type ClientRevokeSpecApproval = {
  type: 'revoke_spec_approval'
  workspaceName: string
  intentId: string
}

/**
 * Open an intent's spec-authoring session (`spec_session_id`) for viewing in
 * the intent detail's `spec session` tab. The server resolves the stored spec
 * session id, restores its write-confined `'spec'` runtime if dropped, and
 * replies with a `session_selected` (history + status). Distinct from
 * `open_intent_session` (the comm/refine session, a different `'intent'` runtime).
 */
export type ClientOpenSpecSession = {
  type: 'open_spec_session'
  workspaceName: string
  intentId: string
}

/**
 * Open an intent's spec-REVIEW session (`spec_review_session_id`) for viewing.
 * Mirrors `open_spec_session` but restores the strictly read-only
 * `'spec_review'` runtime — it never gets the spec author's directory write
 * grant. Used by the detail's review tab and by WorkCenter's jump-to-source.
 */
export type ClientOpenSpecReviewSession = {
  type: 'open_spec_review_session'
  workspaceName: string
  intentId: string
}

/**
 * Reset an intent's refine / communication session: start a FRESH `'intent'`
 * session seeded with the user's new input concatenated with the intent's
 * current content, replacing the prior `intent_session_id` (re-linked onto the
 * intent on first bind). Used to escape a context-rotted conversation after the
 * intent changed — the old session stays queryable under Works but is no longer
 * the intent's linked session.
 */
export type ClientResetIntentSession = {
  type: 'reset_intent_session'
  workspaceName: string
  intentId: string
  userInput: string
}

/**
 * Reset an intent's spec-authoring session: start a FRESH write-confined
 * `'spec'` session seeded with the user's new input concatenated with the
 * CURRENT spec document content (read from `spec_path`), replacing the prior
 * `spec_session_id`. Rejected if no spec has been written yet. Mirrors
 * `reset_intent_session` for the spec tab.
 */
export type ClientResetSpecSession = {
  type: 'reset_spec_session'
  workspaceName: string
  intentId: string
  userInput: string
}

/**
 * Read an intent's authored spec document for the intent detail's `spec` tab.
 * Specs live OUTSIDE the workspace at the centralized, per-project root
 * `~/.c3/specs/<project-path-segment>/…` (not under the workspace, so the
 * workspace-confined `read_file` cannot reach them). The server resolves the
 * intent's stored absolute `specPath`, confines the read to the centralized
 * specs root (fail-closed), and replies with a `file_read` whose `file.path`
 * is that absolute spec path.
 */
export type ClientReadSpec = { type: 'read_spec'; workspaceName: string; intentId: string }

/**
 * Directly overwrite an intent's centralized spec Markdown source (the human
 * inline spec-edit entry, distinct from the `write_spec` / `reset_spec_session`
 * agent sessions). Allowed ONLY when a spec exists, development has not started
 * (`status === 'todo' && lastWorkSessionId === null`) and no spec session is
 * running; the server re-checks all three and rejects a bypassed client. On
 * success it overwrites the file inside the centralized specs root (fail-closed),
 * resets approval to `false` if it was approved (with a `spec_unapproved` log),
 * always appends a `spec_updated` log (no diff), bumps `updated_at` and refills
 * via the `intents` broadcast; the client re-reads via `read_spec`.
 */
export type ClientUpdateSpecContent = {
  type: 'update_spec_content'
  workspaceName: string
  intentId: string
  content: string
}

/**
 * Directly edit an intent's markdown body (the human inline-edit entry, distinct
 * from refine / `save_intents`). Only `draft` / `todo` intents may be edited; the
 * server rejects any other status even if the client button was bypassed. On
 * success it updates `content` + `updated_at`, appends one `intent_updated` log,
 * and refills via the existing `intents` broadcast (no dedicated ack). No title /
 * priority / dependency / status / spec change.
 */
export type ClientUpdateIntentContent = {
  type: 'update_intent_content'
  intentId: string
  content: string
}

/** Manually set a intent's status (e.g. mark done/cancelled). */
export type ClientUpdateIntentStatus = {
  type: 'update_intent_status'
  intentId: string
  status: IntentStatus
}

/** Toggle a intent's automation flag (whether the orchestrator may pick it). */
export type ClientSetIntentAutomate = {
  type: 'set_intent_automate'
  intentId: string
  automate: boolean
}

/**
 * Set (or clear) an intent's per-intent spec-mode override. `mode: null` drops
 * the override so the intent inherits the workspace's `sddEnabled` again; the
 * field is always carried explicitly, so this never means "leave as is".
 *
 * It writes `spec_mode` and nothing else: `specStatus` / `specApproved` are
 * untouched (switching to `fast` does not revoke an approved spec, switching to
 * `sdd` does not fabricate a pending one), no gate is relaxed, and the
 * automation queue's `specStatus==='approved'` eligibility is unchanged. The
 * resolved `effectiveSpecMode` is recomputed server-side on the next `intents`
 * broadcast, which is also this message's only ack.
 */
export type ClientSetIntentSpecMode = {
  type: 'set_intent_spec_mode'
  intentId: string
  mode: IntentSpecMode | null
}

/**
 * Update an intent's dependency list with per-edge dep_type.
 * Replaces the entire dependency set — all prior edges are removed.
 * Each edge specifies the depended-on intent id and the dependency type.
 */
export type ClientUpdateIntentDeps = {
  type: 'update_intent_deps'
  intentId: string
  deps: { dependsOnId: string; depType: DepType }[]
}

/**
 * Set git-related info on an intent (branch name, commit hash). Both fields are
 * optional — only provided fields are updated.
 *
 * It deliberately carries NO PR fields. It used to accept `prId` + `prStatus`,
 * which let a caller conjure a PR fact with no forge, no repo and no URL — the
 * one thing `intent_prs`' identity key exists to prevent, and the mirror image of
 * the restriction `save_intent_pr_info` now carries. Associating an existing PR
 * with an intent, if it is ever wanted again, belongs in a purpose-built message
 * that states the PR's origin.
 */
export type ClientSetIntentGitInfo = {
  type: 'set_intent_git_info'
  intentId: string
  branchName?: string
  latestCommitHash?: string
}

/** Start the project's automation queue (develops `automate` intents). */
export type ClientStartWorkflow = { type: 'start_workflow'; workspaceName: string }

/** Stop the project's automation queue (aborts the current dev run). */
export type ClientStopWorkflow = { type: 'stop_workflow'; workspaceName: string }

/** Read the queue's per-intent detail (blocking reason, next wake-up, last decision). */
export type ClientGetQueueDetail = { type: 'get_queue_detail'; workspaceName: string }

/**
 * Read this workspace's local park→recovery observation (reply:
 * `park_recovery_stats`). A pure read: it neither writes nor derives scheduling
 * state, and the server answers only for a workspace this connection can already
 * resolve — a client cannot name someone else's.
 */
export type ClientGetParkRecoveryStats = {
  type: 'get_park_recovery_stats'
  workspaceName: string
}

/**
 * Take manual control of the queue. `intentId` is required for every
 * per-intent action (`force_skip`, `unskip`, `unpark`, `override_*`) and
 * ignored by the workspace-level ones (`pause`, `resume`).
 */
export type ClientQueueControl = {
  type: 'queue_control'
  workspaceName: string
  action: QueueControlAction
  intentId?: string
}

/**
 * Create a Pull Request / Merge Request for one intent toward one target. The
 * server runs the forge CLI and writes a `reviewing` PR row on success, or
 * replies with `intent.prCreateFailed` on failure. Intent status is not a gate;
 * the run is rejected when the workspace is not in worktree mode, the intent has
 * no branch, the named delivery is unusable, the target `(intentId, deliveryId)`
 * already owns an active PR, or the worktree does not differ from the base.
 *
 * `requestId` is an opaque client-generated token echoed back on every frame
 * this run produces (`create_pr_progress`, `create_pr_response`, and the
 * failure `error`). It exists so a client can tell THIS run's terminals from
 * an unrelated error or from a previous run of the same intent that is still
 * in flight — matching on `intentId` alone cannot separate a retry from the
 * run it replaced. Optional: a client that does not correlate omits it.
 */
export type ClientCreatePr = {
  type: 'create_pr'
  workspaceName: string
  intentId: string
  requestId?: string
  /**
   * The delivery this PR targets — its branch becomes the PR's base, and the
   * pair `(intentId, deliveryId)` is the create idempotency key. Omitted means
   * "let the server resolve it": no linked delivery → the workspace's main
   * branch (the pre-delivery behaviour), exactly one → that delivery, several →
   * rejected (the server never guesses which delivery a PR belongs to).
   */
  deliveryId?: string
}

/**
 * One-shot sync for a done intent whose PR/MR is still marked reviewing. The
 * server queries the workspace forge and only advances stored PR status when
 * the forge confirms a safe terminal state.
 */
export type ClientSyncIntentPrStatus = {
  type: 'sync_intent_pr_status'
  workspaceName: string
  intentId: string
}

/**
 * Associate an existing forge PR/MR with one intent target after `create_pr`
 * failed or was skipped. The server reuses `resolvePrTarget` for the same
 * `(intentId, deliveryId)` pair, queries the forge for PR facts, and accepts
 * the link only when the intent worktree HEAD matches the PR head commit SHA.
 */
export type ClientLinkIntentPr = {
  type: 'link_intent_pr'
  workspaceName: string
  intentId: string
  /** PR number (`42`, `#42`) or full PR/MR URL. */
  prReference: string
  /**
   * The delivery this PR targets — same semantics as `create_pr`. Omitted
   * means let the server resolve from association edges.
   */
  deliveryId?: string
}

/**
 * A project's intent list (reply to `list_intents`/`open_intent_session`, or a push
 * after a change). `sddEnabled` is the workspace's SDD master switch, rebroadcast
 * with every list so the intent action button can render its SDD-aware state
 * (Write Spec / Approve Spec / Start Work) without a separate settings fetch.
 */
export type ServerIntents = {
  type: 'intents'
  workspaceName: string
  items: Intent[]
  sddEnabled: boolean
}

/** Exact result for `create_intent`; the regular `intents` snapshot follows. */
export type ServerCreateIntentResult = {
  type: 'create_intent_result'
  workspaceName: string
  intent: Intent
}

/**
 * Connection-directed coarse progress of a manual `start_development` launch,
 * driving the client's startup-progress overlay (shown only when the launch
 * outlasts a client-side threshold). Carries only the {@link DevLaunchStage}
 * phase + the target `intentId`, never internal detail. The success terminal
 * is NOT signalled here — the client derives it from the intent flipping to
 * `in_progress` in the regular `intents` broadcast; only `failed` is pushed,
 * fixing the previously-silent async launch failure.
 */
export type ServerDevLaunchProgress = {
  type: 'dev_launch_progress'
  intentId: string
  stage: DevLaunchStage
}

export type ServerSpecLaunchProgress = {
  type: 'spec_launch_progress'
  intentId: string
  stage: SpecLaunchStage
}

/**
 * Outcome of a `repair_intent_worktree` run. Success is reported explicitly (the
 * repair changes nothing the regular `intents` broadcast would show), so the page
 * can tell the user the worktree is now usable and re-offer the launch.
 */
export type ServerIntentWorktreeRepairResult = {
  type: 'intent_worktree_repair_result'
  intentId: string
  mode: 'rebuild' | 'merge'
}

/**
 * The existing worktree does not contain the baseline tip — pushed AFTER the
 * session has started, because this is a notice and not a refusal. A worktree
 * that merely fell behind its base branch still develops fine; whether the
 * divergence matters is settled when the PR is merged, not at launch.
 *
 * It carries exactly what the two exits need: the expected baseline (branch +
 * delivery label), where the directory actually sits, and whether a rebuild is
 * safe right now. Acting on it stays a user decision — c3 never rebuilds and
 * never merges on its own, so the page only offers `repair_intent_worktree`.
 */
export type ServerIntentWorktreeBaselineNotice = {
  type: 'intent_worktree_baseline_notice'
  intentId: string
  /** The expected baseline — the intent's persisted base branch. */
  branch: string
  /** The delivery that baseline came from; empty for a mainline baseline. */
  deliveryTitle: string
  /** Where the worktree actually sits; a neutral placeholder when unreadable. */
  currentBranch: string
  /** The worktree's short HEAD; a neutral placeholder when unreadable. */
  currentHead: string
  /** Whether a rebuild is safe right now (no uncommitted work) — one exit or two. */
  canRebuild: boolean
}

/**
 * A project's intent-communication-session list (reply to `list_intent_sessions`
 * or push after a change). `runStates` is a live snapshot of which listed
 * sessions have an active agent run (id → `'running'`) — absent entries have
 * no live run.  It rides every list send (first fetch / reconnect re-fetch /
 * state-change push), so a refresh or reconnect authoritatively reconciles the
 * run-state of background sessions (decoupled from persisted `status`).
 */
export type ServerIntentSessions = {
  type: 'intent_sessions'
  workspaceName: string
  items: IntentSessionInfo[]
  runStates?: Record<string, 'running'>
}

/**
 * One intent's lifecycle-log entries (reply to `list_intent_logs`), newest
 * first. Single-intent single-shot full fetch — no incremental pushes; the
 * client re-requests when it needs a refresh.
 */
export type ServerIntentLogsList = {
  type: 'intent_logs_list'
  intentId: string
  items: IntentLog[]
}

/**
 * The project's automation-orchestrator status. Pushed on entering the
 * intent view and on every state change (start/stop/progress/error), so
 * the intent list's automation button reflects the live run.
 */
export type ServerWorkflowStatus = { type: 'workflow_status'; status: WorkflowStatus }

/**
 * The project's queue detail projection. Pushed as a reply to
 * `get_queue_detail` and after any kernel action or manual queue control, so
 * the queue page always reflects the pass that actually ran.
 */
export type ServerQueueDetail = { type: 'queue_detail'; detail: QueueDetail }

/**
 * Reply to {@link ClientGetParkRecoveryStats}. `workspaceName` echoes the request so
 * a late reply for a workspace the user has since left is discardable instead of
 * being shown under the wrong one.
 *
 * On success `stats` carries the counts and `error` is absent. On failure (db
 * unavailable / the query threw) `stats` is absent and `error` is a structured
 * {@link UiError}: the panel then says the local statistics are unavailable and
 * offers a retry, rather than dressing a failure up as 0% or an empty sample.
 */
export type ServerParkRecoveryStats = {
  type: 'park_recovery_stats'
  workspaceName: string
  stats?: ParkRecoveryStats
  error?: UiError
}

/**
 * Reply to a `create_pr` request. Carries the PR id and URL on success.
 * On failure the server sends a generic `error` with code `intent.prCreateFailed`
 * carrying the same `requestId`.
 *
 * `intentId` / `requestId` echo the originating request so a client can bind
 * this success terminal to the run it started; a late reply from a superseded
 * run is then discardable instead of closing the current one's overlay.
 */
export type ServerCreatePrResponse = {
  type: 'create_pr_response'
  intentId: string
  prId: string
  prUrl?: string
  requestId?: string
}

/**
 * Connection-directed coarse progress of a manual `create_pr` run, driving the
 * client's PR-creation progress overlay. Carries only the {@link CreatePrStage}
 * phase + the originating `intentId` / `requestId`, never internal detail.
 * Purely additive: the terminals stay `create_pr_response` (success) and the
 * intent-action `error` frame (failure), so a client that ignores this frame is
 * unaffected. Only the connection that sent `create_pr` receives it — the
 * automation path has no requesting connection and sends nothing.
 */
export type ServerCreatePrProgress = {
  type: 'create_pr_progress'
  intentId: string
  stage: CreatePrStage
  requestId?: string
}

/**
 * Reply to a `sync_intent_pr_status` request. `ok=false` means the request was
 * handled but could not sync, while transport/action failures may still use the
 * generic `error` frame.
 *
 * The sync runs over EVERY `reviewing` PR the intent owns, so `prStatus` is the
 * intent's AGGREGATE status after the pass (see `deriveIntentPrAggregate`) and
 * `changed` means "at least one PR row moved", not "the one PR moved".
 */
export type ServerSyncIntentPrStatusResponse = {
  type: 'sync_intent_pr_status_response'
  workspaceName: string
  intentId: string
  ok: boolean
  prStatus?: IntentPrStatus
  changed?: boolean
  message?: string
  error?: string
}

/** Reply to a `link_intent_pr` request. On failure the server sends `error`. */
export type ServerLinkIntentPrResponse = {
  type: 'link_intent_pr_response'
  workspaceName: string
  intentId: string
  prId: string
  prUrl?: string
}
