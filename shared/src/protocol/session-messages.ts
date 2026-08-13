/**
 * Session, run, transcript and connection-level wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type { TaskItem } from '../task-model.js'
import type { UiError } from '../ui-codes.js'
import type { AnyConsensusOutcome } from './consensus.js'
import type {
  PromptImage,
  SessionAgentSwitch,
  SessionInfo,
  SessionKind,
  SessionListCursor,
  SessionOwnerKind,
  SessionPageMeta,
  SessionRunStatus,
  SessionStatus,
  SlashCommandInfo,
  TranscriptItem,
} from './session.js'
import type { SelfUpdateState, UpdateStatus } from './settings.js'
import type { CodexPolicy, ModeToken, VendorId } from './vendor.js'
import type { WorkspaceInfo } from './workspace.js'

/**
 * A user turn. `images` (optional) carries attached images alongside the
 * text — multiple allowed, each a {@link PromptImage} (base64 + media type).
 * The server validates every `mediaType` against {@link IMAGE_MEDIA_TYPES}
 * and rejects the whole turn on any non-image type (`prompt.unsupportedFile`).
 */
export type ClientUserPrompt = { type: 'user_prompt'; text: string; images?: PromptImage[] }

/**
 * Answer a pending permission request. For `AskUserQuestion`, an `allow` may
 * carry `answers` (question text → selected option label(s) / custom reply,
 * multi-select comma-separated) which the gateway injects into the tool input.
 */
export type ClientPermissionResponse = {
  type: 'permission_response'
  requestId: string
  decision: 'allow' | 'deny'
  answers?: Record<string, string>
}

/**
 * Change the active session's permission mode (per-session, persisted). `mode`
 * is a vendor-native {@link ModeToken} the server resolves against the session's
 * vendor catalog (2026-06-07-012).
 */
/**
 * Change the active session's permission mode (per-session, persisted). `mode`
 * is a vendor-native {@link ModeToken} (claude) or a {@link CodexPolicy}
 * (codex) the server resolves against the session's vendor catalog.
 */
export type ClientSetMode = { type: 'set_mode'; mode: ModeToken | CodexPolicy }

/**
 * Re-target a session's agent within its frozen vendor (ADR-0015): rewrites the
 * `sessionAgents` fact so the session's next turn `resume`s with `agentId`. The
 * server rejects a cross-vendor change (reply `session_agent_changed { ok:false }`,
 * fact untouched). The console only offers same-vendor candidates, so a rejection
 * is a defensive guard, not an expected path.
 */
export type ClientSetSessionAgent = {
  type: 'set_session_agent'
  sessionId: string
  agentId: string
}

/**
 * List sessions for a workspace (server replies with `sessions`). Cursor
 * paginated by `lastModified` (SR-R14): the three cases are mutually
 * exclusive, all-absent ⇒ the first (newest) page.
 *  - `before` — load-more: the page strictly older than this keyset cursor.
 *  - `since`  — refresh: the displayed range, every row `lastModified >= since`.
 *  - `limit`  — page size for the `first`/`older` cases (server defaults it).
 */
export type ClientListSessions = {
  type: 'list_sessions'
  workspaceId: string
  sessionKind?: SessionKind
  before?: SessionListCursor
  since?: number
  limit?: number
}

export type ClientGetSessionCounts = { type: 'get_session_counts'; workspaceId: string }

/**
 * Create a new (pending) session in a workspace and make it active. The
 * optional `agentId` is the agent the new session should run on (ADR-0015): it
 * is recorded as the pending session's mutable *intent*, so the first run
 * launches with it (and freezes that agent's vendor onto the session). Absent
 * or empty ⇒ **Auto** — no intent is written and the run falls back to the
 * configured `defaultAgentId`.
 */
export type ClientCreateSession = { type: 'create_session'; workspaceId: string; agentId?: string }

export type ClientCreateWorkSession = {
  type: 'create_work_session'
  workspaceId: string
  agentId?: string
}

/** Delete a session from disk. */
export type ClientDeleteSession = { type: 'delete_session'; workspaceId: string; sessionId: string }

/** Make a session active; server replies with `session_selected` (history + mode). */
export type ClientSelectSession = { type: 'select_session'; workspaceId: string; sessionId: string }

/** Rename a session's title. */
export type ClientRenameSession = {
  type: 'rename_session'
  workspaceId: string
  sessionId: string
  title: string
}

/** Stop the in-flight run of the currently-viewed session (if any). */
export type ClientStopRun = { type: 'stop_run' }

/** Rebinding `${conn.viewing}` from a pending id to the real SDK id (ADR-0018 resident subs model). */
export type ClientRebindView = { type: 'rebind_view'; from: string; to: string }

/** List slash commands/skills for the active session's cwd (reply: `commands`). */
export type ClientListCommands = { type: 'list_commands' }

/** Pull the authoritative session-status snapshot (session-layer heartbeat). */
export type ClientRequestSessionStatus = { type: 'request_session_status' }

export type ClientPing = { type: 'ping' }

/** Handshake: full workspace list + which session is active (if any) + live run statuses. */
export type ServerReady = {
  type: 'ready'
  workspaces: WorkspaceInfo[]
  activeSessionId: string | null
  statuses: SessionRunStatus[]
  /**
   * Whether THIS connection is the unique admin under the active auth provider
   * (ADR-0023 authz slice). `true` whenever no admin gate applies — auth
   * disabled / `none` / an unconfigured `basic` shell (loopback bootstrap-trust,
   * AUTH-R2) — or when the signed-in subject equals the provider's admin
   * (`basic.adminUsername`). Drives the console hiding /
   * disabling system-config controls for non-admins; the server enforces the
   * same gate regardless (the wire flag is UX only, never the authority).
   */
  isAdmin: boolean
  /**
   * The signed-in subject for THIS connection — a `basic.adminUsername`-eligible
   * username — used only to
   * surface "who am I" in the top-bar account menu. `null` whenever no one is
   * signed in: auth disabled / `none` / an unconfigured `basic` shell, or before
   * a `login`. Purely a display hint; never an authority for any gate.
   */
  subject: string | null
  /**
   * The server's current {@link UpdateStatus} snapshot (is a newer c3 release
   * available?). Seeds the header's upgrade hint on connect so it appears
   * without waiting for the next {@link update_status} push. Visible to every
   * signed-in connection — a plain UX state, not admin-gated.
   */
  updateStatus: UpdateStatus
  /**
   * The server's current {@link SelfUpdateState} snapshot (is a release staged,
   * and can this installation swap its own binary?). Seeds the header so a
   * download already in flight — or a package waiting for a restart — shows up
   * immediately on connect.
   */
  selfUpdate: SelfUpdateState
}

/** Live run statuses for all sessions with a runtime; drives sidebar badges. */
export type ServerSessionStatus = { type: 'session_status'; statuses: SessionRunStatus[] }

/**
 * Session list page for one workspace, sorted by last-modified (desc). The
 * `page` descriptor (SR-R14) tells the client how to merge this batch into
 * its window (replace / append / refresh-range / live-upsert); absent only
 * for backward compatibility.
 */
export type ServerSessions = {
  type: 'sessions'
  workspaceId: string
  sessionKind?: SessionKind
  sessions: SessionInfo[]
  page?: SessionPageMeta
}

export type ServerSessionCounts = {
  type: 'session_counts'
  workspaceId: string
  counts: Record<
    'work' | 'intent' | 'spec' | 'spec_review' | 'discussion' | 'automation' | 'tool',
    number
  >
  /**
   * Running **business item** counts of the same workspace, deduplicated by
   * owner: an intent / discussion / automation counts once as long as ANY of
   * its sessions is running. A different notion from `counts` (running
   * *sessions* per kind) — the two never replace each other. Drives the top
   * nav's per-tab badges.
   */
  ownerCounts: Record<SessionOwnerKind, number>
}

/**
 * A session became active in this connection's view; carries its mode and
 * replayed history. `status` is the runtime's authoritative live status at
 * selection time — the client seeds its per-session status map from it so the
 * composer locks immediately, without waiting for the next status broadcast
 * (the source of a stale "ready" window on a background-running session). For a
 * session viewed while running in the background, the live tail follows as
 * normal stream events after this message.
 */
export type ServerSessionSelected = {
  type: 'session_selected'
  workspaceId: string
  sessionId: string
  title: string
  /** Vendor-native {@link ModeToken}; interpret via `vendor`'s catalog (2026-06-07-012). */
  mode: ModeToken
  /**
   * Codex dual-policy config (2026-06-08). Present only for codex-vendor sessions
   * that have a stored or default `CodexPolicy`. When absent, the web falls back
   * to deriving the dual-policy from `mode` via the catalog + `gateToCodexPolicy`.
   */
  codexPolicy?: CodexPolicy
  history: TranscriptItem[]
  status: SessionStatus
  /**
   * The session's resolved agent vendor (ADR-0015) — a real session's frozen
   * vendor, a pending session's intent/default vendor, or an intent comm
   * session's bound agent vendor — used to paint the vendor colour dot
   * beside the title.
   */
  vendor?: VendorId
  /** Projection source metadata for generic title-bar jump-back. */
  sessionKind?: SessionKind
  ownerKind?: 'intent' | 'discussion' | 'automation' | null
  ownerId?: string | null
  /**
   * Data for the title-bar same-vendor agent switcher (ADR-0015 / AS-R22): the
   * other **same-vendor, host-binary-present, enabled** agents this session may
   * switch to (cross-vendor never appears — vendor is frozen), plus whether the
   * current agent's host CLI is missing. Present for any session with a bound
   * agent that has switch candidates; absent for sessions without a resolved
   * fact (e.g. brand-new pending with no intent yet).
   */
  agentSwitch?: SessionAgentSwitch
  /**
   * The c3 intent id this work session was created for, reverse-looked-up from
   * `intent_sessions` (only `start_development`-bound sessions have a row). Present
   * only on the works `select_session` path; absent for intent-side comm / spec
   * sessions (already on the intent page) and for plain sessions (no row). Drives the
   * title-bar "Intent" jump button; absent ⇒ no button.
   */
  linkedIntentId?: string
}

/** Binds a pending session's `clientId` to its real SDK `sessionId`. */
export type ServerSessionStarted = {
  type: 'session_started'
  clientId: string
  sessionId: string
  agentSwitch?: SessionAgentSwitch
}

/**
 * Result of a `set_session_agent` re-target (ADR-0015): `ok` is false when the
 * change was rejected (cross-vendor — vendor is immutable), true on a same-vendor
 * swap. On success the session's next turn `resume`s with `agentId`. `vendor` is
 * the session's (unchanged) frozen vendor, echoed for the client's local update.
 */
export type ServerSessionAgentChanged = {
  type: 'session_agent_changed'
  sessionId: string
  agentId: string
  vendor: VendorId
  ok: boolean
}

/** Confirms the active session's mode change. `mode` is the vendor-native {@link ModeToken}. */
export type ServerModeChanged = { type: 'mode_changed'; mode: ModeToken; codexPolicy?: CodexPolicy }

/** Available slash commands/skills for the active session (reply to `list_commands`). */
export type ServerCommands = { type: 'commands'; commands: SlashCommandInfo[] }

/**
 * Echo of a user prompt, emitted into the session's stream when a turn starts.
 * Lets every viewer (including one switching back to a background session) see
 * the prompt that drove the in-flight turn, since it isn't part of the on-disk
 * `baseline` captured before the turn.
 */
export type ServerUserText = { type: 'user_text'; text: string }

export type ServerAssistantText = { type: 'assistant_text'; text: string }

/**
 * A turn produced no visible output (thinking-only, end_turn with no text or
 * tool call). Emitted just before the turn's `turn_end` so the viewer sees a
 * muted line instead of a silent gap. Buffered like any other event, so a
 * viewer switching back replays it too.
 */
export type ServerNotice = { type: 'notice'; text: string }

export type ServerToolUse = {
  type: 'tool_use'
  toolUseId: string
  toolName: string
  input: unknown
  /**
   * Audit hint surfaced to the console (2026-06-06-004): this tool call was
   * auto-allowed by the vendor's OWN permission rule engine WITHOUT a c3/human
   * decision — so it never raised a `permission_request`. Carried from the
   * neutral {@link CanonicalMessage.preApproved} marker via the driver path's
   * `WireEmitter`. The web renders it with a distinct "vendor pre-approved"
   * color, making "c3 is a gateway, not the sole authority" explicit (PG-R12).
   * Absent/false on a tool c3 gated (or any claude-path tool).
   */
  preApproved?: boolean
  /**
   * True when this tool is a user-interaction tool (e.g. AskUserQuestion,
   * ExitPlanMode) — a model-initiated prompt that needs the user's attention
   * before the run can continue. The server sets this at emission time so the
   * web can identify interaction tools without a client-side name-based
   * allowlist. Absent/false for tools that execute a side effect or read data
   * without involving the user in a dialogue.
   */
  isUserInteraction?: boolean
}

export type ServerToolResult = {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError: boolean
  isUserInteraction?: boolean
}

/**
 * Task-list wire path (2026-06-07-009). An independent channel for the dev
 * session's task list (TaskCreate / TaskList / TaskUpdate / TaskGet), so the
 * client fills its task panel from typed messages instead of re-parsing
 * `tool_result.content` text. The server derives the model at the `emit()`
 * fan-out point (Claude: from the task-tool `tool_use`/`tool_result` stream —
 * the SDK has no native task-push event) and on history replay (from the
 * baseline transcript); a full {@link task_list} snapshot is the primary form
 * (idempotent, replay-friendly). The per-task variants exist for vendors that
 * push single-task updates natively (Codex `onUpdate`, wired later per
 * 2026-06-07-008 §6) and future incremental use. {@link TaskItem} carries
 * `order`, so the client consumes it directly into its `taskModel`.
 */
export type ServerTaskList = { type: 'task_list'; tasks: TaskItem[] }

export type ServerTaskCreated = { type: 'task_created'; task: TaskItem }

export type ServerTaskUpdated = { type: 'task_updated'; task: TaskItem }

export type ServerTaskDeleted = { type: 'task_deleted'; taskId: string }

export type ServerPermissionRequest = {
  type: 'permission_request'
  requestId: string
  toolName: string
  input: unknown
  /**
   * Present when consensus ran but was split — the agents' opinions for the
   * human. For `AskUserQuestion` this is the per-question roll-up
   * ({@link AskConsensusOutcome}) the answer panel renders.
   */
  consensus?: AnyConsensusOutcome
  /**
   * True when this permission request is for a user-interaction tool
   * (e.g. AskUserQuestion) — a model-initiated prompt that needs the user's
   * attention before the run can continue. Absent/false for tools that execute
   * a side effect or read data without involving the user in a dialogue.
   */
  isUserInteraction?: boolean
}

/**
 * A permission request the multi-agent consensus resolved on its own (all
 * voters agreed). Informational — no decision needed from the human; carries
 * the opinions so the console can show how it was decided.
 */
export type ServerConsensusAuto = {
  type: 'consensus_auto'
  toolName: string
  input: unknown
  outcome: AnyConsensusOutcome
}

/**
 * One prompt→result turn finished. `complete` = the run ended normally;
 * `error` = it failed. This NEVER means the session ended — the session stays
 * active for the next prompt. A session only truly ends when the user clears it.
 * For a team session this fires per lead turn; the lead process keeps running.
 *
 * Socket-disconnect auto-resume telemetry (AS-R18, all optional / absent on a
 * normal turn): `reconnect_attempted` — this turn went through a single
 * auto-`resume` after a socket disconnect; `retry_count` — how many resume
 * attempts were spent (0 or 1, bounded); `original_error` — the socket
 * disconnect message that triggered the resume path; `side_effect_pending` —
 * the side-effect gate refused auto-resume because an unclosed write-class
 * `tool_use` was in flight when the socket dropped (AS-R19), so this `error`
 * turn ends and the user must continue manually.
 */
export type ServerTurnEnd = {
  type: 'turn_end'
  reason: 'complete' | 'error'
  error?: string
  reconnect_attempted?: boolean
  retry_count?: number
  original_error?: string
  side_effect_pending?: boolean
}

/**
 * The session was upgraded to a persistent agent team: the run detected a team
 * tool (TeamCreate / SendMessage / a background Agent) and the lead process now
 * stays alive between turns to coordinate teammates. The client keeps the
 * composer enabled (messages route to the live lead) and shows a team badge.
 * Emitted once, into the session buffer, so reconnecting viewers also see it.
 */
export type ServerTeamUpgraded = { type: 'team_upgraded' }

/**
 * One agent in the degradation chain failed (rate-limit / auth / connection
 * error). Emitted into the session buffer between the original user_text and
 * the next attempt's first event, so the viewer sees why the first agent was
 * skipped. Followed by either the next agent's output or `all_agents_failed`.
 */
export type ServerAgentFailed = {
  type: 'agent_failed'
  agentId: string
  agentName: string
  error: string
}

/**
 * Every agent in the degradation chain has been exhausted — none could
 * complete the current turn. The session then emits `turn_end { reason:
 * 'error' }` with a combined message. This is the terminal failure banner
 * for the current turn (the session stays alive for a manual retry).
 */
export type ServerAllAgentsFailed = {
  type: 'all_agents_failed'
  agents: Array<{ agentId: string; agentName: string; error: string }>
  message: string
  /**
   * Degradation-chain agents of a **different** vendor than the session's
   * current agent, skipped at chain-build time. Cross-vendor degradation cannot
   * carry context (a Claude session cannot `resume` into Codex — the SDK errors;
   * ADR-0011 / 008), so the chain is **vendor-homogeneous**: cross-vendor entries
   * are dropped rather than launched under the wrong vendor. Surfaced here so the
   * console honestly notes the skipped candidates ("无法承接上下文") instead of
   * implying they were tried. Absent/empty ⇒ no cross-vendor entry was configured.
   */
  crossVendorSkipped?: Array<{ agentId: string; agentName: string; vendor: VendorId }>
}

/**
 * A requested operation failed (bad path, missing session, etc.). Carries a
 * machine-readable `{ code, params }` (see ui-codes.ts) — never translated text;
 * the web renders it through its i18n catalog. The server holds no UI copy.
 *
 * `requestId` echoes the originating request's token when it had one, so a
 * client waiting on a specific run can recognise ITS failure terminal instead
 * of treating every error on the connection as its own. Absent for the many
 * requests that carry no token; a client must then fall back to its own
 * timeout rather than assume the error belongs to it.
 */
export type ServerError = { type: 'error'; error: UiError; requestId?: string }

export type ServerPong = { type: 'pong' }
