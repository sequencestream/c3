# Group: core

The `core` group holds c3's five bounded contexts. Together they implement the full loop:
the user picks a workspace/session, a prompt comes in from the browser, the agent runs,
sensitive tool calls are gated through the browser, and activity streams back —
plus a project-scoped requirement ledger that feeds work into that loop.

## Domains

| Domain                                                                              | Responsibility                                                                                                                              | API                                   | Status |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| [permission-gateway](permission-gateway/permission-gateway-overview.md)             | Intercept SDK permission requests, route to browser, block until the user decides (deny on abort)                                           | Internal (no public HTTP API)         | active |
| [agent-session](agent-session/agent-session-overview.md)                            | Drive the SDK `query()` loop, map SDK messages to the wire protocol, manage mode & lifecycle                                                | WebSocket `/ws` (see shared protocol) | active |
| [session-registry](session-registry/session-registry-overview.md)                   | Manage workspaces & sessions; own per-session mode, recent-access order, history replay                                                     | WebSocket `/ws` (see shared protocol) | active |
| [web-console](web-console/web-console-overview.md)                                  | Browser UI: sidebar, prompt input, activity stream, permission dialog, mode switch                                                          | Consumes `/ws`                        | active |
| [requirement-management](requirement-management/requirement-management-overview.md) | Project-scoped requirement ledger (SQLite); read-only requirement-communication agent; `save_requirements` confirmation; launch `/sdd-lite` | WebSocket `/ws` (see shared protocol) | active |

## Shared context

- All three share the wire protocol in
  [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md).
- `agent-session`, `permission-gateway`, and `session-registry` run in the server process.
  agent-session and permission-gateway collaborate through the in-memory permission registry;
  session-registry supplies the active workspace `cwd`, per-session mode, and `resume` id to
  each run. `web-console` is the browser counterpart.

## Dependency direction

```
web-console ──(/ws)──► session-registry ──supplies cwd/mode/resume──► agent-session ──uses──► permission-gateway ──blocks──► SDK query()
```

`web-console` depends on the server's wire contract; `session-registry` feeds each run's
context to `agent-session`; `agent-session` depends on `permission-gateway` to gate tools.
No cycles.
