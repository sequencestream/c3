# agent-session — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md).

## Session

The lifetime of one WebSocket connection. The active workspace/session/mode it tracks are
owned by the [session-registry](../session-registry/models.md); here we list the run controls.

| Attribute    | Type                  | Description                                                         |
| ------------ | --------------------- | ------------------------------------------------------------------- |
| `activeMode` | enum `PermissionMode` | The active session's mode; the run's starting policy (AS-R3, SR-R5) |
| `runAbort`   | reference \| none     | The in-flight run's abort handle, or none between runs              |
| `runHandle`  | reference \| none     | Live controls for the in-flight run, or none                        |

Relationships: one connection has at most one in-flight Agent Run (AS-R2). Run/permission
state is discarded on connection close (AS-R8); the workspace/session registry persists.

## Agent Run

One `query()` invocation driven by one user prompt against the active session.

| Attribute        | Type                  | Description                                                             |
| ---------------- | --------------------- | ----------------------------------------------------------------------- |
| `prompt`         | text                  | The user turn that started the run                                      |
| `cwd`            | text (path)           | SDK `cwd`; the active workspace's directory                             |
| `resume`         | text (UUID) \| none   | Existing session id to continue; none for a pending session's first run |
| `permissionMode` | enum `PermissionMode` | Mode the run started in (mutable mid-run)                               |
| `sessionId`      | text (UUID)           | Reported from the run's `init` message; binds pending sessions (AS-R10) |
| state            | enum                  | Streaming → Complete \| Errored \| Aborted (see spec)                   |

Relationships: produces a stream of wire events; gates sensitive tools via Permission
Requests (permission-gateway domain).

## Run Handle

Live controls handed to the connection when a run starts.

| Attribute                 | Type      | Description                                     |
| ------------------------- | --------- | ----------------------------------------------- |
| `setPermissionMode(mode)` | operation | Applies a new mode to the in-flight run (AS-R4) |

Relationships: exists only while a run is in flight; cleared to none when the run ends.

## PermissionMode (enum)

`default` · `auto` · `plan` · `acceptEdits` · `bypassPermissions`. Defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md); semantics for
gating in [spec.md](spec.md) § Permission modes.
