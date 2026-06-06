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

| Attribute  | Type | Description                                                                     |
| ---------- | ---- | ------------------------------------------------------------------------------- |
| `decision` | enum | `allow` \| `deny`                                                               |
| source     | enum | `user` (browser response) \| `abort` (run torn down) \| `timeout` (out-of-loop) |

Relationships: at most one Decision per Permission Request (spec invariant). An `abort`
source always carries `deny`. The `timeout` source exists **only for out-of-loop vendors**
(OpenCode, PG-R11): the request blocks in the vendor's process across an SSE link, so an
unanswered one times out to `deny` rather than hanging forever. The in-loop Claude path has
no timeout source — its request waits indefinitely (PG-R2).

### Vendor write-back (out-of-loop only, 2026-06-06-003)

For an out-of-loop vendor the neutral `allow`/`deny` is translated to the vendor's native
write-back value, e.g. OpenCode `POST /session/{id}/permissions/{permissionID}` with
`response`: `allow` → `once`, `deny` → `reject` (`always` is not used). A structured
`404 PermissionNotFoundError` on write-back means the id went stale and is treated as resolved.

## Notes

- These entities are transient and in-memory; they are not persisted (SEC-2).
- `input` is `unknown` at the domain boundary and is never interpreted or mutated by the
  gateway (rule PG-R6).
