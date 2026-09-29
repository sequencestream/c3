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

## Commands

```bash
pnpm allcheck                                   # format → lint:fix → typecheck → i18n:check (&& chain, stops on failure)
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . , exec `pnpm lint:fix` to fix lint errors
pnpm i18n:check                                  # check i18n keys in code
pnpm format                                      # prettier --write . (--check via format:check)
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm start [--port 3000] [--db ~/.c3/c3.db] # start is default cmd; --db relocates the whole instance
```

## Rules

- `doc/` 只写比代码高一层的内容(意图、边界、不变量、协作方式、关键取舍),不写细节代码设计;要探索细节,读代码。禁止出现源文件名。代码与注释不引用 `doc/`、规则编号或 ADR 编号。行为变更时文档与代码同时更新,用对照验证一致性。过程性记录(SDK 升级等)放 GitHub Issue,`doc/` 只留链接。细则见 `doc/AGENTS.md` 与 `doc/constitution.md`。
- No `Co-Authored-By` in commit messages.
- At the end of an edit session
  - Run `pnpm allcheck`.
  - Run unit tests in edited modules.

## Dir&File Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: frontend page and component tree index, keep synchronized with code when change web structure
- shared: protocol definitions, common code
- shared/src/model-vendor-catalog.ts: 模型厂商目录与各家内置模型清单(纯数据,发布维护时对照官方文档核验);端点模板与合并规则在 shared/src/model-provider-catalog.ts
- shared/src/protocol.ts: WebSocket protocol entry — a barrel that re-exports `shared/src/protocol/` and is the ONLY place the `ClientToServer` / `ServerToClient` unions are assembled. Keep it a barrel: add a message by defining its payload in the owning domain module, then listing one arm here.
- shared/src/protocol/: wire contract partitioned by domain (vendor, session, code, workspace, settings, auth, agent-config, consensus, skill, intent, discussion, automation). `<domain>.ts` holds the public data models (re-exported by the barrel); `<domain>-messages.ts` holds that domain's message payload types (internal to the partition — never re-exported, or the public surface would widen). Import path stays `@ccc/shared/protocol` / `@ccc/shared`; no subpath export exists.
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed. E2E always run against an isolated database (`node scripts/e2e/isolated-server.mjs` — a single `--db <temp>` carries configuration too) and never write the real `~/.c3/c3.db`; see the constraint at the top of the guide.
- doc/: 上层意图与约束的权威来源,与代码同步更新但互不引用文件;细节从代码探索。过程账本不进 doc/,见 GitHub Issue。Write Chinese doc.
- doc/AGENTS.md: document constitution
- doc/overview.md: overview of the system
- doc/features.md: c3 feature tree index, keep synchronized with code
- doc/constitution.md: constitution of the system
- doc/glossary.md: glossary of the system
- doc/architecture/architecture.md: architecture spec
- doc/architecture/adr/adr.md: architecture decision records
- doc/domains/: domain doc
- doc/flows/flows.md: flow doc
- doc/non-functional/: non-functional doc
- database/tables.md: database table schema index，DDL in `database/<module>/<table>.sql` ,schema change need to be synchronized, change record in `database/migrate/<YYYY>/<MM>/<DD>/<NNN>-<table>.sql`
- doc/style/typescript-code-style.md: TypeScript code style
- doc/style/color-style-spec.md: color style spec
