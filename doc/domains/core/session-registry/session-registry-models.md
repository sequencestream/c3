# session-registry — Models

Entity definitions in domain terms; physical wiring in [session-registry-design.md](session-registry-design.md).
The workspace, session, and transcript-item wire shapes are defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md); this domain
references them rather than redefining message shapes.

## Workspace

A registered project directory.

| Attribute      | Type        | Description                                                                                             |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `path`         | text (path) | Absolute directory; the working directory passed to the agent and the key sessions are enumerated under |
| `name`         | text        | Display name — the directory's basename                                                                 |
| `lastAccessed` | timestamp   | Last time a session here was selected/created; sort key desc (SR-R2)                                    |

Relationships: a workspace has zero or more Sessions. The read-side list comes from
`session_metadata`; content and transcripts still live in native vendor stores.

## Session

A vendor-backed conversation inside a workspace, projected into `session_metadata`
for list/count reads.

| Attribute      | Type            | Description                                                             |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| `sessionId`    | text            | Opaque c3 session id on the wire; maps internally to vendor + native id |
| `title`        | text            | Vendor custom title / summary / first prompt                            |
| `lastModified` | timestamp       | Vendor last-modified; sort key within a workspace (SR-R4)               |
| `mode`         | permission mode | c3-tracked per-session permission mode; default `default` (SR-R5)       |
| `sessionKind`  | enum            | work / intent / spec / discussion / automation / tool                   |
| `ownerKind`    | enum \| null    | Logical owner kind used for jump-back; null for ownerless sessions      |
| `ownerId`      | text \| null    | Logical owner id; null means the session cannot jump back to an owner   |
| `bound`        | boolean         | true for real rows; false only for work pending placeholders            |

Relationships: belongs to one Workspace; its transcript & title are owned by the agent vendor, its
`mode` by the registry. Owner fields point back to domain entities such as an intent, discussion,
or automation; they do not make the projection the source of truth for those domains. A spec session
row uses `sessionKind=spec`, `ownerKind=intent`, and the intent id as `ownerId`; the intent domain
still owns the current spec-session link through `intents.spec_session_id`. A tool session row uses
`sessionKind=tool`; when a triggering business origin is known it reuses `ownerKind` / `ownerId` for
jump-back, and when the origin is unknown or historical it leaves both null so the row is display-only.

## Pending Session

A session created in the UI but not yet started.

| Attribute  | Type                    | Description                                                   |
| ---------- | ----------------------- | ------------------------------------------------------------- |
| `clientId` | text (`pending:<uuid>`) | Temporary id until the first run reports a real `sessionId`   |
| `mode`     | permission mode         | Starts `default`; persisted under the real id on bind (SR-R7) |

Relationships: replaced by a real Session once the first run binds a real session id.

## Persisted state (state.json)

The c3-owned registry — the only persisted c3 data (ADR 0004).

| Field             | Type                             | Description                                 |
| ----------------- | -------------------------------- | ------------------------------------------- |
| `version`         | `1`                              | Schema version                              |
| `workspaces`      | list of Workspace                | The registry (SR-R2)                        |
| `sessionModes`    | map session id → permission mode | Per-session mode (SR-R5); stale ids ignored |
| `activeSessionId` | text \| null                     | Last active real session, for boot          |

Never contains permission decisions or approvals (SR-R11).

## Session runtime (in-memory)

The per-session run state is owned by agent-session — its full shape is the
**Session Runtime** in the [agent-session models](../agent-session/agent-session-models.md). The registry only
seeds it (working directory / mode / baseline) and reads its run status. Note its team flag
(set when a run upgrades to a persistent agent team, reset on teardown; ADR 0008): it overrides
a `turn_end`'s implied idle to the team status (see [session-registry-design.md](session-registry-design.md) § Team-session
status). Never persisted.
