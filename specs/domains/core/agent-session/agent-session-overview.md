# Domain: agent-session

- **Group:** core
- **One-line:** Drives the Claude Agent SDK `query()` loop for one connection and maps its
  messages to the wire protocol.
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `@anthropic-ai/claude-agent-sdk`; the host `claude` CLI;
  `permission-gateway` (for tool gating).
- **Depended on by:** `web-console` (consumes its wire events).
- **exposes-api:** true — the WebSocket `/ws` endpoint. Message shapes are defined in the
  shared protocol, not here.
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md),
  [0003](../../../architecture/adr/0003-single-binary-via-bun-compile.md)

## Index

- [agent-session-spec.md](agent-session-spec.md) — run lifecycle, permission modes, message mapping rules
- [agent-session-design.md](agent-session-design.md) — `query()` wiring, abort/interrupt, claude PATH lookup
- [agent-session-models.md](agent-session-models.md) — Session, Agent Run, Run Handle entities
