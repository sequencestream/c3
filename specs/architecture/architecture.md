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

- **Browser (web-console)** — Vue 3 SPA. Connects to `/ws`, renders the workspace/session
  sidebar and the activity stream, and is the surface for every permission decision and mode
  change.
- **Hono server** — upgrades `/ws`, serves the embedded frontend in production, and per
  connection holds the active session/workspace, the abort controller, and the live run handle.
- **session-registry** — manages the workspace registry and sessions (via the SDK), owns
  per-session mode and recent-access order, and persists that metadata to disk.
- **agent-session** — wraps the SDK `query()` loop, maps SDK messages onto the wire
  protocol, and exposes mid-run controls (mode switch, interrupt). Runs against the active
  session's `cwd`, with `resume` for continuity.
- **permission-gateway** — the `canUseTool` callback plus a request→resolver registry. It
  blocks the SDK until the browser answers or the timeout fires.
- **claude CLI** — spawned by the SDK as the actual agent process. How the SDK wraps and
  drives this process is documented in [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md).

## Module map

| Module              | File                         | Role                                                                              |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| CLI entry           | `server/src/cli.ts`          | `commander` entry; validates optional `--project` seed/`--port`                   |
| HTTP/WS server      | `server/src/server.ts`       | Hono app, `/ws` upgrade, static serving, per-connection active session + dispatch |
| Agent loop          | `server/src/claude.ts`       | SDK `query()` (cwd/resume), `canUseTool`, claude PATH lookup, message mapping     |
| Session registry    | `server/src/state.ts`        | Persisted workspace registry, per-session mode, active session                    |
| Session IO          | `server/src/sessions.ts`     | SDK `listSessions`/`getSessionMessages`/`rename`/`delete` + transcript mapping    |
| Permission registry | `server/src/permissions.ts`  | `pendingApprovals` map, `waitForDecision`/`resolveDecision`, timeout              |
| Result formatting   | `server/src/format.ts`       | Flatten SDK `tool_result` content to a display string                             |
| Static embed        | `server/src/static-embed.ts` | Generated; Bun-inlined web bundle                                                 |
| Wire protocol       | `shared/src/protocol.ts`     | `ClientToServer` / `ServerToClient` unions + workspace/session types              |
| WS client           | `web/src/lib/ws.ts`          | Browser WebSocket wrapper                                                         |
| UI                  | `web/src/App.vue`            | Sidebar + chat view + permission dialog + mode select                             |

## Cross-cutting conventions

- **One contract.** `shared/src/protocol.ts` is the only definition of the wire format,
  imported by both ends. See [`../shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md).
- **Permission flows one way.** Only the gateway resolves a decision; the SDK never
  proceeds on a sensitive tool without it.
- **Permission state is per-connection and in-memory.** No permission decision is ever
  persisted. Closing the socket aborts the in-flight run and discards run/permission state.
- **The workspace/session registry is persisted.** c3 keeps a small JSON registry
  (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`): workspaces + recent-access order,
  per-session mode, and the active session. Sessions themselves live in the SDK transcript
  store. See [ADR 0004](adr/0004-persist-workspace-session-registry.md).
- **Build order:** `web` then `server` — the server embeds the web bundle.

## Key decisions

| ADR                                                    | Decision                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| [0001](adr/0001-c3-sole-permission-authority.md)       | c3 is the sole permission authority (`settingSources: []`) |
| [0002](adr/0002-websocket-as-permission-transport.md)  | WebSocket is the permission transport                      |
| [0003](adr/0003-single-binary-via-bun-compile.md)      | Ship as a single binary via `bun build --compile`          |
| [0004](adr/0004-persist-workspace-session-registry.md) | Persist a c3-owned workspace & session registry            |
