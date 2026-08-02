/**
 * Intent engineering wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  CreatePrStage,
  DepType,
  DevLaunchStage,
  Intent,
  IntentLog,
  IntentPrStatus,
  IntentSessionInfo,
  IntentStatus,
  QueueControlAction,
  QueueDetail,
  SpecLaunchStage,
  WorkflowStatus,
} from './intent.js'
import type { PromptImage } from './session.js'

/** List a project's intents (reply: `intents`), optionally filtered by status. */
export type ClientListIntents = { type: 'list_intents'; workspaceId: string; status?: IntentStatus }

/** Create one empty draft intent and return its exact server-generated id. */
export type ClientCreateIntent = { type: 'create_intent'; workspaceId: string }

/** Create and bind an intent-owned communication session, then send its first turn. */
export type ClientStartIntentSession = {
  type: 'start_intent_session'
  workspaceId: string
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
  workspaceId: string
  sessionId?: string
}

/**
 * List a project's intent communication sessions (reply: `intent_sessions`).
 * Each session carries id, title (nullable), and updatedAt. The response also
 * carries a `runStates` snapshot of which sessions have a live agent run.
 */
export type ClientListIntentSessions = { type: 'list_intent_sessions'; workspaceId: string }

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
  workspaceId: string
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
  workspaceId: string
  sessionId: string
}

/** Permanently delete one intent and its c3-managed local resources. */
export type ClientDeleteIntent = { type: 'delete_intent'; workspaceId: string; intentId: string }

/**
 * Start a brand-new communication session for a project: resets the previous
 * `is_current` comm session to 0, creates a fresh one marked current, and
 * replies with a `session_selected` (empty history) plus the `intents`
 * list. The "+" button in the intent list title bar triggers this.
 */
export type ClientNewIntentSession = { type: 'new_intent_session'; workspaceId: string }

/**
 * Restart the comm session as a fresh one seeded with a intent to refine;
 * the server injects the first prompt with the intent's id and content.
 */
export type ClientRefineIntent = { type: 'refine_intent'; workspaceId: string; intentId: string }

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
  workspaceId: string
  intentId: string
}

/**
 * Author a spec document for an intent: scaffold the dated spec directory,
 * seed `spec.md`, and launch a write-confined spec session (writes limited to
 * the spec directory, the project read-only) on the configured spec agent.
 */
export type ClientWriteSpec = { type: 'write_spec'; workspaceId: string; intentId: string }

/**
 * Approve an intent's authored spec — the human approval checkpoint that gates
 * entry into development. Sets `spec_approved=true` and records the approving
 * user (the current login subject) in `spec_approve_user`. Single-person
 * confirmation; no multi-sign. Revocable via `revoke_spec_approval`.
 */
export type ClientApproveSpec = { type: 'approve_spec'; workspaceId: string; intentId: string }

/**
 * Revoke an intent's spec approval — the explicit undo for BOTH human and
 * machine approval (2026-07-31). Clears `spec_approved` and the approver
 * identity, appends a `spec_unapproved` audit entry and re-broadcasts, so the
 * intent returns to "awaiting approval" and development is not started.
 *
 * It also marks the CURRENT review conclusion as human-vetoed, so the very next
 * queue tick cannot machine-approve the same conclusion straight back; only a
 * fresh valid conclusion or a human approval lifts that. Already-running
 * development sessions are NOT force-killed — a revoke governs admission from
 * here on, not work already in flight.
 */
export type ClientRevokeSpecApproval = {
  type: 'revoke_spec_approval'
  workspaceId: string
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
  workspaceId: string
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
  workspaceId: string
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
  workspaceId: string
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
  workspaceId: string
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
export type ClientReadSpec = { type: 'read_spec'; workspaceId: string; intentId: string }

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
  workspaceId: string
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
 * Set git-related info on an intent (branch name, commit hash, PR id, PR status).
 * All fields are optional — only provided fields are updated.
 */
export type ClientSetIntentGitInfo = {
  type: 'set_intent_git_info'
  intentId: string
  branchName?: string
  latestCommitHash?: string
  prId?: string
  prStatus?: IntentPrStatus
}

/** Start the project's automation queue (develops `automate` intents). */
export type ClientStartWorkflow = { type: 'start_workflow'; workspaceId: string }

/** Stop the project's automation queue (aborts the current dev run). */
export type ClientStopWorkflow = { type: 'stop_workflow'; workspaceId: string }

/** Read the queue's per-intent detail (blocking reason, next wake-up, last decision). */
export type ClientGetQueueDetail = { type: 'get_queue_detail'; workspaceId: string }

/**
 * Take manual control of the queue. `intentId` is required for every
 * per-intent action (`force_skip`, `unskip`, `unpark`, `override_*`) and
 * ignored by the workspace-level ones (`pause`, `resume`).
 */
export type ClientQueueControl = {
  type: 'queue_control'
  workspaceId: string
  action: QueueControlAction
  intentId?: string
}

/**
 * Create a GitHub Pull Request for a `done` intent that has no PR yet.
 * The server runs `gh pr create`, sets `prId` and `prStatus='reviewing'`
 * on success, or replies with `intent.prCreateFailed` on failure.
 * Rejected if the intent is not `done`, already has a `prId`,
 * or `gh` CLI is unavailable.
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
  workspaceId: string
  intentId: string
  requestId?: string
}

/**
 * One-shot sync for a done intent whose PR/MR is still marked reviewing. The
 * server queries the workspace forge and only advances stored PR status when
 * the forge confirms a safe terminal state.
 */
export type ClientSyncIntentPrStatus = {
  type: 'sync_intent_pr_status'
  workspaceId: string
  intentId: string
}

/**
 * A project's intent list (reply to `list_intents`/`open_intent_session`, or a push
 * after a change). `sddEnabled` is the workspace's SDD master switch, rebroadcast
 * with every list so the intent action button can render its SDD-aware state
 * (Write Spec / Approve Spec / Start Work) without a separate settings fetch.
 */
export type ServerIntents = {
  type: 'intents'
  workspaceId: string
  items: Intent[]
  sddEnabled: boolean
}

/** Exact result for `create_intent`; the regular `intents` snapshot follows. */
export type ServerCreateIntentResult = {
  type: 'create_intent_result'
  workspaceId: string
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
 * A project's intent-communication-session list (reply to `list_intent_sessions`
 * or push after a change). `runStates` is a live snapshot of which listed
 * sessions have an active agent run (id → `'running'`) — absent entries have
 * no live run.  It rides every list send (first fetch / reconnect re-fetch /
 * state-change push), so a refresh or reconnect authoritatively reconciles the
 * run-state of background sessions (decoupled from persisted `status`).
 */
export type ServerIntentSessions = {
  type: 'intent_sessions'
  workspaceId: string
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
 */
export type ServerSyncIntentPrStatusResponse = {
  type: 'sync_intent_pr_status_response'
  workspaceId: string
  intentId: string
  ok: boolean
  prStatus?: IntentPrStatus
  changed?: boolean
  message?: string
  error?: string
}
