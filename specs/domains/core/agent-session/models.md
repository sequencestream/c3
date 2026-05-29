# agent-session — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md).

## Session

The lifetime of one WebSocket connection.

| Attribute     | Type                  | Description                                                                      |
| ------------- | --------------------- | -------------------------------------------------------------------------------- |
| `currentMode` | enum `PermissionMode` | Active permission policy; persists for the connection (AS-R3). Starts `default`. |
| `runAbort`    | reference \| none     | The in-flight run's abort handle, or none between runs                           |
| `runHandle`   | reference \| none     | Live controls for the in-flight run, or none                                     |

Relationships: one Session has at most one in-flight Agent Run (AS-R2). State is discarded
on connection close (AS-R8).

## Agent Run

One `query()` invocation driven by one user prompt.

| Attribute        | Type                  | Description                                           |
| ---------------- | --------------------- | ----------------------------------------------------- |
| `prompt`         | text                  | The user turn that started the run                    |
| `projectPath`    | text (path)           | SDK `cwd`; the project directory                      |
| `permissionMode` | enum `PermissionMode` | Mode the run started in (mutable mid-run)             |
| state            | enum                  | Streaming → Complete \| Errored \| Aborted (see spec) |

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
