# permission-gateway — Models

Entity definitions for the gateway. Types are business-semantic; physical representation
is in [design.md](design.md).

## Permission Request

A single pending question about one tool call.

| Attribute   | Type        | Description                                                    |
| ----------- | ----------- | -------------------------------------------------------------- |
| `requestId` | text (UUID) | Unique correlation key for this request                        |
| `toolName`  | text        | Name of the tool the agent wants to run (e.g. `Write`, `Bash`) |
| `input`     | unknown     | The tool's proposed input, passed through verbatim for display |
| state       | enum        | `Pending` → `Allowed` \| `Denied` (see spec state machine)     |

Relationships: produced by one `canUseTool` invocation; resolved by at most one Permission
Decision.

## Permission Decision

The resolution of a request.

| Attribute  | Type | Description                                        |
| ---------- | ---- | -------------------------------------------------- |
| `decision` | enum | `allow` \| `deny`                                  |
| source     | enum | `user` (browser response) \| `timeout` (auto-deny) |

Relationships: at most one Decision per Permission Request (spec invariant). A `timeout`
source always carries `deny`.

## Notes

- These entities are transient and in-memory; they are not persisted (SEC-2).
- `input` is `unknown` at the domain boundary and is never interpreted or mutated by the
  gateway (rule PG-R6).
