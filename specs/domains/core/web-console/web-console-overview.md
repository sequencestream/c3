# Domain: web-console

- **Group:** core
- **One-line:** The browser UI — send prompts, watch the agent work, answer Allow/Deny,
  switch permission mode.
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `agent-session`'s WebSocket contract (the shared protocol).
- **Depended on by:** none (it is the top of the stack).
- **exposes-api:** false — it is a client; it consumes `/ws` and serves no API.
- **notes:** Vue 3 SPA built with Vite. In production the bundle is served by the Hono
  server (filesystem or embedded); in dev it runs on Vite :5173 with `/ws` proxied to :3000.
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)

## Index

- [spec.md](spec.md) — UI behavior and rules
- [design.md](design.md) — Vue components, WS client, state
- [models.md](models.md) — Chat Message view model
