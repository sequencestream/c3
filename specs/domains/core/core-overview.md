# Group: core

The `core` group holds c3's three bounded contexts. Together they implement the full loop:
a prompt comes in from the browser, the agent runs, sensitive tool calls are gated through
the browser, and activity streams back.

## Domains

| Domain                                                                  | Responsibility                                                                               | API                                   | Status |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| [permission-gateway](permission-gateway/permission-gateway-overview.md) | Intercept SDK permission requests, route to browser, await decision, auto-deny on timeout    | Internal (no public HTTP API)         | active |
| [agent-session](agent-session/agent-session-overview.md)                | Drive the SDK `query()` loop, map SDK messages to the wire protocol, manage mode & lifecycle | WebSocket `/ws` (see shared protocol) | active |
| [web-console](web-console/web-console-overview.md)                      | Browser UI: prompt input, activity stream, permission dialog, mode switch                    | Consumes `/ws`                        | active |

## Shared context

- All three share the wire protocol in
  [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md).
- `agent-session` and `permission-gateway` run in the server process and collaborate
  through the in-memory permission registry. `web-console` is the browser counterpart.

## Dependency direction

```
web-console  ──(/ws)──►  agent-session  ──uses──►  permission-gateway  ──blocks──►  SDK query()
```

`web-console` depends on `agent-session`'s wire contract; `agent-session` depends on
`permission-gateway` to gate tools. No cycles.
