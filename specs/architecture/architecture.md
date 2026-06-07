# Architecture Overview

## System shape

c3 is a single local process with two halves connected by one WebSocket:

```
┌────────────┐      /ws        ┌──────────────────────────────────────────────────┐
│  Browser   │ ──────────────► │  Hono server (this process)                      │
│  (Vue 3)   │ ◄─── ws ──────  │                                                  │
│            │                 │  web-console ↔ agent-session                     │
│ prompt     │                 │              ↕                                   │
│ activity   │                 │       permission-gateway                         │
│ Allow/Deny │                 │              ↕                                   │
│ mode       │                 │  Vendor-neutral adapter layer (ADR-0011)         │
│            │                 │  ┌──────────┬──────────┬──────────────┐          │
│            │                 │  │  Claude  │  Codex   │  OpenCode    │          │
│            │                 │  │  adapter │  adapter │  adapter     │          │
│            │                 │  └────┬─────┴────┬─────┴──────┬───────┘          │
│            │                 │       │          │            │                  │
│            │                 │  @anthropic-ai  @openai      @opencode-ai       │
│            │                 │  /claude-agent  /codex-sdk   /sdk               │
│            │                 │  -sdk           │            │                  │
│            │                 │       │          │            │                  │
│            │                 │       │    ┌─────┘            │  Responses→Chat  │
│            │                 │       │    │  relay proxy     │  relay (ADR-14)  │
│            │                 │       │    │  (ADR-0014)      │                  │
└────────────┘                 └───────┼────┼──────────────────┼──────────────────┘
                                       │    │                  │
                                       ▼    ▼                  ▼
                                   `claude` `codex`        `opencode`
                                    CLI      CLI        remote server
```

> 三个 SDK 的架构模式完全不同，详情见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)（Claude）、
> ADR-0011（vendor-neutral 抽象层设计）和 ADR-0014（Codex Responses→Chat relay）。
>
> | Vendor   | SDK 架构                 | 进程模型       | 工具级审批 |
> | -------- | ------------------------ | -------------- | ---------- |
> | Claude   | 子进程包装（JSON stdio） | 本地常驻子进程 | ✔ 逐工具   |
> | Codex    | 子进程包装（HTTP/SSE）   | 本地子进程     | ✗ 仅整轮   |
> | OpenCode | 远程服务（REST + SSE）   | 远程进程       | ✔ 回调+API |
>
> 三者的能力差异（中断、模式切换、流式输入、fork、session 操作等）由 `AdapterCapabilities` 荣誉标记检查表
> 管理，上层统一通过中性接口驱动（ADR-0011）。

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
- **agent-session** — wraps the vendor-neutral adapter layer, drives `AgentDriver.start()`,
  maps canonical messages onto the wire protocol, and exposes mid-run controls (mode switch, interrupt).
  Each vendor's SDK is sealed behind its adapter — the run loop never imports SDK types directly.
  - **Claude** uses `@anthropic-ai/claude-agent-sdk`'s `query()` loop via subprocess JSON stdio
    (see [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)).
  - **Codex** uses `@openai/codex-sdk` via subprocess HTTP/SSE, with an in-process
    Responses→Chat relay for third-party providers (ADR-0014).
  - **OpenCode** uses `@opencode-ai/sdk` via REST + SSE to a remote developer server.
- **permission-gateway** — the `ApprovalBridge` callback plus a request→resolver registry. For
  Claude and OpenCode (which support per-tool approval) it blocks the SDK until the browser
  answers; for Codex it degrades to launch-time policy (per-tool approval is structurally absent,
  ADR-0011 008 probe).
- **Agent host CLIs** — each vendor's CLI is a hard runtime dependency:
  - `claude` CLI — spawned by `@anthropic-ai/claude-agent-sdk` as a subprocess.
  - `codex` CLI — spawned by `@openai/codex-sdk` as a subprocess.
  - `opencode` CLI — runs as a remote server; `@opencode-ai/sdk` connects via HTTP.

## Module map

| Module                   | File                                | Role                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry                | `server/src/cli.ts`                 | `commander` entry; `start` is the default command; `--project` defaults to cwd, `--port` to 3000                                                                                                                                                                                             |
| HTTP/WS server           | `server/src/server.ts`              | Hono app, `/ws` upgrade, static serving, per-connection viewed session + dispatch + status broadcast                                                                                                                                                                                         |
| Session-runtime registry | `server/src/runs.ts`                | Module-level `Map<sessionId, SessionRuntime>`: run handle, baseline+buffer, viewers, status (ADR 0006)                                                                                                                                                                                       |
| Agent loop               | `server/src/claude.ts`              | `runClaude` — drives a vendor-neutral `AgentDriver.start()` through the adapter layer. Three concrete adapters (Claude/Codex/OpenCode) each import their own SDK inside the adapter, never in the run loop.                                                                                  |
| Vendor-neutral adapters  | `server/src/kernel/agent/adapters/` | Neutral three-piece interface (`AgentDriver`/`ApprovalBridge`/`SessionStore`) + capability ledger + permission grid + canonical message model; three concrete adapters, each importing a different SDK: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk` (ADR-0011) |
| ProcessLauncher          | `server/src/kernel/agent/process/   | Vendor-agnostic host-CLI probe: `resolve(vendor) → abs path \| null` + `HOST_BINARIES` table (binary/`*_PATH`/install hint) + `probeAll` health check; the first capability gate (ADR-0012). `infra/child-env.ts` Claude shims delegate here                                                 |
| Session registry         | `server/src/state.ts`               | Persisted workspace registry, per-session mode, last active session                                                                                                                                                                                                                          |
| Session IO               | `server/src/sessions.ts`            | SDK `listSessions`/`getSessionMessages`/`rename`/`delete` + transcript mapping                                                                                                                                                                                                               |
| Permission registry      | `server/src/permissions.ts`         | `pendingApprovals` map, `waitForDecision`/`resolveDecision`, timeout                                                                                                                                                                                                                         |
| Result formatting        | `server/src/format.ts`              | Flatten SDK `tool_result` content to a display string                                                                                                                                                                                                                                        |
| Intent ledger            | `server/src/intents/`               | SQLite ledger (`~/.c3/c3.db`), read-only communication agent, `save_intents` tool (ADR 0007)                                                                                                                                                                                                 |
| Static embed             | `server/src/static-embed.ts`        | Generated; Bun-inlined web bundle                                                                                                                                                                                                                                                            |
| Wire protocol            | `shared/src/protocol.ts`            | `ClientToServer` / `ServerToClient` unions + workspace/session types                                                                                                                                                                                                                         |
| WS client                | `web/src/lib/ws.ts`                 | Browser WebSocket wrapper                                                                                                                                                                                                                                                                    |
| UI shell                 | `web/src/App.vue`                   | Shell: owns WS client + `handleMessage` + all shared state; dispatches by tab to page containers                                                                                                                                                                                             |
| Pages                    | `web/src/pages/<page>/`             | Per-page containers (`sessions`/`intents`/`discussions`/`schedules`/`systemsettings`) + private components                                                                                                                                                                                   |
| Shared components        | `web/src/components/<Name>/`        | Cross-page components, one dir each with colocated `.test.ts`                                                                                                                                                                                                                                |

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
- **Intent ledger is a separate SQLite store (ADR 0007).** Project-scoped intents live
  in `~/.c3/c3.db` (distinct from the registry's `~/.claude/c3/state.json`), behind a cross-runtime
  driver adapter (`node:sqlite` / `bun:sqlite`). It fails soft: if the db is unavailable,
  intent features degrade but c3 still boots and serves normal sessions. The
  intent-communication agent reuses the runtime registry and permission gateway as a
  read-only `intent`-kind run.
- **DB migrations are idempotent, never drop tables, and roll back forward (hard rule).** Every
  c3.db schema change runs through a domain store's once-only schema-ensure and obeys this
  project-wide migration discipline:
  - **Idempotent + partial-state re-entrant.** Guard each step by _probing actual schema state_
    (`sqlite_master` / `PRAGMA table_info`), not by trusting `user_version` history alone. A db
    interrupted mid-migration must converge on the terminal state on any re-run, with no
    double-apply throw.
  - **No `DROP TABLE`, ever.** Reshape in place — `ALTER TABLE … ADD COLUMN` / `RENAME TO` /
    `RENAME COLUMN`. (Dropping an _index_ to rename it is fine; SQLite has no `RENAME INDEX`.)
    A data-moving change copies into a new table and keeps the old one until a later, separate
    migration retires it — never a destructive in-place swap.
  - **Roll back by forward-fix.** A bad migration is corrected by appending a _new_ reverse
    migration (e.g. a counter-rename), not by editing or deleting the original in history.
  - **Migration template.** Order = run table/column reshapes BEFORE `CREATE TABLE IF NOT EXISTS`
    (a fresh SCHEMA must not pre-create the new name and strand the old table's data); bump
    `SCHEMA_VERSION`; cover fresh-db, legacy-db, and partial-migration-db start points with a unit
    test that also asserts re-run idempotency.
  - **Review checklist** (every migration PR): ☐ idempotent re-run is a no-op ☐ partial-migration
    re-entry converges ☐ zero `DROP TABLE` ☐ no data loss (rows/edges survive) ☐ `SCHEMA_VERSION`
    bumped ☐ reshape precedes `CREATE TABLE IF NOT EXISTS` ☐ fresh/legacy/partial start points unit-tested.
- **Vendor neutrality lives in `kernel/agent/adapters/` (ADR-0011).** A neutral three-piece interface
  (`AgentDriver` lifecycle + canonical message stream, `ApprovalBridge` intercept/suspend/write-back,
  `SessionStore` history behind one face) plus an `AdapterCapabilities` ledger lets c3 drive Claude,
  Codex, or OpenCode through one shape. Required capabilities have no flag; seven optional/degradable
  ones (`interrupt`/`setActionMode`/`streamingPush`/`inProcessMcp`/`forkSession`/`perToolApproval`/`taskStore`) are
  probed before use. **Amendment (2026-06-07):** the session-lifecycle operations
  (`list`/`read`/`resume`/`rename`/`delete`) are graded honestly as a structured
  `SessionCapabilities` sub-ledger on `AdapterCapabilities` — each op a
  `'none' | 'partial' | 'full' | 'temporarily-unavailable'` `CapabilityState` — because a boolean
  could not tell `none` (structural NO — Codex's SDK has no listing/reading API) apart from
  `temporarily-unavailable` (mechanism exists, not currently reachable — OpenCode's REST write-back
  for `rename`/`delete`); the wire carries the per-vendor matrix on
  `settings.sessionCapabilities: Record<VendorId, SessionCapabilities>` and the console renders
  session-row actions by capability _state_, with **zero `if (vendor === …)`**. Permission is a
  neutral `(toolName, input, ctx) → allow|ask|deny` policy over an orthogonal
  `ActionMode{plan,build} × ToolGate{always-ask|on-sensitive|trusted-prefix|never-ask}` grid
  (Claude's five-way `PermissionMode` no longer maps 1:1). **No vendor SDK type crosses into
  `adapters/types.ts` or `shared/protocol.ts`** — SDK values enter an adapter as `unknown` and are
  narrowed there (ADR-0009). Today the Claude reference adapter delegates to the existing `runClaude` /
  gateway / `sessions.ts`; the run-loop rewrite that makes the driver the only path is a later phase.
- **Host-binary probing is the first capability gate (ADR-0012).** Every agent vendor runs as a
  host-CLI subprocess that can NOT be packed into c3's single binary — the binary ships c3 only, so
  each agent type needs its vendor CLI installed on the host PATH. `ProcessLauncher.resolve(vendor)`
  yields the absolute path or `null`; the adapter `registry` constructs a vendor's `VendorAdapter`
  **only** when its binary resolves, so an absent CLI means the agent type is unavailable (a product
  convention, not a bug) with install guidance, and its capability ledger never comes into play. A
  boot-time `logHostBinaryHealth()` reports present/missing loudly but non-fatally (like `checkDbDriver`).
- **Build order:** `web` then `server` — the server embeds the web bundle.
- **Web module structure.** The frontend follows a page/component directory convention:
  - Shared (cross-page) components: `web/src/components/<Name>/<Name>.vue`, one dir per component
    with its colocated `<Name>.test.ts`.
  - Page-private components: `web/src/pages/<page>/components/<Name>/<Name>.vue` (+ colocated test).
  - Page containers: `web/src/pages/<page>/<Page>.vue`. Pages are
    `sessions` / `intents` / `discussions` / `schedules` / `systemsettings`.
  - `App.vue` is the shell: it owns the WS client, `handleMessage`, and all shared/tab state, and
    dispatches to page containers by `activeTab`. Page containers are **pure** (props in / emit up) —
    no domain state of their own (the queue-edit `composer.prefill` is forwarded via `defineExpose`).
    `lib/` (pure logic + unit-tested view helpers) and `composables/` sit at `web/src/` and are
    imported by both layers.
  - The `sessions` and `intents` pages share the chat column by each assembling it from the same
    shared components (`ChatMessages` / `MessageInput` / …), not via a wrapper component.
  - Page containers are route-level views and may be single-word (`vue/multi-word-component-names` is
    disabled for `web/src/pages/*/*.vue`); their private components keep the multi-word rule.
  - Vitest runs SFC-mounting tests under `web/src/components/**` and `web/src/pages/**` in happy-dom;
    other tests run in node.

## Key decisions

| ADR                                                         | Decision                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](adr/deprecated/0001-c3-sole-permission-authority.md) | _(superseded by 0005)_ c3 is the sole permission authority                                                                                                    |
| [0002](adr/0002-websocket-as-permission-transport.md)       | WebSocket is the permission transport                                                                                                                         |
| [0003](adr/0003-single-binary-via-bun-compile.md)           | Ship as a single binary via `bun build --compile`                                                                                                             |
| [0004](adr/0004-persist-workspace-session-registry.md)      | Persist a c3-owned workspace & session registry                                                                                                               |
| [0005](adr/0005-inherit-user-project-settings.md)           | Inherit user & project settings; c3 is the permission gateway (`settingSources: ['user', 'project']`)                                                         |
| [0006](adr/0006-decouple-runs-from-connections.md)          | Decouple agent runs from WebSocket connections; runs live in a module-level registry                                                                          |
| [0007](adr/0007-read-only-intent-agent.md)                  | Read-only intent-communication agent; `save_intents` via the permission gateway; cross-runtime SQLite ledger                                                  |
| [0009](adr/0009-unidirectional-boundaries.md)               | Unidirectional boundaries: kernel → transport/features; SDK types never leave the kernel                                                                      |
| [0011](adr/0011-vendor-neutral-agent-abstraction.md)        | Vendor-neutral Agent abstraction: required three-piece interface + probed capability ledger; `PermissionMode` 1:1 dropped for an `ActionMode × ToolGate` grid |
| [0012](adr/0012-host-binary-probe-first-capability-gate.md) | Host-binary probing is the first capability gate; an absent vendor CLI ⇒ agent type unavailable (install per agent type, single binary is not self-contained) |
