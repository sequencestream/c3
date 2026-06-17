# permission-gateway — Models

Entity definitions for the gateway. Types are business-semantic; physical representation
is in [permission-gateway-design.md](permission-gateway-design.md).

## Permission Request

A single pending question about one tool call.

| Attribute   | Type        | Description                                                    |
| ----------- | ----------- | -------------------------------------------------------------- |
| `requestId` | text (UUID) | Unique correlation key for this request                        |
| `toolName`  | text        | Name of the tool the agent wants to run (e.g. `Write`, `Bash`) |
| `input`     | opaque      | The tool's proposed input, passed through verbatim for display |
| state       | enum        | `Pending` → `Allowed` \| `Denied` (see spec state machine)     |

Relationships: produced by one sensitive-tool callback invocation; resolved by at most one
Permission Decision.

## Permission Decision

The resolution of a request.

| Attribute  | Type | Description                                                                     |
| ---------- | ---- | ------------------------------------------------------------------------------- |
| `decision` | enum | `allow` \| `deny`                                                               |
| source     | enum | `user` (browser response) \| `abort` (run torn down) \| `timeout` (out-of-loop) |

Relationships: at most one Decision per Permission Request (spec invariant). An `abort`
source always carries `deny`. The `timeout` source exists **only for out-of-loop vendors**
unanswered one times out to `deny` rather than hanging forever. The in-loop Claude path has
no timeout source — its request waits indefinitely (PG-R2).

### Vendor write-back (out-of-loop only, 2026-06-06-003)

For an out-of-loop vendor the neutral `allow`/`deny` is translated to the vendor's native
response: `allow` → "allow once", `deny` → "reject" (the "always allow" form is not used). A
structured "permission not found" (404) on write-back means the id went stale and is treated as
resolved.

## Notes

- These entities are transient and in-memory; they are not persisted (SEC-2).
- `input` is opaque at the domain boundary and is never interpreted or mutated by the
  gateway (rule PG-R6).
