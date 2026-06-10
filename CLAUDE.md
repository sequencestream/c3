## What this is

`c3` (Code Creative Center) is a local web UI for code agents, like claude, codex, opencode, ...

## Tech Stack

- **Monorepo**: pnpm workspaces | **Language**: TypeScript (strict) | **Server**: Hono (HTTP+WebSocket) on Node.js/Bun | **Web**: Vue 3 + Vite 6 + vue-i18n | **Validation**: Zod | **Build**: esbuild (server), bun build --compile (binary) | **Test**: Vitest

## Architecture (key decisions)

- **Spec-first, Constitution-governed**: specs/ is source of truth; Constitution (specs/constitution.md) overrides all code — core stack choices are locked, security rules (deny by default, localhost-only) are non-negotiable; any deviation requires an ADR
- **Single process, WebSocket transport**: browser ↔ server via one WebSocket at /ws (ADR-0002); no database or persistent store allowed; runs are stateful and survive socket close (decoupled via process-wide Map, ADR-0006)
- **Vendor-neutral agent abstraction**: three-piece interface (AgentDriver/ApprovalBridge/SessionStore) abstracts Claude, Codex, OpenCode behind a neutral facade; adapters live in server/src/kernel/agent/adapters/ (ADR-0011)
- **Unidirectional boundaries**: kernel/ (pure domain) → transport/ (plumbing) → features/ (user actions); kernel must not import transport or features (ADR-0009); typed event bus for cross-layer messaging (ADR-0018)
- **Canonical envelope on wire**: vendor-spanning CanonicalMessage as wire protocol; id-based block upsert (not append-only); opaque c3SessionId never leaks vendor-native IDs (ADR-0013)

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--project /abs/path] [--port 3000] # start is default cmd; --project defaults to cwd, --port to 3000
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . , exec `pnpm lint:fix` to fix lint errors
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

do format/lint/typecheck at the end of an edit session.

## Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: 前端页面与组件的树状索引(每个页面/组件/composable/lib 一行功能说明),改动 web 结构时同步更新
- shared: protocol definitions, common code
- shared/src/protocol.ts: WebSocket 协议唯一定义源，包含所有 ClientToServer/ServerToClient 消息类型、数据模型、vendor 中立抽象，两端 import 同一个文件保证编译期类型一致
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- specs/: specs is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics.
- specs/overview.md: overview of the system
- specs/constitution.md: constitution of the system
- specs/glossary.md: glossary of the system
- specs/architecture/architecture.md: architecture spec
- specs/adr/adr.md: architecture decision records
- specs/domains/: domain specs
- specs/non-functional/: non-functional specs
- database/tables.md: 数据库表结构索引，DDL 在 database/<module>/<table>.sql ,表结构变更需同步更新，变更记录 database/migrate/<YYYY>/<MM>/<DD>/<NNN>-<table>.sql

## TypeScript Code Style

- **No `enum`**: use `as const` arrays + derived string unions; `enum` bloats emit and breaks tree-shaking
- **No `any`**: use `unknown` + type guards; `any` silences the compiler, `unknown` forces narrowing
- **`import type` for type-only imports**: keeps imports erased at runtime, prevents circular refs
- **Explicit return types on all exported functions**: the public API is a contract; inference hides breaks
- **`interface` for object shapes, `type` for everything else**: `interface` = named record; `type` = unions, intersections, mapped/conditional types, type aliases
