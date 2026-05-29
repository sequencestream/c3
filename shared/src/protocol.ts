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
}

/**
 * One replayed item of a session's historical transcript. Mirrors the live
 * render kinds so the console renders history and live events the same way.
 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolName: string; input: unknown }
  | { kind: 'tool_result'; content: string; isError: boolean }

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
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
  /** Id of the agent new/unassigned sessions launch with. */
  defaultAgentId: string
}

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

// Client → Server
export type ClientToServer =
  | { type: 'user_prompt'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
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
  /** List slash commands/skills for the active session's cwd (reply: `commands`). */
  | { type: 'list_commands' }
  /** Fetch the system configuration (reply: `settings`). */
  | { type: 'get_settings' }
  /** Replace the system configuration; server normalizes and echoes `settings`. */
  | { type: 'save_settings'; settings: SystemSettings }
  | { type: 'ping' }

// Server → Client
export type ServerToClient =
  /** Handshake: full workspace list + which session is active (if any). */
  | { type: 'ready'; workspaces: WorkspaceInfo[]; activeSessionId: string | null }
  /** Full workspace list, sorted by recent access (desc). */
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  /** Session list for one workspace, sorted by last-modified (desc). */
  | { type: 'sessions'; workspacePath: string; sessions: SessionInfo[] }
  /** A session became active; carries its mode and replayed history. */
  | {
      type: 'session_selected'
      workspacePath: string
      sessionId: string
      title: string
      mode: PermissionMode
      history: TranscriptItem[]
    }
  /** Binds a pending session's `clientId` to its real SDK `sessionId`. */
  | { type: 'session_started'; clientId: string; sessionId: string }
  /** Confirms the active session's mode change. */
  | { type: 'mode_changed'; mode: PermissionMode }
  /** Available slash commands/skills for the active session (reply to `list_commands`). */
  | { type: 'commands'; commands: SlashCommandInfo[] }
  /** The (normalized) system configuration, in reply to `get_settings`/`save_settings`. */
  | { type: 'settings'; settings: SystemSettings }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }
  /**
   * One prompt→result turn finished. `complete` = the run ended normally;
   * `error` = it failed. This NEVER means the session ended — the session stays
   * active for the next prompt. A session only truly ends when the user clears it.
   */
  | { type: 'turn_end'; reason: 'complete' | 'error'; error?: string }
  /** A requested operation failed (bad path, missing session, etc.). */
  | { type: 'error'; message: string }
  | { type: 'pong' }
