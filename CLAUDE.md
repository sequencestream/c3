## What this is

## Tech Stack

- **Monorepo**: pnpm workspaces | **Language**: TypeScript (strict) | **Server**: Hono (HTTP+WebSocket) on Node.js/Bun | **Web**: Vue 3 + Vite 6 + vue-i18n | **Validation**: Zod | **Build**: esbuild (server), bun build --compile (binary) | **Test**: Vitest

## Architecture (key decisions)

- Constitution (doc/constitution.md) overrides all code — core stack choices are locked, security rulesare non-negotiable; any deviation requires an ADR
- **Single process, WebSocket transport**: browser ↔ server via one WebSocket at /ws (ADR-0002); no database or persistent store allowed; runs are stateful and survive socket close (decoupled via process-wide Map, ADR-0006)
- **Unidirectional boundaries**: kernel/ (pure domain) → transport/ (plumbing) → features/ (user actions); kernel must not import transport or features (ADR-0009); typed event bus for cross-layer messaging (ADR-0018)
- **Canonical envelope on wire**: vendor-spanning CanonicalMessage as wire protocol; id-based block upsert (not append-only); opaque c3SessionId never leaks vendor-native IDs (ADR-0013)

## Rules

- 代码注释不要包含文档引用或序号引用，比如 `SR-R14`, `ADR-0002` 等;

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--workspace /abs/path] [--port 3000] # start is default cmd; --workspace defaults to cwd (--project deprecated alias), --port to 3000
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . , exec `pnpm lint:fix` to fix lint errors
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

do format/lint/typecheck at the end of an edit session.

## Runtime data (`~/.c3`)

All runtime state is anchored under the c3 home dir (default `~/.c3`, overridable via `--settings` / `C3_DIR`):

- `settings.json` / `state.json` — config + workspace registry
- `c3.db` — single SQLite (intents, discussions, …)
- `worktrees/` — intent worktrees (HOME-anchored so Docker can bind-mount)
- `doc/` — centralized doc per project dir
- `log/` — runtime logs: live file `c3.log` (console output teed to disk); rotated daily into `c3-YYYY-MM-DD.log`; archives older than 30 days are pruned. Best-effort — log failures never crash the process. No size rotation, no retention config, no remote shipping (主进程自身输出, 不含子进程/沙箱/vendor CLI)。

## Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: 前端页面与组件的树状索引(每个页面/组件/composable/lib 一行功能说明),改动 web 结构时同步更新
- shared: protocol definitions, common code
- shared/src/protocol.ts: WebSocket 协议唯一定义源，包含所有 ClientToServer/ServerToClient 消息类型、数据模型、vendor 中立抽象，两端 import 同一个文件保证编译期类型一致
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- doc/: doc is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics. Write Chinese doc.
- doc/overview.md: overview of the system
- doc/constitution.md: constitution of the system
- doc/glossary.md: glossary of the system
- doc/architecture/architecture.md: architecture spec
- doc/adr/adr.md: architecture decision records
- doc/domains/: domain doc
- doc/flows/flows.md: flow doc
- doc/non-functional/: non-functional doc
- database/tables.md: 数据库表结构索引，DDL 在 database/<module>/<table>.sql ,表结构变更需同步更新，变更记录 database/migrate/<YYYY>/<MM>/<DD>/<NNN>-<table>.sql
- license-server/: 独立 Go 服务（许可证授权方，ADR-0026），与 c3 进程分离，自带 go.mod 不属于 pnpm workspace；std-lib net/http、PostgreSQL（迁移在 license-server/database/，独立于 c3 的 database/）、内嵌 Vue 前端、单二进制；见 license-server/README.md

## TypeScript Code Style

- **No `enum`**: use `as const` arrays + derived string unions; `enum` bloats emit and breaks tree-shaking
- **No `any`**: use `unknown` + type guards; `any` silences the compiler, `unknown` forces narrowing
- **`import type` for type-only imports**: keeps imports erased at runtime, prevents circular refs
- **Explicit return types on all exported functions**: the public API is a contract; inference hides breaks
- **`interface` for object shapes, `type` for everything else**: `interface` = named record; `type` = unions, intersections, mapped/conditional types, type aliases
