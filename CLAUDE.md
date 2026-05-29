# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`c3` (Claude Code Center) is a local web UI for Claude Code: tool-use permission
prompts are answered in a browser instead of the terminal. A Hono server runs the
`@anthropic-ai/claude-agent-sdk` `query()` loop and routes every permission decision
over a WebSocket to a Vue 3 frontend. The frontend has a sidebar of **workspaces**
(project dirs) and their **sessions**; a run targets the active session (`cwd` + `resume`).

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--project /abs/path] [--port 3000] # --project is an optional seed workspace
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . (add --fix via pnpm lint:fix)
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

Per-package: `pnpm -F @ccc/server|@ccc/web <script>`.

**E2E test** : scripts/e2e/e2e-guide.md

## Architecture

Workspaces: `server`, `web`, `shared`.

- **`shared/src/protocol.ts`** — single source of truth: `ClientToServer`/`ServerToClient`
  discriminated unions (WS wire format), imported by both ends. Change shapes here first.
  Resolves to raw `.ts` (no build) via `exports` + bundler aliases.
- **`server/src/`**: `cli.ts` (commander entry); `server.ts` (Hono `/ws` upgrade, serves
  embedded frontend in prod, per-connection active session + event dispatch, aborts in-flight
  run on each `user_prompt`/session switch); `claude.ts` wraps `query()` (cwd/resume) —
  `canUseTool` sends a `permission_request`, awaits a Promise in
  `pendingApprovals: Map<requestId, resolver>` (**60s timeout auto-denies**); `state.ts`
  (persisted workspace/session registry at `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`);
  `sessions.ts` (SDK `listSessions`/`getSessionMessages`/`rename`/`delete` + transcript map).
- **`web/src/`** — Vue 3: `lib/ws.ts` (WS client), `App.vue` (sidebar + chat + permission
  dialog). Vite proxies `/ws` → `:3000`.

## Invariants & conventions

- **`settingSources: []`** — SDK ignores `~/.claude/settings.json`; c3 is sole permission
  authority. Don't remove. Permission mode is **per session** (persisted in `state.ts`),
  starts `default` — `canUseTool` fires only for sensitive ops (Write/Edit/dangerous Bash);
  read-only auto-allowed.
- **Persistence boundary** — only the workspace/session registry is persisted (ADR 0004);
  **never** persist permission decisions. Sessions themselves live in the SDK transcript store.
- Server uses **`.js` import specifiers** for local `.ts` files (`./claude.js`). Keep.
- `strict: true` everywhere. Model wire/state as discriminated unions, narrow on `type`
  (no `as`). `unknown` at boundaries, never spreading `any`. One source of truth for types
  (`@ccc/shared`). Annotate exported signatures; validate WS input at the edge.
