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

| type                        | fields                                               | meaning                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_prompt`               | `text: string`                                       | New user turn for the **viewed session**. Rejected with `error` if that session already has a turn in flight (serial); otherwise starts a new run. Does not affect other sessions.     |
| `permission_response`       | `requestId: string`, `decision: 'allow' \| 'deny'`   | Answer to a prior `permission_request` (matched by `requestId`, regardless of which session is viewed).                                                                                |
| `set_mode`                  | `mode: PermissionMode`                               | Change the **viewed session's** permission mode (per-session, persisted). Applies to the live run immediately if one is in flight.                                                     |
| `stop_run`                  | —                                                    | Stop the in-flight run of the **viewed session** (if any). No effect on other sessions.                                                                                                |
| `add_workspace`             | `path: string`                                       | Register a project directory as a workspace.                                                                                                                                           |
| `remove_workspace`          | `path: string`                                       | Unregister a workspace (does not delete its sessions on disk).                                                                                                                         |
| `list_sessions`             | `workspacePath: string`                              | Request a workspace's session list (server replies with `sessions`).                                                                                                                   |
| `create_session`            | `workspacePath: string`                              | Create a new pending session and make it active.                                                                                                                                       |
| `select_session`            | `workspacePath: string`, `sessionId: string`         | Make a session active; server replies with `session_selected` (history + mode).                                                                                                        |
| `rename_session`            | `workspacePath`, `sessionId`, `title: string`        | Rename a session's title.                                                                                                                                                              |
| `delete_session`            | `workspacePath: string`, `sessionId: string`         | Delete a session and its transcript from disk.                                                                                                                                         |
| `list_requirements`         | `projectPath: string`, `status?: RequirementStatus`  | Request a project's requirement list (server replies with `requirements`). Returns `error` if the ledger is unavailable.                                                               |
| `open_requirement_chat`     | `projectPath: string`                                | Enter the requirement view: open/resume the project's read-only communication session and reply with its `session_selected` plus a `requirements` list (requirement-management RM-R4). |
| `refine_requirement`        | `projectPath: string`, `requirementId: string`       | Restart the communication session seeded with one requirement's content to refine it further (RM-R7).                                                                                  |
| `start_development`         | `projectPath: string`, `requirementId: string`       | Launch a background `/develop-pipeline` session for a `todo` requirement; sets it `in_progress` and records `lastDevSessionId` (RM-R8). Warns (not blocks) on unmet dependencies.      |
| `update_requirement_status` | `requirementId: string`, `status: RequirementStatus` | Manually set a requirement's status (e.g. `done` / `cancelled`); the server replies with `requirements` (RM-R9).                                                                       |
| `get_settings`              | —                                                    | Fetch the system configuration (server replies with `settings`).                                                                                                                       |
| `save_settings`             | `settings: SystemSettings`                           | Replace the system configuration; server normalizes and echoes `settings`.                                                                                                             |
| `ping`                      | —                                                    | Keepalive.                                                                                                                                                                             |

## Server → Client (`ServerToClient`)

| type                 | fields                                                                                                         | meaning                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`              | `workspaces: WorkspaceInfo[]`, `activeSessionId: string \| null`, `statuses: SessionRunStatus[]`               | Handshake complete; carries the workspace list, last active session, and live run statuses.                                                                                                                                                                       |
| `workspaces`         | `workspaces: WorkspaceInfo[]`                                                                                  | Full workspace list, sorted by recent access (desc).                                                                                                                                                                                                              |
| `sessions`           | `workspacePath: string`, `sessions: SessionInfo[]`                                                             | Session list for one workspace, newest first.                                                                                                                                                                                                                     |
| `session_selected`   | `workspacePath`, `sessionId`, `title`, `mode: PermissionMode`, `history: TranscriptItem[]`, `running: boolean` | A session became the connection's view; carries its mode, replayed on-disk history, and whether a turn is in flight. For a background/in-flight session the live buffer tail follows as normal stream events.                                                     |
| `session_started`    | `clientId: string`, `sessionId: string`                                                                        | Binds a pending session's client id to its real SDK session id.                                                                                                                                                                                                   |
| `session_status`     | `statuses: SessionRunStatus[]`                                                                                 | Broadcast to **all** connections whenever any session's run status changes; drives sidebar badges and awaiting-permission highlight.                                                                                                                              |
| `mode_changed`       | `mode: PermissionMode`                                                                                         | Confirms the viewed session's mode change.                                                                                                                                                                                                                        |
| `user_text`          | `text: string`                                                                                                 | Echo of a user prompt, emitted into the session stream when a turn starts, so every viewer (and switch-back replay) shows it.                                                                                                                                     |
| `assistant_text`     | `text: string`                                                                                                 | A streamed text block from the model.                                                                                                                                                                                                                             |
| `tool_use`           | `toolUseId`, `toolName`, `input: unknown`                                                                      | Model is calling a tool (already authorized when this fires).                                                                                                                                                                                                     |
| `tool_result`        | `toolUseId`, `content: string`, `isError: boolean`                                                             | A tool finished; `content` is the flattened display string.                                                                                                                                                                                                       |
| `permission_request` | `requestId`, `toolName`, `input: unknown`, `consensus?: ConsensusOutcome`                                      | **Block point** — the run waits indefinitely until a `permission_response` arrives (or the run is aborted, which denies). `consensus` is attached when [multi-agent consensus](../../domains/core/permission-gateway/consensus.md) ran but the agents were split. |
| `consensus_auto`     | `toolName`, `input: unknown`, `outcome: ConsensusOutcome`                                                      | A permission request the agents resolved **unanimously** — informational, no human decision needed. Carries the verdicts + reasons + decider summary.                                                                                                             |
| `turn_end`           | `reason: 'complete' \| 'error'`, `error?: string`                                                              | One prompt→result turn ended (`complete`, incl. a stopped run; or `error`). **Never** means the session ended — it stays alive for the next prompt; the input unlocks via `session_status`.                                                                       |
| `requirements`       | `projectPath: string`, `items: Requirement[]`                                                                  | A project's requirement list, in reply to `list_requirements` / `open_requirement_chat` / `update_requirement_status`, and broadcast on a confirmed `save_requirements` (requirement-management).                                                                 |
| `settings`           | `settings: SystemSettings`                                                                                     | The (normalized) system configuration, in reply to `get_settings` / `save_settings`.                                                                                                                                                                              |
| `error`              | `message: string`                                                                                              | A requested operation failed (bad path, missing session, etc.).                                                                                                                                                                                                   |
| `pong`               | —                                                                                                              | Reply to `ping`.                                                                                                                                                                                                                                                  |

## Workspace & session types

- **`WorkspaceInfo`** — `{ path, name, lastAccessed }`. A registered project directory.
- **`SessionInfo`** — `{ sessionId, title, lastModified, mode }`. A session in a workspace.
- **`SessionStatus`** — `'idle' | 'running' | 'awaiting_permission'`. A session's live run state.
- **`SessionRunStatus`** — `{ sessionId, status: SessionStatus }`. One session's status, as
  carried in `ready.statuses` and `session_status`.
- **`TranscriptItem`** — replayed history item: `user` / `assistant` / `tool_use` /
  `tool_result`, mirroring the live render kinds.
- **Pending session id** — `PENDING_SESSION_PREFIX` (`pending:`) prefixes a not-yet-started
  session's id until `session_started` binds it to a real SDK id.

See the [session-registry spec](../../domains/core/session-registry/spec.md).

## System-config types

- **`AgentConfig`** — `{ id, name, baseUrl, apiKey, model }`. One agent profile: a named set
  of Claude Code launch overrides. The built-in agent `id === SYSTEM_AGENT_ID` (`'system'`)
  has empty `baseUrl`/`apiKey`/`model` (no overrides) and cannot be removed.
- **`SystemSettings`** — `{ agents: AgentConfig[], defaultAgentId: string, defaultMode?: PermissionMode, consensus?: { enabled } }`.
  The full configuration; always contains the system agent, and `defaultAgentId` references an
  existing agent. `defaultMode` is the permission mode new sessions start in (one of the five
  `PermissionMode` values; `default` when unset). `consensus` toggles multi-agent permission
  voting (off by default). Persisted at `~/.c3/settings.json`.
- **`ConsensusOutcome`** — `{ votes: ConsensusVote[], summary, unanimous, decision }`. The result
  of a consensus round; `decision` is set only when `unanimous`. **`ConsensusVote`** —
  `{ agentId, agentName, decision: 'allow' | 'deny' | 'abstain', reason }`. See the
  [consensus design](../../domains/core/permission-gateway/consensus.md).

See the [system-config spec](../../domains/system-config/agent-config/spec.md).

## Requirement types

- **`RequirementPriority`** — `'P0' | 'P1' | 'P2' | 'P3'` (P0 highest).
- **`RequirementStatus`** — `'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'`.
- **`Requirement`** — `{ id, projectPath, title, content, priority, status, dependsOn: string[],
lastDevSessionId: string | null, createdAt, updatedAt }`. A project-scoped ledger item;
  `projectPath` is the resolved workspace path; `dependsOn` are intra-project requirement ids.
- **`ProposedRequirement`** — `{ title, content, priority, dependsOn?: string[] }`. One item in a
  `save_requirements` call and in the confirmation render; persisted as a `Requirement` (status
  `todo`) only on a confirmed save.

The communication agent's save confirmation reuses `permission_request` /`permission_response`
with `toolName === 'mcp__c3__save_requirements'` and `input.requirements: ProposedRequirement[]`.
See the [requirement-management spec](../../domains/core/requirement-management/spec.md).

## PermissionMode

`'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'` — a subset of the SDK's
`PermissionMode`, valid for both the `query()` `permissionMode` option and
`setPermissionMode()`. See the [agent-session spec](../../domains/core/agent-session/spec.md)
for what each mode means for tool gating.

## Notes

- `user_prompt` is echoed back as `user_text` (so all viewers and switch-back replay show it);
  the run's `assistant_text` / `tool_use` / `permission_request` follow, and `turn_end` is the
  observable end of the turn.
- The browser sends optimistic UI updates for `set_mode` and confirms on `mode_changed`; it
  also optimistically marks the viewed session running on submit and reconciles via
  `session_status`.
- Runs are not bound to the connection: switching the viewed session or closing the socket does
  not stop a run (ADR 0006). On reconnect, `select_session` replays the full record.
