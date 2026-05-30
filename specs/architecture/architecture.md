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
- **Hono server** — upgrades `/ws`, serves the embedded frontend in production. A connection
  is a **view**: it holds only which session it currently watches and (un)subscribes as it
  switches. Run state lives in a process-wide session-runtime registry, not on the connection.
- **session-runtime registry** — a module-level `Map<sessionId, SessionRuntime>` (in
  `server/src/runs.ts`) that owns each session's run: its abort/handle, an in-memory
  `baseline + buffer` of wire events for replay, the current viewers, and live status. Shared
  across connections so runs survive switching, refresh, and disconnect (ADR 0006).
- **session-registry** — manages the workspace registry and sessions (via the SDK), owns
  per-session mode and recent-access order, and persists that metadata to disk.
- **agent-session** — wraps the SDK `query()` loop, maps SDK messages onto the wire
  protocol, and exposes mid-run controls (mode switch, interrupt). Runs against the session's
  `cwd`, with `resume` for continuity; output flows into its runtime via `emit`.
- **permission-gateway** — the `canUseTool` callback plus a request→resolver registry. It
  blocks the SDK until the browser answers (indefinitely, like the CLI) or the run is aborted.
- **claude CLI** — spawned by the SDK as the actual agent process. How the SDK wraps and
  drives this process is documented in [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md).

## Module map

| Module                   | File                         | Role                                                                                                   |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| CLI entry                | `server/src/cli.ts`          | `commander` entry; `start` is the default command; `--project` defaults to cwd, `--port` to 3000       |
| HTTP/WS server           | `server/src/server.ts`       | Hono app, `/ws` upgrade, static serving, per-connection viewed session + dispatch + status broadcast   |
| Session-runtime registry | `server/src/runs.ts`         | Module-level `Map<sessionId, SessionRuntime>`: run handle, baseline+buffer, viewers, status (ADR 0006) |
| Agent loop               | `server/src/claude.ts`       | SDK `query()` (cwd/resume), `canUseTool`, claude PATH lookup, message mapping                          |
| Session registry         | `server/src/state.ts`        | Persisted workspace registry, per-session mode, last active session                                    |
| Session IO               | `server/src/sessions.ts`     | SDK `listSessions`/`getSessionMessages`/`rename`/`delete` + transcript mapping                         |
| Permission registry      | `server/src/permissions.ts`  | `pendingApprovals` map, `waitForDecision`/`resolveDecision`, timeout                                   |
| Result formatting        | `server/src/format.ts`       | Flatten SDK `tool_result` content to a display string                                                  |
| Requirement ledger       | `server/src/requirements/`   | SQLite ledger (`~/.c3/c3.db`), read-only communication agent, `save_requirements` tool (ADR 0007)      |
| Static embed             | `server/src/static-embed.ts` | Generated; Bun-inlined web bundle                                                                      |
| Wire protocol            | `shared/src/protocol.ts`     | `ClientToServer` / `ServerToClient` unions + workspace/session types                                   |
| WS client                | `web/src/lib/ws.ts`          | Browser WebSocket wrapper                                                                              |
| UI                       | `web/src/App.vue`            | Sidebar + chat view + permission dialog + mode select                                                  |

## Cross-cutting conventions

- **One contract.** `shared/src/protocol.ts` is the only definition of the wire format,
  imported by both ends. See [`../shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md).
- **Permission flows one way.** Only the gateway resolves a decision; the SDK never
  proceeds on a sensitive tool without it.
- **Permission state is global and in-memory.** No permission decision is ever persisted;
  pending requests are keyed by `requestId` so a backgrounded session's prompt is answerable
  after switching back.
- **Runs are decoupled from connections (ADR 0006).** Run state lives in the session-runtime
  registry, not the socket. Switching the viewed session and closing the socket only change
  subscriptions — the run continues in the background until it finishes or is explicitly
  stopped (`stop_run`). Different sessions run concurrently with no fixed cap; a single session
  is serial (it refuses a new prompt while its turn is in flight).
- **The workspace/session registry is persisted.** c3 keeps a small JSON registry
  (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`): workspaces + recent-access order,
  per-session mode, and the active session. Sessions themselves live in the SDK transcript
  store. See [ADR 0004](adr/0004-persist-workspace-session-registry.md).
- **Requirement ledger is a separate SQLite store (ADR 0007).** Project-scoped requirements live
  in `~/.c3/c3.db` (distinct from the registry's `~/.claude/c3/state.json`), behind a cross-runtime
  driver adapter (`node:sqlite` / `bun:sqlite`). It fails soft: if the db is unavailable,
  requirement features degrade but c3 still boots and serves normal sessions. The
  requirement-communication agent reuses the runtime registry and permission gateway as a
  read-only `requirement`-kind run.
- **Build order:** `web` then `server` — the server embeds the web bundle.

## Key decisions

| ADR                                                         | Decision                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [0001](adr/deprecated/0001-c3-sole-permission-authority.md) | _(superseded by 0005)_ c3 is the sole permission authority                                                             |
| [0002](adr/0002-websocket-as-permission-transport.md)       | WebSocket is the permission transport                                                                                  |
| [0003](adr/0003-single-binary-via-bun-compile.md)           | Ship as a single binary via `bun build --compile`                                                                      |
| [0004](adr/0004-persist-workspace-session-registry.md)      | Persist a c3-owned workspace & session registry                                                                        |
| [0005](adr/0005-inherit-user-project-settings.md)           | Inherit user & project settings; c3 is the permission gateway (`settingSources: ['user', 'project']`)                  |
| [0006](adr/0006-decouple-runs-from-connections.md)          | Decouple agent runs from WebSocket connections; runs live in a module-level registry                                   |
| [0007](adr/0007-read-only-requirement-agent.md)             | Read-only requirement-communication agent; `save_requirements` via the permission gateway; cross-runtime SQLite ledger |
