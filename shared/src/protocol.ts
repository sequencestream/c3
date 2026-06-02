/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 */

/**
 * Permission modes the c3 UI can switch between. These are a subset of the
 * Agent SDK's `PermissionMode` union, all valid values to pass to `query()`'s
 * `permissionMode` option and `setPermissionMode()`.
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** A project directory the user manages in the c3 sidebar. */
export interface WorkspaceInfo {
  /** Absolute path; also the SDK `cwd` and the key for `listSessions({ dir })`. */
  path: string
  /** Display name — the directory's basename. */
  name: string
  /** Last time a session in this workspace was selected, ms since epoch. Sort key (desc). */
  lastAccessed: number
}

/**
 * Live run state of a session, surfaced to the sidebar so background sessions
 * show their status without being viewed.
 * - `idle` — no turn in flight (session may still be active for the next prompt).
 * - `running` — a turn is executing.
 * - `awaiting_permission` — a turn is blocked waiting on a permission decision.
 * - `team` — a persistent agent-team session: the team lead's process stays alive
 *   between turns, coordinating background teammates. The run is still in-flight
 *   (not idle) even when no turn is actively producing output; it only ends when
 *   the user explicitly stops it.
 */
export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'team'

/** One session's live run status, broadcast to every connection for the sidebar. */
export interface SessionRunStatus {
  sessionId: string
  status: SessionStatus
}

/** A Claude session inside a workspace, as surfaced to the sidebar. */
export interface SessionInfo {
  /** SDK session UUID. */
  sessionId: string
  /** Display title: SDK custom title, summary, or first prompt. */
  title: string
  /** SDK last-modified time, ms since epoch. Sort key within a workspace (desc). */
  lastModified: number
  /** c3-tracked permission mode for this session. */
  mode: PermissionMode
  /** Whether this session was created by a tool (not the user). */
  isToolSession: boolean
}

/**
 * One replayed item of a session's historical transcript. Mirrors the live
 * render kinds so the console renders history and live events the same way.
 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /**
   * A turn that produced no visible output — the model only thought (an
   * end_turn after a thinking-only response) and emitted no assistant text or
   * tool call. Without this, the turn would render as nothing at all, which is
   * indistinguishable from a silent hang. Surfaced as a muted system line.
   */
  | { kind: 'notice'; text: string }

/** Display text for a turn that ended with only thinking and no visible output. */
export const EMPTY_TURN_NOTICE = '— No response this turn (the model only thought) —'

/**
 * A not-yet-started session. The browser invents the `clientId`; the server
 * binds it to a real SDK `sessionId` (via `session_started`) once the first
 * prompt's `query()` reports one.
 */
export const PENDING_SESSION_PREFIX = 'pending:'

/**
 * The built-in agent. Its Claude config (baseUrl/apiKey/model) is always empty,
 * so a session bound to it launches Claude Code with no overrides — the SDK's
 * own resolution (env vars, `claude /login` credentials) applies. It cannot be
 * deleted and always exists in {@link SystemSettings.agents}.
 */
export const SYSTEM_AGENT_ID = 'system'

/**
 * One agent profile under the system-config module. An agent names a set of
 * Claude Code launch overrides; a session launches Claude Code using its agent
 * (or the default agent when unassigned).
 */
export interface AgentConfig {
  /** Stable id; `'system'` ({@link SYSTEM_AGENT_ID}) for the built-in agent. */
  id: string
  /** Display name. */
  name: string
  /** ANTHROPIC_BASE_URL override. Empty ⇒ no override. */
  baseUrl: string
  /** API key / auth token override. Empty ⇒ no override. */
  apiKey: string
  /** Model alias or id. Empty ⇒ no override. */
  model: string
}

/**
 * Multi-agent consensus voting over permission prompts. When enabled, a pending
 * permission request is first put to the *other* configured agents (every agent
 * except the session's own); if they unanimously agree it is auto-resolved,
 * otherwise the human decides with their opinions attached. Off by default.
 */
export interface ConsensusConfig {
  enabled: boolean
}

/**
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
  /** Id of the agent new/unassigned sessions launch with. */
  defaultAgentId: string
  /** Permission mode new sessions start in. Optional; `default` when unset. */
  defaultMode?: PermissionMode
  /** Multi-agent consensus voting on permission prompts. Optional; off by default. */
  consensus?: ConsensusConfig
  /** BCP-47 language tag for browser voice input (e.g. `zh-CN`). `zh-CN` when unset. */
  voiceLang?: string
  /** When true, tool-created sessions (completion judge, consensus advisor) appear
   * in the sidebar session list. Default is false (hidden). */
  showToolSessions?: boolean
  /** Slash command (leading `/`) prefixed to the requirement content when launching
   * development. Optional; empty/unset ⇒ no skill prefix. */
  devSkill?: string
}

/** One agent's vote on a pending permission request during consensus voting. */
export interface ConsensusVote {
  /** Voting agent's id. */
  agentId: string
  /** Voting agent's display name. */
  agentName: string
  /** Verdict. `abstain` ⇒ the agent errored or returned no parseable answer. */
  decision: 'allow' | 'deny' | 'abstain'
  /** One-line rationale from the agent. */
  reason: string
}

/**
 * The aggregated result of a consensus vote over the other agents. Produced by
 * the server's consensus orchestrator and surfaced to the console either as an
 * auto-decision (`consensus_auto`) or attached to a `permission_request`.
 */
export interface ConsensusOutcome {
  /** Discriminates from {@link AskConsensusOutcome} on the wire. */
  kind: 'tool'
  /** Each voter's verdict + reason. */
  votes: ConsensusVote[]
  /** Decider-agent (or code-fallback) one-line summary of the opinions. */
  summary: string
  /** True ⇒ every voter returned the same allow/deny verdict (no abstain). */
  unanimous: boolean
  /** The unanimous verdict when `unanimous`; null when split (human decides). */
  decision: 'allow' | 'deny' | null
}

/**
 * One voter's answer to ONE question of an `AskUserQuestion` prompt. Unlike the
 * allow/deny vote, the agent picks option label(s) (or writes a custom reply)
 * for each question put to the user.
 */
export interface AgentAnswer {
  agentId: string
  agentName: string
  /** Matched option label(s); empty when the agent only gave a custom reply. */
  optionLabels: string[]
  /** Free-text reply when no option fits (or as an addition). */
  custom?: string
  /** One-line rationale. */
  reason: string
  /** True ⇒ the agent gave no parseable answer for this question (ignored in the tally). */
  abstain?: boolean
}

/** Per-question roll-up of every voter's answer, plus whether they agreed. */
export interface QuestionConsensus {
  /** Index into the original `AskUserQuestion` `questions` array. */
  index: number
  /** Question text — also the key used in the SDK `answers` map. */
  question: string
  header: string
  multiSelect: boolean
  /** Each voter's answer to this question. */
  answers: AgentAnswer[]
  /** True ⇒ every non-abstaining voter chose the same answer (≥1 voter, none abstained). */
  unanimous: boolean
  /** The agreed answer string (SDK format: option labels comma-separated); null when split. */
  agreed: string | null
  /**
   * True ⇒ the string tally was split, but the decider agent judged the advisors
   * to be in effective consensus and supplied {@link agreed}. Distinguishes an
   * AI-adjudicated agreement from a literal unanimous vote (for honest UI/labels).
   */
  decidedByAgent?: boolean
}

/**
 * Consensus over an `AskUserQuestion` prompt: voters answer each question rather
 * than vote allow/deny. When every question is unanimous the gateway can answer
 * on the user's behalf; otherwise the human fills in the answers (split questions
 * highlighted, agreed ones pre-filled). Surfaced like {@link ConsensusOutcome}.
 */
export interface AskConsensusOutcome {
  kind: 'ask'
  /** One roll-up per question, in original order. */
  perQuestion: QuestionConsensus[]
  /** True ⇒ every question is unanimous — eligible for auto-answer. */
  fullyUnanimous: boolean
  /** Pre-built `answers` map (question text → agreed answer) for the unanimous questions. */
  agreedAnswers: Record<string, string>
  /** Decider-agent (or code-fallback) one-line summary. */
  summary: string
}

/** Either consensus shape, discriminated by `kind`. */
export type AnyConsensusOutcome = ConsensusOutcome | AskConsensusOutcome

/**
 * One available slash command / skill for the input-box autocomplete menu.
 * Mirrors the SDK `SlashCommand` shape but is declared here to keep the wire
 * protocol independent of SDK types (the boundary rule). Covers both built-in
 * commands and Skills (user + project), exactly what the CLI lists on `/`.
 */
export interface SlashCommandInfo {
  /** Command/skill name without the leading slash. */
  name: string
  /** What the command/skill does. */
  description: string
  /** Hint for arguments, e.g. "<file>" (may be empty). */
  argumentHint: string
  /** Alternate names that resolve to this command (e.g. /cost → /usage). */
  aliases?: string[]
}

// ---- Requirement management ----

/** Requirement priority. `P0` highest … `P3` lowest. */
export type RequirementPriority = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * Requirement lifecycle status.
 * - `draft` — captured but not yet finalized (optional).
 * - `todo` — finalized, not started (the state save-to-db produces).
 * - `in_progress` — development launched (dev session running).
 * - `done` / `cancelled` — terminal, set by the user (never auto-set).
 */
export type RequirementStatus = 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'

/**
 * Derived run-state of an in_progress requirement, computed by reconciling the
 * requirement's lastDevSessionId liveness against the process table.
 * - `running` — the dev session's process is still alive (tracking in-flight).
 * - `dangling` — the dev process is dead but the requirement is still in_progress
 *   (service restart / crash); a completion judge found the requirement not done.
 * - `idle` — not in_progress, or the dev process ended and the judge confirmed done
 *   (just done, or never started).
 */
export type RequirementRunStatus = 'running' | 'dangling' | 'idle'

/** One persisted requirement, scoped to a project (workspace path). */
export interface Requirement {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  title: string
  content: string
  priority: RequirementPriority
  /** Owning module name, inferred by the comm agent from title/content. `''` when historic/unidentified. */
  module: string
  status: RequirementStatus
  /** Ids of other requirements (same project) this one depends on. */
  dependsOn: string[]
  /** The last dev session launched for this requirement, for the detail back-link. */
  lastDevSessionId: string | null
  /**
   * Whether the automation orchestrator may pick this requirement up. User-toggled
   * (a checkbox per requirement); `false` by default. Only `automate` requirements
   * are developed by `start_automation`.
   */
  automate: boolean
  createdAt: number
  updatedAt: number
  /** When the requirement entered `done`; `null` until completed, cleared if it leaves `done`. */
  completedAt: number | null
  /**
   * Derived run-state of an `in_progress` requirement, computed at list-time by
   * the server's reconcile logic. `'idle'` for other statuses. Clients use this
   * to render a "tracking" badge or a "dangling" warning next to an in_progress item.
   */
  runStatus: RequirementRunStatus
}

/**
 * Lifecycle of the per-project automation orchestrator (a single background loop
 * that develops `automate` requirements one by one, by priority + dependencies).
 * - `idle` — not running (never started, or stopped by the user).
 * - `running` — actively developing requirements.
 * - `done` — finished: no more eligible requirements remain.
 * - `error` — stopped abnormally (a dev run errored, blocked on a permission, a
 *   completion check failed, or commit/push failed). `error` text says why.
 */
export type AutomationState = 'idle' | 'running' | 'done' | 'error'

/** A project's automation orchestrator status, broadcast to every connection. */
export interface AutomationStatus {
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  state: AutomationState
  /** The requirement currently being developed (null when not running). */
  currentRequirementId: string | null
  /** The dev session of the current requirement, for a back-link (null when none). */
  currentSessionId: string | null
  /**
   * True while the current dev turn is paused on a permission prompt awaiting a
   * human answer (automation mirrors manual: it does NOT abort, it waits for the
   * watching human to answer in the browser). Cleared once the turn settles.
   */
  awaitingPermission: boolean
  /** Why the orchestrator stopped abnormally; null unless `state === 'error'`. */
  error: string | null
  /** Requirement ids completed (committed + pushed) in this run. */
  completedIds: string[]
  /** When the orchestrator was started, ms since epoch; null when never started. */
  startedAt: number | null
}

/**
 * One requirement proposed by the requirement-communication agent via the
 * `save_requirements` tool. Rendered in the confirmation prompt; persisted with
 * status `todo` once the user allows.
 */
export interface ProposedRequirement {
  title: string
  content: string
  priority: RequirementPriority
  /** Module name the comm agent inferred from title/content; persisted as `''` when omitted. */
  module?: string
  /** Optional ids of existing requirements (same project) it depends on. */
  dependsOn?: string[]
  /**
   * Optional 0-based indexes into THIS batch's `requirements` array, naming
   * sibling proposed requirements this item depends on. Sibling ids don't exist
   * yet at proposal time, so intra-batch ordering can only be expressed by index;
   * `insertRequirements` resolves each index to the sibling's freshly-minted id and
   * merges it into `dependsOn`. Complements (does not replace) `dependsOn`.
   * Validated on save: an out-of-range, self, or cyclic reference rejects the whole
   * batch (nothing is written). See RM-R17.
   */
  dependsOnIndexes?: number[]
}

// ---- Discussion ----

/**
 * Discussion lifecycle status.
 * - `draft` — created, not yet started.
 * - `in_progress` — discussion underway.
 * - `completed` — concluded; stamps `completedAt`.
 * - `cancelled` — abandoned (terminal, no completion stamp).
 */
export type DiscussionStatus = 'draft' | 'in_progress' | 'completed' | 'cancelled'

/**
 * Who authored a discussion message.
 * - `organizer` — the discussion organizer/orchestrator.
 * - `agent` — a participating agent (identified by `speakerAgentId`/`speakerName`).
 * - `human` — the user.
 */
export type DiscussionSpeakerKind = 'organizer' | 'agent' | 'human'

/** One persisted discussion, scoped to a project (workspace path). */
export interface Discussion {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  title: string
  /** Free-form discussion type/category. */
  type: string
  /** What the discussion aims to achieve. */
  goal: string
  /** Background material seeding the discussion. */
  context: string
  status: DiscussionStatus
  /** The concluded outcome; `null` until set. */
  conclusion: string | null
  createdAt: number
  updatedAt: number
  /** When the discussion entered `completed`; `null` otherwise. */
  completedAt: number | null
}

/** One message within a discussion, ordered by `seq` (per-discussion monotonic). */
export interface DiscussionMessage {
  /** Stable uuid. */
  id: string
  /** The owning discussion's id. */
  discussionId: string
  /** Per-discussion monotonic sequence number (1-based, assigned on append). */
  seq: number
  speakerKind: DiscussionSpeakerKind
  /** The participating agent's id when `speakerKind === 'agent'`; else `null`. */
  speakerAgentId: string | null
  /** Display name of the speaker; `null` when not applicable. */
  speakerName: string | null
  content: string
  createdAt: number
}

// Client → Server
export type ClientToServer =
  | { type: 'user_prompt'; text: string }
  /**
   * Answer a pending permission request. For `AskUserQuestion`, an `allow` may
   * carry `answers` (question text → selected option label(s) / custom reply,
   * multi-select comma-separated) which the gateway injects into the tool input.
   */
  | {
      type: 'permission_response'
      requestId: string
      decision: 'allow' | 'deny'
      answers?: Record<string, string>
    }
  /** Change the active session's permission mode (per-session, persisted). */
  | { type: 'set_mode'; mode: PermissionMode }
  /** Register a project directory as a workspace. */
  | { type: 'add_workspace'; path: string }
  /** Remove a workspace from the sidebar (does not delete its sessions on disk). */
  | { type: 'remove_workspace'; path: string }
  /** List sessions for a workspace (server replies with `sessions`). */
  | { type: 'list_sessions'; workspacePath: string }
  /** Create a new (pending) session in a workspace and make it active. */
  | { type: 'create_session'; workspacePath: string }
  /** Delete a session from disk. */
  | { type: 'delete_session'; workspacePath: string; sessionId: string }
  /** Make a session active; server replies with `session_selected` (history + mode). */
  | { type: 'select_session'; workspacePath: string; sessionId: string }
  /** Rename a session's title. */
  | { type: 'rename_session'; workspacePath: string; sessionId: string; title: string }
  /** Stop the in-flight run of the currently-viewed session (if any). */
  | { type: 'stop_run' }
  /** List slash commands/skills for the active session's cwd (reply: `commands`). */
  | { type: 'list_commands' }
  /** Fetch the system configuration (reply: `settings`). */
  | { type: 'get_settings' }
  /** Replace the system configuration; server normalizes and echoes `settings`. */
  | { type: 'save_settings'; settings: SystemSettings }
  /** List a project's requirements (reply: `requirements`), optionally filtered by status. */
  | { type: 'list_requirements'; projectPath: string; status?: RequirementStatus }
  /**
   * Enter the requirement view for a project: open or resume its (persisted)
   * communication session and return the requirement list. Replies with a
   * `session_selected` for the comm session plus a `requirements` list.
   */
  | { type: 'open_requirement_chat'; projectPath: string }
  /**
   * Start a brand-new communication session for a project: resets the previous
   * `is_current` comm session to 0, creates a fresh one marked current, and
   * replies with a `session_selected` (empty history) plus the `requirements`
   * list. The "+" button in the requirement view title bar triggers this.
   */
  | { type: 'new_requirement_chat'; projectPath: string }
  /**
   * Restart the comm session as a fresh one seeded with a requirement to refine;
   * the server injects the first prompt with the requirement's id and content.
   */
  | { type: 'refine_requirement'; projectPath: string; requirementId: string }
  /**
   * Bridge a completed discussion's conclusion into the requirement domain: a
   * `refine_requirement` variant whose seed is the discussion's conclusion rather
   * than an existing requirement. The server resolves the project from the
   * discussion, restarts the comm session as a fresh one, injects a first prompt
   * carrying the discussion title + conclusion, and replies with a
   * `session_selected` (empty history) plus the `requirements` list. Rejected if
   * the discussion is missing, not `completed`, or has no conclusion. The agent
   * then splits it into requirements via the unchanged `save_requirements` flow.
   */
  | { type: 'discussion_to_requirement'; discussionId: string }
  /** Launch a background dev session for a `todo` requirement via the configurable development skill. */
  | { type: 'start_development'; projectPath: string; requirementId: string }
  /** Manually set a requirement's status (e.g. mark done/cancelled). */
  | { type: 'update_requirement_status'; requirementId: string; status: RequirementStatus }
  /** Toggle a requirement's automation flag (whether the orchestrator may pick it). */
  | { type: 'set_requirement_automate'; requirementId: string; automate: boolean }
  /** Start the project's automation orchestrator (develops `automate` requirements). */
  | { type: 'start_automation'; projectPath: string }
  /** Stop the project's automation orchestrator (aborts the current dev run). */
  | { type: 'stop_automation'; projectPath: string }
  /** List a project's discussions (reply: `discussions`), optionally filtered by status. */
  | { type: 'list_discussions'; projectPath: string; status?: DiscussionStatus }
  /**
   * Create a discussion from the "+" form. The server persists it as `draft`
   * (title derived from `goal`), pushes a refreshed `discussions` list, then runs
   * a read-only research agent that reads project material + searches the web to
   * complete its `context` and pushes `discussions` again. `type` must name a
   * known discussion type (see `discussion-types.ts`).
   */
  | {
      type: 'create_discussion'
      projectPath: string
      discussionType: string
      goal: string
      context?: string
    }
  /**
   * Open a discussion: enter the discussion view for one discussion and return
   * it together with its full message history. Replies with `discussion_detail`.
   */
  | { type: 'open_discussion'; discussionId: string }
  /**
   * Start the organizer-driven orchestration of a `draft` discussion. The server
   * flips it to `in_progress` and runs the engine in the background: the organizer
   * (the default agent) picks speakers among the configured agents and drives the
   * type's workflow (discuss → summarize → confirm → conclude), each turn a
   * one-shot `askAgentOnce` over the current transcript. Every speech is appended
   * and streamed back as `discussion_message`; the run ends by writing the
   * `conclusion` and flipping to `completed`. A no-op if already running or not a
   * `draft`. The background run does not end any session (既有 session 约定).
   */
  | { type: 'start_discussion'; discussionId: string }
  /**
   * Pause a live discussion orchestration: the engine suspends at the next round
   * boundary, so no new organizer decision or agent speech happens until resumed
   * (an already in-flight one-shot turn may still finish). No-op if the discussion
   * has no live run or is already paused. The frontend reflects it via the
   * `discussion_run_status` (`paused`) event.
   */
  | { type: 'pause_discussion'; discussionId: string }
  /**
   * Resume a paused discussion orchestration: the engine continues from where it
   * suspended (its local stage/round state is preserved). No-op if not paused.
   */
  | { type: 'resume_discussion'; discussionId: string }
  /**
   * Human interjection into a live discussion ("I want to speak"): the server
   * pauses the run, appends a `human` message, and resumes — so the organizer's
   * next round sees it. Requires a live run (running or paused); when the
   * discussion is `in_progress` without a live run, the message is simply appended.
   */
  | { type: 'discussion_speak'; discussionId: string; text: string }
  /**
   * Drive a *new round* on a `completed` discussion: the server appends the
   * human's follow-up question/requirement as a `human` message, flips the
   * discussion back to `in_progress`, and re-runs the organizer engine over the
   * full transcript (the prior conclusion + the new question as context). The run
   * walks the workflow again and writes a fresh `conclusion`. Rejected if the
   * discussion is not `completed` or already has a live run.
   */
  | { type: 'continue_discussion'; discussionId: string; text: string }
  /** Pull the authoritative session-status snapshot (session-layer heartbeat). */
  | { type: 'request_session_status' }
  | { type: 'ping' }

// Server → Client
export type ServerToClient =
  /** Handshake: full workspace list + which session is active (if any) + live run statuses. */
  | {
      type: 'ready'
      workspaces: WorkspaceInfo[]
      activeSessionId: string | null
      statuses: SessionRunStatus[]
    }
  /** Live run statuses for all sessions with a runtime; drives sidebar badges. */
  | { type: 'session_status'; statuses: SessionRunStatus[] }
  /** Full workspace list, sorted by recent access (desc). */
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  /** Session list for one workspace, sorted by last-modified (desc). */
  | { type: 'sessions'; workspacePath: string; sessions: SessionInfo[] }
  /**
   * A session became active in this connection's view; carries its mode and
   * replayed history. `status` is the runtime's authoritative live status at
   * selection time — the client seeds its per-session status map from it so the
   * composer locks immediately, without waiting for the next status broadcast
   * (the source of a stale "ready" window on a background-running session). For a
   * session viewed while running in the background, the live tail follows as
   * normal stream events after this message.
   */
  | {
      type: 'session_selected'
      workspacePath: string
      sessionId: string
      title: string
      mode: PermissionMode
      history: TranscriptItem[]
      status: SessionStatus
    }
  /** Binds a pending session's `clientId` to its real SDK `sessionId`. */
  | { type: 'session_started'; clientId: string; sessionId: string }
  /** Confirms the active session's mode change. */
  | { type: 'mode_changed'; mode: PermissionMode }
  /** Available slash commands/skills for the active session (reply to `list_commands`). */
  | { type: 'commands'; commands: SlashCommandInfo[] }
  /** The (normalized) system configuration, in reply to `get_settings`/`save_settings`. */
  | { type: 'settings'; settings: SystemSettings }
  /** A project's requirement list (reply to `list_requirements`/`open_requirement_chat`, or a push after a change). */
  | { type: 'requirements'; projectPath: string; items: Requirement[] }
  /**
   * The project's automation-orchestrator status. Pushed on entering the
   * requirement view and on every state change (start/stop/progress/error), so
   * the requirement list's automation button reflects the live run.
   */
  | { type: 'automation_status'; status: AutomationStatus }
  /** A project's discussion list (reply to `list_discussions`/`open_discussion` entry, or a push after a change). */
  | { type: 'discussions'; projectPath: string; items: Discussion[] }
  /** One discussion plus its full message history (reply to `open_discussion`). */
  | { type: 'discussion_detail'; discussion: Discussion; messages: DiscussionMessage[] }
  /**
   * A newly-appended discussion message, pushed live to every connection while
   * the organizer engine runs (the client appends it when viewing that
   * discussion). The companion status/conclusion change rides the refreshed
   * `discussions` list broadcast.
   */
  | { type: 'discussion_message'; discussionId: string; message: DiscussionMessage }
  /**
   * Live run-state of a discussion's background orchestration, decoupled from its
   * persisted `DiscussionStatus`: `running` / `paused` while the engine is alive,
   * `ended` when the run finishes or is torn down (the frontend then drops its
   * run-state entry and falls back to the persisted status). Runtime-only — not
   * persisted, not restored across a server restart.
   */
  | { type: 'discussion_run_status'; discussionId: string; state: 'running' | 'paused' | 'ended' }
  /**
   * Echo of a user prompt, emitted into the session's stream when a turn starts.
   * Lets every viewer (including one switching back to a background session) see
   * the prompt that drove the in-flight turn, since it isn't part of the on-disk
   * `baseline` captured before the turn.
   */
  | { type: 'user_text'; text: string }
  | { type: 'assistant_text'; text: string }
  /**
   * A turn produced no visible output (thinking-only, end_turn with no text or
   * tool call). Emitted just before the turn's `turn_end` so the viewer sees a
   * muted line instead of a silent gap. Buffered like any other event, so a
   * viewer switching back replays it too.
   */
  | { type: 'notice'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
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
    }
  /**
   * A permission request the multi-agent consensus resolved on its own (all
   * voters agreed). Informational — no decision needed from the human; carries
   * the opinions so the console can show how it was decided.
   */
  | { type: 'consensus_auto'; toolName: string; input: unknown; outcome: AnyConsensusOutcome }
  /**
   * One prompt→result turn finished. `complete` = the run ended normally;
   * `error` = it failed. This NEVER means the session ended — the session stays
   * active for the next prompt. A session only truly ends when the user clears it.
   * For a team session this fires per lead turn; the lead process keeps running.
   */
  | { type: 'turn_end'; reason: 'complete' | 'error'; error?: string }
  /**
   * The session was upgraded to a persistent agent team: the run detected a team
   * tool (TeamCreate / SendMessage / a background Agent) and the lead process now
   * stays alive between turns to coordinate teammates. The client keeps the
   * composer enabled (messages route to the live lead) and shows a team badge.
   * Emitted once, into the session buffer, so reconnecting viewers also see it.
   */
  | { type: 'team_upgraded' }
  /** A requested operation failed (bad path, missing session, etc.). */
  | { type: 'error'; message: string }
  | { type: 'pong' }
