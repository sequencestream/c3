# CLAUDE.md

## What this is

`c3` (Code Creative Center) is a local web UI for code agents, like claude, codex, opencode, ...

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--project /abs/path] [--port 3000] # start is default cmd; --project defaults to cwd, --port to 3000
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . (add --fix via pnpm lint:fix), exec before commit
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

## Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: 前端页面与组件的树状索引(每个页面/组件/composable/lib 一行功能说明),改动 web 结构时同步更新
- shared: protocol definitions, common code
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- specs/: specs is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics.
- specs/overview.md: overview of the system
- specs/constitution.md: constitution of the system
- specs/glossary.md: glossary of the system
- specs/architecture/architecture.md: architecture spec
- specs/adr/adr.md: architecture decision records
- specs/domains/: domain specs
- specs/non-functional/: non-functional specs
