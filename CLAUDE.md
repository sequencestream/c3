# CLAUDE.md

## What this is

`c3` (Claude Code Center) is a local web UI for Claude Code: tool-use permission prompts are answered in a browser instead of the terminal.

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--project /abs/path] [--port 3000] # start is default cmd; --project defaults to cwd, --port to 3000
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . (add --fix via pnpm lint:fix)
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

## Index

- server: Hono server
- web: Vue 3 frontend
- shared: protocol definitions, common code
- scripts/e2e/e2e-guide.md: E2E tests
- specs/: specs is the source of truth, keep synchronized with code, without ask.
- specs/overview.md: overview of the system
- specs/constitution.md: constitution of the system
- specs/glossary.md: glossary of the system
- specs/architecture/architecture.md: architecture spec
- specs/adr/adr.md: architecture decision records
- specs/domains/: domain specs
- specs/non-functional/: non-functional specs
