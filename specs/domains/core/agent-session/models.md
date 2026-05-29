# agent-session — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md).

## Session Runtime

Process-wide owner of one session's execution, keyed by session id and shared across
connections (ADR 0006). Lives for the process lifetime once created (no eviction yet).

| Attribute       | Type                       | Description                                                                    |
| --------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `sessionId`     | text (UUID \| `pending:…`) | Map key; re-keyed pending→real on first bind (AS-R10)                          |
| `workspacePath` | text (path)                | The run's `cwd` (SR-owned)                                                     |
| `mode`          | enum `PermissionMode`      | The session's mode; the run's starting policy (AS-R3, SR-R5)                   |
| `baseline`      | list of TranscriptItem     | On-disk transcript snapshot at runtime creation; replayed before `buffer`      |
| `buffer`        | list of wire events        | Every event emitted since creation (all turns); replayed on view join (AS-R11) |
| `run`           | reference \| none          | The in-flight Agent Run's abort + handle, or none between turns                |
| `status`        | enum                       | `idle` \| `running` \| `awaiting_permission` (AS-R12)                          |
| `viewers`       | set of deliver callbacks   | Connections currently watching this session; live events fan out to them       |

Relationships: at most one in-flight Agent Run per runtime (serial, AS-R2); many runtimes run
concurrently. Survives connection close (AS-R8); torn down on `delete_session` /
`remove_workspace`.

## Connection View

One WebSocket connection's subscription to the session it currently watches.

| Attribute | Type            | Description                                                         |
| --------- | --------------- | ------------------------------------------------------------------- |
| `viewing` | text id \| none | The session this connection currently watches (a runtime key)       |
| `deliver` | operation       | Sends a wire event to this connection's socket (viewer + broadcast) |

Relationships: registered as a viewer of `viewing`'s runtime; also in the global broadcast set
for `session_status`. On switch, unsubscribes the old and subscribes the new; on close,
unsubscribes only — the run is unaffected.

## Agent Run

One `query()` invocation driven by one user prompt against a session's runtime.

| Attribute        | Type                  | Description                                                             |
| ---------------- | --------------------- | ----------------------------------------------------------------------- |
| `prompt`         | text                  | The user turn that started the run                                      |
| `cwd`            | text (path)           | SDK `cwd`; the session's workspace directory                            |
| `resume`         | text (UUID) \| none   | Existing session id to continue; none for a pending session's first run |
| `permissionMode` | enum `PermissionMode` | Mode the run started in (mutable mid-run)                               |
| `sessionId`      | text (UUID)           | Reported from the run's `init` message; re-keys the runtime (AS-R10)    |
| state            | enum                  | Streaming → Complete \| Errored \| Stopped (see spec)                   |

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
