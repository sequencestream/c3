# Domain: permission-gateway

- **Group:** core
- **One-line:** Gates every sensitive tool call behind a human decision routed to the browser.
- **Owner:** maintainer
- **Status:** active
- **Depends on:** the SDK's sensitive-tool callback contract; the WebSocket transport
  provided by agent-session.
- **Depended on by:** agent-session (calls into the gateway from the SDK run options).
- **exposes-api:** false
- **notes:** Internal domain. Its only outward surface is the `permission_request` /
  `permission_response` pair on the shared WebSocket protocol.
- **ADRs:** [0005](../../../architecture/adr/0005-inherit-user-project-settings.md)
  (supersedes [0001](../../../architecture/adr/deprecated/0001-c3-sole-permission-authority.md)),
  [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)

## Index

- [permission-gateway-spec.md](permission-gateway-spec.md) — business rules and states
- [permission-gateway-design.md](permission-gateway-design.md) — registry, abort wiring, callback wiring
- [permission-gateway-models.md](permission-gateway-models.md) — Permission Request / Decision entities
