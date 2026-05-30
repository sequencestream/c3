# session-registry — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md).
Wire shapes (`WorkspaceInfo`, `SessionInfo`, `TranscriptItem`) are defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Workspace

A registered project directory.

| Attribute      | Type        | Description                                                          |
| -------------- | ----------- | -------------------------------------------------------------------- |
| `path`         | text (path) | Absolute directory; the SDK `cwd` and `listSessions({ dir })` key    |
| `name`         | text        | Display name — the directory's basename                              |
| `lastAccessed` | timestamp   | Last time a session here was selected/created; sort key desc (SR-R2) |

Relationships: a workspace has zero or more Sessions (enumerated from the SDK, not stored).

## Session

A Claude conversation inside a workspace.

| Attribute      | Type                  | Description                                                       |
| -------------- | --------------------- | ----------------------------------------------------------------- |
| `sessionId`    | text (UUID)           | SDK session id; the `resume` handle                               |
| `title`        | text                  | SDK custom title / summary / first prompt                         |
| `lastModified` | timestamp             | SDK last-modified; sort key within a workspace (SR-R4)            |
| `mode`         | enum `PermissionMode` | c3-tracked per-session permission mode; default `default` (SR-R5) |

Relationships: belongs to one Workspace; its transcript & title are owned by the SDK, its
`mode` by the registry.

## Pending Session

A session created in the UI but not yet started.

| Attribute  | Type                    | Description                                                   |
| ---------- | ----------------------- | ------------------------------------------------------------- |
| `clientId` | text (`pending:<uuid>`) | Temporary id until the first run reports a real `sessionId`   |
| `mode`     | enum `PermissionMode`   | Starts `default`; persisted under the real id on bind (SR-R7) |

Relationships: replaced by a real Session once `session_started` binds it.

## Persisted state (state.json)

The c3-owned registry — the only persisted c3 data (ADR 0004).

| Field             | Type                             | Description                                 |
| ----------------- | -------------------------------- | ------------------------------------------- |
| `version`         | `1`                              | Schema version                              |
| `workspaces`      | `Workspace[]`                    | The registry (SR-R2)                        |
| `sessionModes`    | map `sessionId → PermissionMode` | Per-session mode (SR-R5); stale ids ignored |
| `activeSessionId` | text \| null                     | Last active real session, for boot          |

Never contains permission decisions or approvals (SR-R11).

## Session runtime (in-memory)

The per-session run state lives in `runs.ts`, owned by agent-session — its full shape is the
**Session Runtime** in the [agent-session models](../agent-session/models.md). The registry only
seeds it (`cwd` / `mode` / `baseline`) and reads its `status`. Note its `team: boolean` flag
(set when a run upgrades to a persistent agent team, reset on teardown; ADR 0008): it overrides
a `turn_end`'s implied `idle` to the `team` status (see [design.md](design.md) § Team-session
status). Never persisted.
