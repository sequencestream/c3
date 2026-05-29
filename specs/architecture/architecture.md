# Architecture Overview

## System shape

c3 is a single local process with two halves connected by one WebSocket:

```
┌────────────┐      /ws        ┌────────────────────────────────┐
│  Browser   │ ──────────────► │  Hono server (this process)    │
│  (Vue 3)   │ ◄─── ws ──────  │                                │
│            │                 │  web-console ↔ agent-session   │
│ prompt     │                 │              ↕                 │
│ activity   │                 │       permission-gateway       │
│ Allow/Deny │                 │              ↕                 │
│ mode       │                 │   @anthropic-ai/claude-agent   │
└────────────┘                 │            -sdk  query()       │
                               └───────────────┬────────────────┘
                                               │ spawns
                                               ▼
                                        `claude` CLI binary
```

- **Browser (web-console)** — Vue 3 SPA. Connects to `/ws`, renders the activity stream,
  and is the surface for every permission decision and mode change.
- **Hono server** — upgrades `/ws`, serves the embedded frontend in production, and per
  connection holds the permission mode, the abort controller, and the live run handle.
- **agent-session** — wraps the SDK `query()` loop, maps SDK messages onto the wire
  protocol, and exposes mid-run controls (mode switch, interrupt).
- **permission-gateway** — the `canUseTool` callback plus a request→resolver registry. It
  blocks the SDK until the browser answers or the timeout fires.
- **claude CLI** — spawned by the SDK as the actual agent process.

## Module map

| Module              | File                         | Role                                                                 |
| ------------------- | ---------------------------- | -------------------------------------------------------------------- |
| CLI entry           | `server/src/cli.ts`          | `commander` entry; validates `--project`/`--port`, starts the server |
| HTTP/WS server      | `server/src/server.ts`       | Hono app, `/ws` upgrade, static serving, per-connection state        |
| Agent loop          | `server/src/claude.ts`       | SDK `query()`, `canUseTool`, claude PATH lookup, message mapping     |
| Permission registry | `server/src/permissions.ts`  | `pendingApprovals` map, `waitForDecision`/`resolveDecision`, timeout |
| Result formatting   | `server/src/format.ts`       | Flatten SDK `tool_result` content to a display string                |
| Static embed        | `server/src/static-embed.ts` | Generated; Bun-inlined web bundle                                    |
| Wire protocol       | `shared/src/protocol.ts`     | `ClientToServer` / `ServerToClient` unions                           |
| WS client           | `web/src/lib/ws.ts`          | Browser WebSocket wrapper                                            |
| UI                  | `web/src/App.vue`            | Chat view + permission dialog + mode select                          |

## Cross-cutting conventions

- **One contract.** `shared/src/protocol.ts` is the only definition of the wire format,
  imported by both ends. See [`../shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md).
- **Permission flows one way.** Only the gateway resolves a decision; the SDK never
  proceeds on a sensitive tool without it.
- **State is per-connection and in-memory.** No persistence. Closing the socket aborts the
  run and discards state.
- **Build order:** `web` then `server` — the server embeds the web bundle.

## Key decisions

| ADR                                                   | Decision                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| [0001](adr/0001-c3-sole-permission-authority.md)      | c3 is the sole permission authority (`settingSources: []`) |
| [0002](adr/0002-websocket-as-permission-transport.md) | WebSocket is the permission transport                      |
| [0003](adr/0003-single-binary-via-bun-compile.md)     | Ship as a single binary via `bun build --compile`          |
