# Architecture Overview

## System shape

c3 is a single local process with two halves connected by one WebSocket:

```
┌────────────┐      /ws        ┌──────────────────────────────────────────────────┐
│  Browser   │ ──────────────► │  Local server (this process)                     │
│  (web SPA) │ ◄─── ws ──────  │                                                  │
│            │                 │  web-console ↔ agent-session                     │
│ prompt     │                 │              ↕                                   │
│ activity   │                 │       permission-gateway                         │
│ Allow/Deny │                 │              ↕                                   │
│ mode       │                 │  Vendor-neutral adapter layer (ADR-0011)         │
│            │                 │  ┌──────────┬──────────┬──────────────┐          │
│            │                 │  │  adapter │  adapter │  adapter     │          │
│            │                 │  └────┬─────┴────┬─────┴──────┬───────┘          │
│            │                 │       │          │            │                  │
│            │                 │     Claude     Codex        other               │
│            │                 │     vendor     vendor       vendor               │
│            │                 │       │          │            │                  │
│            │                 │       │    ┌─────┘            │  Responses→Chat  │
│            │                 │       │    │  relay proxy     │  relay (ADR-14)  │
│            │                 │       │    │  (ADR-0014)      │                  │
└────────────┘                 └───────┼────┼──────────────────┼──────────────────┘
                                       │    │                  │
                                       ▼    ▼                  ▼
                                    CLI      CLI        remote server
```

> 三个 vendor 的接入模式完全不同，详情见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)（Claude）、
> ADR-0011（vendor-neutral 抽象层设计）和 ADR-0014（Codex Responses→Chat relay）。
>
> | Vendor | 接入架构                 | 进程模型       | 工具级审批 |
> | ------ | ------------------------ | -------------- | ---------- |
> | Claude | 子进程包装（JSON stdio） | 本地常驻子进程 | ✔ 逐工具   |
> | Codex  | 子进程包装（HTTP/SSE）   | 本地子进程     | ✗ 仅整轮   |
>
> 三者的能力差异（中断、模式切换、流式输入、fork、session 操作等）由一份逐能力声明的检查表
> 管理，上层统一通过中性接口驱动（ADR-0011）。

- **Browser (web-console)** — a single-page web app. Connects over `/ws`, renders the
  workspace/session sidebar and the activity stream, and is the surface for every permission
  decision and mode change.
- **Local server** — upgrades `/ws` and serves the embedded frontend in production. A connection
  is a **view**: it holds only which session it currently watches and (un)subscribes as it
  switches. Run state lives in a process-wide session-runtime registry, not on the connection.
- **session-runtime registry** — a process-wide registry that owns each session's run: its
  abort handle, an in-memory baseline + buffer of wire events for replay, the current viewers,
  and live status. Shared across connections so runs survive switching, refresh, and disconnect
  (ADR 0006).
- **session-registry** — manages the workspace registry and sessions, owns
  per-session mode and recent-access order, and persists that metadata to disk.
- **agent-session** — drives the vendor-neutral adapter layer through its lifecycle, maps
  canonical messages onto the wire protocol, and exposes mid-run controls (mode switch, interrupt).
  Each vendor's SDK/CLI details are sealed behind its adapter — the run loop never touches SDK
  types directly.
  - **Claude** runs the Claude Agent SDK query loop via subprocess JSON stdio
    (see [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)).
  - **Codex** runs the `codex` CLI in experimental-JSON mode, with an in-process
    Responses→Chat relay for third-party providers (ADR-0014).
- **permission-gateway** — an approval-bridge callback plus a request→resolver registry that
  routes a sensitive tool to the browser and blocks until the user answers; for Codex it degrades
  to launch-time policy (per-tool approval is structurally absent, ADR-0011).
- **Agent host CLIs** — each vendor's CLI is a hard runtime dependency:
  - the `claude` CLI — spawned by the Claude Agent SDK as a subprocess.
  - the `codex` CLI — spawned by c3 as a subprocess.

## Module map

| Module                   | Role                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry                | Command-line entry; `start` is the default command; `--workspace` defaults to the current directory (`--project` is a deprecated alias), `--port` to 3000                               |
| HTTP/WS server           | Upgrades `/ws`, serves static assets, tracks each connection's viewed session, dispatches messages, and broadcasts status                                                               |
| Session-runtime registry | Process-wide registry of each session's run handle, replay baseline + buffer, viewers, and status (ADR 0006)                                                                            |
| Host-CLI launcher        | Vendor-agnostic host-CLI probe: resolves a vendor to an absolute binary path or none, carries an install hint per vendor, and runs a health check; the first capability gate (ADR-0012) |
| Kernel event bus         | In-process typed publish/subscribe bus: synchronous, error-isolated, statically typed topic→payload map; hosts the run-bound and run-settled events (ADR-0018)                          |
| Session registry         | Persisted workspace registry, per-session mode, last active session                                                                                                                     |
| Session IO               | List / read / rename / delete sessions plus transcript mapping                                                                                                                          |
| Permission registry      | The pending-approval map with wait/resolve-decision and timeout handling                                                                                                                |
| Result formatting        | Flattens tool-result content into a display string                                                                                                                                      |
| Intent ledger            | SQLite ledger, read-only communication agent, intent-save tool (ADR 0007)                                                                                                               |
| Static embed             | Generated, inlined web bundle                                                                                                                                                           |
| Wire protocol            | The client→server / server→client message unions plus workspace/session types                                                                                                           |
| WS client                | Browser WebSocket wrapper                                                                                                                                                               |
| UI shell                 | Owns the WS client, the inbound-message handler, and all shared state; dispatches by tab to page containers                                                                             |
| Pages                    | Per-page containers (works / intents / discussions / schedules / systemsettings) plus private components                                                                                |
| Shared components        | Cross-page components, each with a colocated unit test                                                                                                                                  |

## Cross-cutting conventions

- **One contract.** There is a single definition of the wire format, shared by both ends.
  See [`../shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md).
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
    (a fresh schema must not pre-create the new name and strand the old table's data); bump the
    schema version; cover fresh-db, legacy-db, and partial-migration-db start points with a test
    that also asserts re-run idempotency.
  - **Review checklist** (every migration change): ☐ idempotent re-run is a no-op ☐ partial-migration
    re-entry converges ☐ zero `DROP TABLE` ☐ no data loss (rows/edges survive) ☐ schema version
    bumped ☐ reshape precedes `CREATE TABLE IF NOT EXISTS` ☐ fresh/legacy/partial start points tested.
- **Vendor neutrality lives in the adapter layer (ADR-0011).** A neutral three-piece interface
  (a driver for the run lifecycle + canonical message stream, an approval bridge that
  intercepts/suspends/writes back a decision, and a session store that hides history behind one
  face) plus a capability ledger lets c3 drive Claude, Codex, and future vendors through the same
  surface; optional capabilities (interrupt, mode switch, streaming input, in-process MCP, session
  fork, per-tool approval, task store) are probed before use. **Amendment (2026-06-07):** the
  session-lifecycle operations (list / read / resume / rename / delete) are graded honestly as a
  structured per-operation sub-ledger — each operation one of _none_ / _partial_ / _full_ /
  _temporarily-unavailable_ — because a boolean could not tell a structural NO (no route at all)
  apart from a transient outage. The wire carries the per-vendor matrix, and the console renders
  session-row actions by capability _state_, never by switching on the vendor's identity.
  Permission is a neutral tool-name + input + context → allow / ask / deny policy over an
  orthogonal action-mode (plan, build) × tool-gate (always-ask / on-sensitive / trusted-prefix /
  never-ask) grid (Claude's five-way permission mode no longer maps one-to-one). **No vendor SDK
  type crosses the adapter boundary** — SDK values enter an adapter untyped and are narrowed there
  (ADR-0009). Today the Claude reference adapter delegates to the existing run path, gateway, and
  session IO; the run-loop rewrite that makes the driver the only path is a later phase.
- **Host-binary probing is the first capability gate (ADR-0012).** Every agent vendor runs as a
  host-CLI subprocess that can NOT be packed into c3's single binary — the binary ships c3 only, so
  each agent type needs its vendor CLI installed on the host PATH. The host-CLI launcher resolves a
  vendor to its absolute binary path or to none; an adapter for a vendor is constructed **only**
  when its binary resolves, so an absent CLI means the agent type is unavailable (a product
  convention, not a bug) with install guidance, and its capability ledger never comes into play. A
  boot-time health report names present/missing binaries loudly but non-fatally.
- **Product entitlement is server-authoritative, enforced client-side (ADR-0026).** Commercial
  licensing lives in a **separate product, the license-server (LS)** — outside the c3 process, so c3
  keeps its no-database / single-runtime / localhost posture. c3 is a **client**: it activates once
  (one-time, short-lived code), heartbeats periodically (bearer token), and verifies an LS-signed
  **Ed25519** entitlement token **offline** against an embedded public key (the SEC-8 signing anchor
  reused). Entitlement is consulted at exactly one point — **new-session creation** — and gates it
  when not entitled; existing sessions and in-flight runs are never interrupted (ADR-0006). A
  **30-minute offline grace** from the last successful heartbeat bridges transient outages. This is
  **not** authentication (the auth domain controls access, not entitlement). The one accepted c3-side
  concession is a small on-disk **entitlement cache**. See the
  [product-license domain](../domains/commerce/product-license/product-license-overview.md), the
  [license-server API contract](../shared/api-conventions/license-server-api.md), and the
  [license-server architecture](license-server-architecture.md) (LS 自身的服务架构).
- **Build order:** `web` then `server` — the server embeds the web bundle.
- **Web module structure.** The frontend is organized in three tiers:
  - Shared (cross-page) components, each with a colocated unit test. The mobile drill-down shell
    is the shared mobile-only container for list/detail and three-column pages: desktop renders each
    pane slot in order, while mobile shows a single pane stack with an explicit back event; page
    containers keep owning their selection/data state.
  - Page-private components, each with a colocated test.
  - Page containers — one per page (works / intents / discussions / schedules / systemsettings).
  - The shell owns the WS client, the inbound-message handler, and all shared/tab state, and
    dispatches to page containers by active tab. Page containers are **pure** (props in / emit up) —
    no domain state of their own (the queue-edit prefill is forwarded back to the composer). Pure
    logic, unit-tested view helpers, and composables sit alongside and are imported by both tiers.
  - The works and intents pages share the chat column by each assembling it from the same shared
    chat components, not via a wrapper component.
  - Page containers are route-level views and may carry single-word names; their private components
    keep the multi-word naming rule.
  - Component-mounting tests run in a browser-like DOM; other tests run in node.

## Key decisions

| ADR                                                           | Decision                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](adr/deprecated/0001-c3-sole-permission-authority.md)   | _(superseded by 0005)_ c3 is the sole permission authority                                                                                                                                                |
| [0002](adr/0002-websocket-as-permission-transport.md)         | WebSocket is the permission transport                                                                                                                                                                     |
| [0003](adr/0003-single-binary-via-bun-compile.md)             | Ship as a single binary via `bun build --compile`                                                                                                                                                         |
| [0004](adr/0004-persist-workspace-session-registry.md)        | Persist a c3-owned workspace & session registry                                                                                                                                                           |
| [0005](adr/0005-inherit-user-project-settings.md)             | Inherit user & project settings; c3 is the permission gateway (`settingSources: ['user', 'project']`)                                                                                                     |
| [0006](adr/0006-decouple-runs-from-connections.md)            | Decouple agent runs from WebSocket connections; runs live in a module-level registry                                                                                                                      |
| [0007](adr/0007-read-only-intent-agent.md)                    | Read-only intent-communication agent; `save_intents` via the permission gateway; cross-runtime SQLite ledger                                                                                              |
| [0009](adr/0009-unidirectional-boundaries.md)                 | Unidirectional boundaries: kernel → transport/features; SDK types never leave the kernel                                                                                                                  |
| [0011](adr/0011-vendor-neutral-agent-abstraction.md)          | Vendor-neutral Agent abstraction: required three-piece interface + probed capability ledger; the five-way permission mode dropped for an action-mode × tool-gate grid                                     |
| [0012](adr/0012-host-binary-probe-first-capability-gate.md)   | Host-binary probing is the first capability gate; an absent vendor CLI ⇒ agent type unavailable (install per agent type, single binary is not self-contained)                                             |
| [0018](adr/0018-event-bus-kernel-layer.md)                    | In-process typed event bus in the kernel layer (publish/subscribe, error isolation, sync dispatch, ADR-0009 boundary-safe)                                                                                |
| [0026](adr/0026-product-licensing-separate-license-server.md) | Product licensing lives in a separate **license-server** (server-authoritative entitlement); c3 verifies an Ed25519-signed token offline and gates only new-session creation, with a 30-min offline grace |
