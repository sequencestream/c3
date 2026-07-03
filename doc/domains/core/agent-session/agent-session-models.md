# agent-session — Models

Entity definitions. Business-semantic types; behavioral wiring in [agent-session-design.md](agent-session-design.md).

## Session Runtime

Process-wide owner of one session's execution, keyed by session id and shared across
connections (ADR 0006). Lives for the process lifetime once created (no eviction yet).

| Attribute      | Type                        | Description                                                                                              |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Session id     | text (UUID \| pending form) | Map key; re-keyed pending→real on first bind (AS-R10)                                                    |
| Workspace path | text (path)                 | The run's working directory (runtime-owned)                                                              |
| Mode           | permission mode             | The session's mode; the run's starting policy (AS-R3, SR-R5)                                             |
| Baseline       | list of transcript items    | On-disk transcript snapshot at runtime creation; replayed before the buffer                              |
| Buffer         | list of wire events         | Every event emitted since creation (all turns); replayed on view join (AS-R11)                           |
| Run            | reference \| none           | The in-flight Agent Run's abort + handle, or none between turns                                          |
| Status         | enum                        | idle \| running \| awaiting_permission \| team (AS-R12)                                                  |
| Session kind   | enum                        | work \| intent \| spec \| discussion \| automation \| tool; tags the runtime for projection/list routing |
| Viewers        | set of delivery callbacks   | Connections currently watching this session; live events fan out to them                                 |

Relationships: at most one in-flight Agent Run per runtime (serial, AS-R2); many runtimes run
concurrently. Survives connection close (AS-R8); torn down on `delete_session` /
`remove_workspace`. On bind, the runtime's kind and any launching-domain owner are mirrored into
the rebuildable `session_metadata` projection for list/count reads; the runtime remains the live
execution source of truth.

## Connection View

One WebSocket connection's subscription to the session it currently watches.

| Attribute | Type            | Description                                                         |
| --------- | --------------- | ------------------------------------------------------------------- |
| Viewing   | text id \| none | The session this connection currently watches (a runtime key)       |
| Deliver   | operation       | Sends a wire event to this connection's socket (viewer + broadcast) |

Relationships: registered as a viewer of the viewed runtime; also in the global broadcast set
for `session_status`. On switch, unsubscribes the old and subscribes the new; on close,
unsubscribes only — the run is unaffected.

## Agent Run

One `query()` invocation driven by one user prompt against a session's runtime.

| Attribute       | Type                | Description                                                             |
| --------------- | ------------------- | ----------------------------------------------------------------------- |
| Prompt          | text                | The user's first turn, seeded into the streaming-input prompt (AS-R13)  |
| Working dir     | text (path)         | The SDK `cwd`; the session's workspace directory                        |
| Resume id       | text (UUID) \| none | Existing session id to continue; none for a pending session's first run |
| Permission mode | permission mode     | Mode the run started in (mutable mid-run)                               |
| Session id      | text (UUID)         | Reported from the run's `init` message; re-keys the runtime (AS-R10)    |
| State           | enum                | Streaming → Complete \| Errored \| Stopped (see spec)                   |

Relationships: produces a stream of wire events; gates sensitive tools via Permission
Requests (permission-gateway domain).

## Run Handle

Live controls handed to the connection when a run starts.

| Operation  | Description                                                                       |
| ---------- | --------------------------------------------------------------------------------- |
| Set mode   | Applies a new mode to the in-flight run (AS-R4)                                   |
| Push input | Feeds the next user turn into the live streaming session — team sessions (AS-R17) |

Relationships: exists only while a run is in flight; cleared to none when the run ends.

## Run Options

The inputs to a run. Business-relevant additions beyond the SDK options listed in
[agent-session-design.md](agent-session-design.md) § Run construction:

| Input                      | Kind     | Description                                                                                                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start callback             | callback | Fires once with the **Run Handle** so the caller can drive the live run                                                                                          |
| Session-id callback        | callback | Fires once with the SDK session id from the `init` message (AS-R10)                                                                                              |
| Team callback              | callback | Fires once when the first team tool is detected — the run becomes persistent (AS-R14)                                                                            |
| Degradable-error callback  | callback | Fires on a rate-limit/auth/connection error so the caller can switch agents (degradation chain); the run skips its terminal `turn_end`                           |
| Socket-disconnect callback | callback | Fires on `socket connection was closed unexpectedly` with the AS-R19 gate verdict so the caller can decide a single auto-`resume`; run skips `turn_end` (AS-R18) |
| Reconnect-attempt flag     | boolean  | True when this run **is** the single post-disconnect auto-`resume`; stamps the turn's `turn_end` with `reconnect_attempted`/`retry_count` (AS-R18)               |

## Permission mode

`default` · `auto` · `plan` · `acceptEdits` · `bypassPermissions`. Defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md); semantics for
gating in [agent-session-spec.md](agent-session-spec.md) § Permission modes.
