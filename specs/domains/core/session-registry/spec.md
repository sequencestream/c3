# session-registry — Domain Spec

## Overview

The session-registry manages the workspaces and sessions surfaced in the sidebar. A
**workspace** is a project directory (the SDK `cwd`); a **session** is a Claude conversation
inside it, persisted by the Agent SDK. The registry owns the c3-specific metadata the SDK does
not track — the workspace list, recent-access order, per-session permission mode, and the last
active session — and persists it across restarts (ADR 0004).

Each connection watches one session at a time (its **viewed session**); this is a view, not run
ownership. Selecting a session never stops a run — runs live in the session-runtime registry
(agent-session, ADR 0006). The persisted `activeSessionId` is only a restart hint for which
session to re-open.

**Scope:** workspace registration & ordering, session enumeration/create/select/rename/delete,
per-session mode, last-active tracking, and history replay on select.
**Boundary:** it does not drive `query()` and does not own run lifetime (agent-session), and
holds no permission state.

## Core entities

| Entity          | Description                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Workspace       | A registered project directory: `path`, display `name`, `lastAccessed` (sort key)                                    |
| Session         | A Claude conversation in a workspace: SDK `sessionId`, `title`, `lastModified`, c3 `mode`                            |
| Pending Session | A session created in the UI but not yet started; a `pending:<uuid>` id until its first run binds it to a real SDK id |

See [models.md](models.md).

## Business rules

| ID     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-R1  | A workspace is an existing directory. `add_workspace` on a non-directory is rejected with `error` and changes nothing.                                                                                                                                                                                                                                                                                                                                                               |
| SR-R2  | The workspace registry is persisted and ordered by `lastAccessed` descending — most recently accessed first.                                                                                                                                                                                                                                                                                                                                                                         |
| SR-R3  | Selecting or creating a session in a workspace bumps that workspace's `lastAccessed` (re-sorting the sidebar).                                                                                                                                                                                                                                                                                                                                                                       |
| SR-R4  | Sessions within a workspace are listed via the SDK (`listSessions({ dir })`), newest (`lastModified`) first. The SDK is the source of truth for existence, history, and title.                                                                                                                                                                                                                                                                                                       |
| SR-R5  | Permission mode is **per session**, persisted, and defaults to `default`. Changing the active session's mode (`set_mode`) affects only that session.                                                                                                                                                                                                                                                                                                                                 |
| SR-R6  | `create_session` makes a Pending Session the viewed session with empty history and the system **default mode** (`SystemSettings.defaultMode`, AC-R8; `default` when unconfigured). It has a `pending:` id and is not yet on disk. It does **not** stop any other session's run.                                                                                                                                                                                                      |
| SR-R7  | On the first run of a Pending (or freshly forked) session, the registry binds its client id to the real SDK `sessionId` (`session_started`) and persists the mode under that id. Binding re-keys the runtime (AS-R10).                                                                                                                                                                                                                                                               |
| SR-R8  | `select_session` makes the session the viewed session and replays its full record: `session_selected.history` (on-disk baseline) plus the runtime's live buffer tail for an in-flight/background turn. It reports the session's stored mode and its authoritative runtime `status` (`session_selected.status`), which the client seeds its per-session status from so the composer locks immediately without waiting for a `session_status` broadcast. It does **not** stop any run. |
| SR-R9  | `delete_session` stops the session's run, removes the transcript via the SDK, and drops its mode entry. If it was the viewed/last-active session, that is cleared.                                                                                                                                                                                                                                                                                                                   |
| SR-R10 | `remove_workspace` unregisters a directory and stops any background runs under it, but never deletes sessions on disk. A viewed session in it is cleared.                                                                                                                                                                                                                                                                                                                            |
| SR-R11 | Permission decisions/approvals are **never** persisted — only workspace/session metadata (ADR 0004, 0001).                                                                                                                                                                                                                                                                                                                                                                           |

## States & transitions

### Viewed session (per connection)

```mermaid
stateDiagram-v2
    [*] --> None: connection open
    None --> Pending: create_session
    None --> Selected: select_session
    Pending --> Selected: first run binds real id (session_started)
    Selected --> Selected: select_session (other) — old run keeps running
    Selected --> None: delete viewed / remove its workspace
    Pending --> None: delete before first run
```

Switching away does not end the previous session's run (it continues in the background,
agent-session AS-R8); only the connection's _view_ changes.

## User scenarios

- **Add a workspace:** Given a valid directory path, When `add_workspace` arrives, Then it is
  registered, the sidebar re-sorts (it is now most-recent), and its session list is returned.
- **New session:** Given a workspace, When `create_session` arrives, Then a Pending Session
  becomes active with empty history; the first `user_prompt` starts it and `session_started`
  binds the real id.
- **Resume a session:** Given an existing session, When `select_session` arrives, Then its
  history is replayed and its stored mode is applied; the next `user_prompt` resumes it.
- **View a running session:** Given a session running in the background, When `select_session`
  arrives, Then its baseline history plus the live buffer tail are replayed and live delivery
  resumes; the run is not interrupted (SR-R8, AS-R8).
- **Per-session mode (anti-scenario):** Changing mode on session A must **never** change session
  B's mode (SR-R5).
- **Switch (anti-scenario):** `select_session`/`create_session` must **never** stop another
  session's run (SR-R6/R8).
- **Delete (anti-scenario):** `remove_workspace` must **never** delete on-disk transcripts
  (SR-R10).

## Domain events (wire)

Consumes `add_workspace`, `remove_workspace`, `list_sessions`, `create_session`,
`select_session`, `rename_session`, `delete_session`, `set_mode`. Emits `ready` (with the
runtime `statuses`), `workspaces`, `sessions`, `session_selected` (with `status`),
`session_started`, `mode_changed`, `error`. Run-status broadcasts (`session_status`) belong to
[agent-session](../agent-session/spec.md). See the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Interactions

- **agent-session** — supplies the session `cwd`, per-session mode, and `resume` id to each
  run (via its runtime); receives the bound `sessionId` back from a run's `init` message.
- **Claude Agent SDK** — `listSessions` / `getSessionMessages` / `renameSession` /
  `deleteSession` for session enumeration, history, and mutation.
- **web-console** — renders the workspace/session tree and sends the management events above.

## Data dictionary

- **Workspace** — a registered `cwd`; the key for `listSessions({ dir })`.
- **Viewed session** — the session a connection currently watches; the next `user_prompt` from
  that connection runs against it (real or pending). A view, not run ownership.
- **Last active session** — the persisted `activeSessionId`; a restart hint, not a live run.
- **state.json** — the persisted registry at `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`.
