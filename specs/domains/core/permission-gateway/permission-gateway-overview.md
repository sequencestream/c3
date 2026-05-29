# Domain: permission-gateway

- **Group:** core
- **One-line:** Gates every sensitive tool call behind a human decision routed to the browser.
- **Owner:** maintainer
- **Status:** active
- **Depends on:** the SDK's `canUseTool` callback contract; the WebSocket transport
  provided by `agent-session`.
- **Depended on by:** `agent-session` (calls into the gateway from the `query()` options).
- **exposes-api:** false
- **notes:** Internal domain. Its only outward surface is the `permission_request` /
  `permission_response` pair on the shared WebSocket protocol.
- **ADRs:** [0001](../../../architecture/adr/0001-c3-sole-permission-authority.md),
  [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)

## Index

- [spec.md](spec.md) — business rules and states
- [design.md](design.md) — registry, timeout, callback wiring
- [models.md](models.md) — Permission Request / Decision entities
