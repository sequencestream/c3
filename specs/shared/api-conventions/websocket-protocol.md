# WebSocket Protocol

The single wire contract between browser and server. Endpoint: `ws://<host>/ws`
(`wss://` when the page is HTTPS). All traffic is JSON envelopes with a `type` discriminant.

**Source of truth:** `shared/src/protocol.ts`. This document describes that file; it does
not redefine shapes. Both ends import the same types (`@ccc/shared`).

## Conventions

- Every message is a JSON object with a string `type` field; consumers narrow on `type`.
- The server ignores any client message it cannot parse or whose `type` it does not
  recognize — an unparseable message is **never** treated as a permission approval.
- Correlation is by `requestId`: a `permission_request` carries one; the matching
  `permission_response` echoes it.

## Client → Server (`ClientToServer`)

| type                  | fields                                             | meaning                                                                                                                            |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `user_prompt`         | `text: string`                                     | New user turn for the **active session**. Aborts any in-flight run, then starts a new agent run.                                   |
| `permission_response` | `requestId: string`, `decision: 'allow' \| 'deny'` | Answer to a prior `permission_request`.                                                                                            |
| `set_mode`            | `mode: PermissionMode`                             | Change the **active session's** permission mode (per-session, persisted). Applies to the live run immediately if one is in flight. |
| `add_workspace`       | `path: string`                                     | Register a project directory as a workspace.                                                                                       |
| `remove_workspace`    | `path: string`                                     | Unregister a workspace (does not delete its sessions on disk).                                                                     |
| `list_sessions`       | `workspacePath: string`                            | Request a workspace's session list (server replies with `sessions`).                                                               |
| `create_session`      | `workspacePath: string`                            | Create a new pending session and make it active.                                                                                   |
| `select_session`      | `workspacePath: string`, `sessionId: string`       | Make a session active; server replies with `session_selected` (history + mode).                                                    |
| `rename_session`      | `workspacePath`, `sessionId`, `title: string`      | Rename a session's title.                                                                                                          |
| `delete_session`      | `workspacePath: string`, `sessionId: string`       | Delete a session and its transcript from disk.                                                                                     |
| `get_settings`        | —                                                  | Fetch the system configuration (server replies with `settings`).                                                                   |
| `save_settings`       | `settings: SystemSettings`                         | Replace the system configuration; server normalizes and echoes `settings`.                                                         |
| `ping`                | —                                                  | Keepalive.                                                                                                                         |

## Server → Client (`ServerToClient`)

| type                 | fields                                                                                     | meaning                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ready`              | `workspaces: WorkspaceInfo[]`, `activeSessionId: string \| null`                           | Handshake complete; carries the workspace list and last active session.                                                   |
| `workspaces`         | `workspaces: WorkspaceInfo[]`                                                              | Full workspace list, sorted by recent access (desc).                                                                      |
| `sessions`           | `workspacePath: string`, `sessions: SessionInfo[]`                                         | Session list for one workspace, newest first.                                                                             |
| `session_selected`   | `workspacePath`, `sessionId`, `title`, `mode: PermissionMode`, `history: TranscriptItem[]` | A session became active; carries its mode and replayed history.                                                           |
| `session_started`    | `clientId: string`, `sessionId: string`                                                    | Binds a pending session's client id to its real SDK session id.                                                           |
| `mode_changed`       | `mode: PermissionMode`                                                                     | Confirms the active session's mode change.                                                                                |
| `assistant_text`     | `text: string`                                                                             | A streamed text block from the model.                                                                                     |
| `tool_use`           | `toolUseId`, `toolName`, `input: unknown`                                                  | Model is calling a tool (already authorized when this fires).                                                             |
| `tool_result`        | `toolUseId`, `content: string`, `isError: boolean`                                         | A tool finished; `content` is the flattened display string.                                                               |
| `permission_request` | `requestId`, `toolName`, `input: unknown`                                                  | **Block point** — the run waits indefinitely until a `permission_response` arrives (or the run is aborted, which denies). |
| `session_end`        | `reason: 'complete' \| 'error'`, `error?: string`                                          | The agent run ended.                                                                                                      |
| `settings`           | `settings: SystemSettings`                                                                 | The (normalized) system configuration, in reply to `get_settings` / `save_settings`.                                      |
| `error`              | `message: string`                                                                          | A requested operation failed (bad path, missing session, etc.).                                                           |
| `pong`               | —                                                                                          | Reply to `ping`.                                                                                                          |

## Workspace & session types

- **`WorkspaceInfo`** — `{ path, name, lastAccessed }`. A registered project directory.
- **`SessionInfo`** — `{ sessionId, title, lastModified, mode }`. A session in a workspace.
- **`TranscriptItem`** — replayed history item: `user` / `assistant` / `tool_use` /
  `tool_result`, mirroring the live render kinds.
- **Pending session id** — `PENDING_SESSION_PREFIX` (`pending:`) prefixes a not-yet-started
  session's id until `session_started` binds it to a real SDK id.

See the [session-registry spec](../../domains/core/session-registry/spec.md).

## System-config types

- **`AgentConfig`** — `{ id, name, baseUrl, apiKey, model }`. One agent profile: a named set
  of Claude Code launch overrides. The built-in agent `id === SYSTEM_AGENT_ID` (`'system'`)
  has empty `baseUrl`/`apiKey`/`model` (no overrides) and cannot be removed.
- **`SystemSettings`** — `{ agents: AgentConfig[], defaultAgentId: string }`. The full
  configuration; always contains the system agent, and `defaultAgentId` references an
  existing agent. Persisted at `~/.c3/settings.json`.

See the [system-config spec](../../domains/system-config/agent-config/spec.md).

## PermissionMode

`'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'` — a subset of the SDK's
`PermissionMode`, valid for both the `query()` `permissionMode` option and
`setPermissionMode()`. See the [agent-session spec](../../domains/core/agent-session/spec.md)
for what each mode means for tool gating.

## Notes

- There is no message acknowledging `user_prompt` directly; the run's first
  `assistant_text` / `tool_use` / `permission_request` is the observable start, and
  `session_end` is the observable end.
- The browser sends optimistic UI updates for `set_mode` and confirms on `mode_changed`.
