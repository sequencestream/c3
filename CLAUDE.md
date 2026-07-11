## What

c3 - code creative center - An **AI workbench** that centrally manages and drives the work of multiple AI coding agents.

## Tech Stack

- Monorepo: pnpm workspaces
- Language: TypeScript (strict)
- Server: Hono (HTTP+WebSocket) on Node.js/Bun
- Web: Vue 3 + Vite 6 + vue-i18n
- Validation: Zod
- Build: esbuild (server), bun build --compile (binary)
- Test: Vitest

## Rules

- 代码注释不要包含文档引用或序号引用，比如 `SR-R14`, `ADR-0002` 等;

## Commands

```bash
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . , exec `pnpm lint:fix` to fix lint errors
pnpm format                                      # prettier --write . (--check via format:check)
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm start [--workspace /abs/path] [--port 3000] # start is default cmd; --workspace defaults to cwd (--project deprecated alias), --port to 3000
```

do format/lint/typecheck at the end of an edit session.

## Dir&File Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: 前端页面与组件的树状索引(每个页面/组件/composable/lib 一行功能说明),改动 web 结构时同步更新
- shared: protocol definitions, common code
- shared/src/protocol.ts: WebSocket 协议唯一定义源，包含所有 ClientToServer/ServerToClient 消息类型、数据模型、vendor 中立抽象，两端 import 同一个文件保证编译期类型一致
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- doc/: doc is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics. Write Chinese doc.
- doc/overview.md: overview of the system
- doc/features.md: c3 特性功能树状清单(每行一句话说明),有新特性或特性变更时保持同步
- doc/constitution.md: constitution of the system
- doc/glossary.md: glossary of the system
- doc/architecture/architecture.md: architecture spec
- doc/adr/adr.md: architecture decision records
- doc/domains/: domain doc
- doc/flows/flows.md: flow doc
- doc/non-functional/: non-functional doc
- database/tables.md: 数据库表结构索引，DDL 在 database/<module>/<table>.sql ,表结构变更需同步更新，变更记录 database/migrate/<YYYY>/<MM>/<DD>/<NNN>-<table>.sql
- doc/style/typescript-code-style.md: TypeScript code style
- doc/style/color-style-spec.md: color style spec
