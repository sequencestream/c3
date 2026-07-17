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

- Code comments should not contain document references or number references, like: `SR-R14`, `ADR-0002` etc.

## Commands

```bash
pnpm allcheck                                   # format → lint:fix → typecheck → i18n:check (&& chain, stops on failure)
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . , exec `pnpm lint:fix` to fix lint errors
pnpm i18n:check                                  # check i18n keys in code
pnpm format                                      # prettier --write . (--check via format:check)
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm start [--port 3000] # start is default cmd; workspaces added from Web UI
```

do `pnpm allcheck` or format/lint/typecheck/i18n:check individually at the end of an edit session.

## Dir&File Index

- server: Hono server
- web: Vue 3 frontend
- web/PAGES.md: frontend page and component tree index, keep synchronized with code when change web structure
- shared: protocol definitions, common code
- shared/src/protocol.ts: WebSocket protocol definition source, include all ClientToServer/ServerToClient message types, data models, vendor-neutral abstract classes
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- doc/: doc is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics. Write Chinese doc.
- doc/AGENTS.md: document constitution
- doc/overview.md: overview of the system
- doc/features.md: c3 feature tree index, keep synchronized with code
- doc/constitution.md: constitution of the system
- doc/glossary.md: glossary of the system
- doc/architecture/architecture.md: architecture spec
- doc/adr/adr.md: architecture decision records
- doc/domains/: domain doc
- doc/flows/flows.md: flow doc
- doc/non-functional/: non-functional doc
- database/tables.md: database table schema index，DDL in database/<module>/<table>.sql ,schema change need to be synchronized, change record in database/migrate/<YYYY>/<MM>/<DD>/<NNN>-<table>.sql
- doc/style/typescript-code-style.md: TypeScript code style
- doc/style/color-style-spec.md: color style spec
