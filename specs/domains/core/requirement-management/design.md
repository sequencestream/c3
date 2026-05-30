# requirement-management — Design

Implements the [spec](spec.md). Lives in `server/src/requirements/` (SQLite layer, store,
communication prompt, save tool), with hooks into `server/src/claude.ts` (run variant),
`server/src/runs.ts` (runtime `kind` + shared launcher), `server/src/server.ts` (new WS
branches), and `server/src/sessions.ts` (hidden-set filtering). The frontend adds a requirement
view to `web/src/`.

**Reuse baseline.** Almost everything rides on existing machinery: the runtime registry +
`emit`/viewers + background runs (`runs.ts`); the chat stream and `user_prompt`; the permission
gateway for the save confirmation; `select_session` for the dev back-link. The genuinely new
parts are only three: the **SQLite layer**, the **read-only communication run variant +
`save_requirements` tool**, and the **requirement frontend**.

## Module split

| Concern                      | File                                   | Notes                                                                        |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| SQLite driver adapter        | `server/src/requirements/db.ts`        | Cross-runtime: `node:sqlite` vs `bun:sqlite`; minimal synchronous API        |
| Ledger operations            | `server/src/requirements/store.ts`     | Requirement CRUD, dependency aggregation, communication-session map          |
| Communication system prompt  | `server/src/requirements/prompt.ts`    | Read-only analyst prompt, injected as `appendSystemPrompt`                   |
| `save_requirements` MCP tool | `server/src/requirements/save-tool.ts` | `createSdkMcpServer` exposing the confirmed-save tool                        |
| Run variant                  | `server/src/claude.ts`                 | `runClaude` gains `appendSystemPrompt`/`disallowedTools`/`mcpServers`/`gate` |
| Runtime kind + launcher      | `server/src/runs.ts`                   | `SessionRuntime.kind: 'normal' \| 'requirement'`; shared `launchRun`         |
| WS branches + orchestration  | `server/src/server.ts`                 | Five new branches; communication-session viewer management                   |
| Hidden-set list filter       | `server/src/sessions.ts`               | `listWorkspaceSessions` excludes the project's hidden set                    |

## SQLite layer (`db.ts`)

- **Location:** `~/.c3/c3.db` — aligned with `settings.ts`'s `~/.c3/`, **not** the registry's
  `~/.claude/c3/`.
- **Cross-runtime driver (ADR 0007).** `db.ts` exposes a minimal **synchronous** interface
  (`exec`/`run`/`all`/`get`) and picks the driver by `globalThis.Bun`: Bun binary → `bun:sqlite`
  `Database`, Node → `node:sqlite` `DatabaseSync`. The two never cross. Both are synchronous, so a
  single sync adapter matches c3's existing synchronous persistence style.
- **Adapter constraints (the two APIs differ for real):** use only `?` positional placeholders
  (named params bind differently); read rows by field only (node returns null-prototype objects,
  bun plain objects). node uses `prepare(sql).all/get/run(...)` and `exec` for multi-statement;
  bun uses `query(sql).all(...)`, `run(sql, ...)`, `exec(sql)`.
- **Build (mandatory):** `server/build.mjs`'s esbuild `external` must include `'node:sqlite'`
  and `'bun:sqlite'`. A dynamic `import()` is **not** enough — esbuild still fails to resolve
  `bun:sqlite` without `external`.
- **PRAGMA on create:** `journal_mode=WAL` + `busy_timeout=3000`, cheaply reducing lock conflicts
  when multiple c3 processes point at one db (cross-process is not a v1 goal but the setting is
  free).
- **Fail-soft (per entry point):** on open/create failure, set a module-level `dbAvailable=false`,
  disabling requirement features without affecting c3 boot (RM-R12) — consistent with the
  "boot even with broken config" rule.

## Schema (`PRAGMA user_version` migrations)

- `requirements` — the ledger (`id`, `project_path`, `title`, `content`, `priority`, `status`,
  `module`, `last_dev_session_id`, `created_at`, `updated_at`), indexed by `(project_path,
status)`. `module` is `TEXT NOT NULL DEFAULT ''`.
- `requirement_deps` — `(requirement_id, depends_on_id)` edges.
- `requirement_chats` — one table doubling as the **per-project current communication session**
  map and the **hidden set**: `session_id` (PK, may be a `pending:` id), `project_path`,
  `is_current` (0/1, at most one per project), `updated_at`. The full set of rows for a project is
  the hidden set; the `is_current=1` row is the current communication session.

**Schema version & migration (v1 → v2).** `SCHEMA_VERSION` is `2`. The fresh-create `SCHEMA`
already declares `requirements.module`. For pre-existing dbs (v1, no `module` column), `db()`
runs an **idempotent column migration** after `exec(SCHEMA)` and before writing `user_version`:
`ensureColumn(d, 'requirements', 'module', "TEXT NOT NULL DEFAULT ''")` checks
`PRAGMA table_info(requirements)` and only runs `ALTER TABLE requirements ADD COLUMN module
TEXT NOT NULL DEFAULT ''` if the column is absent. This keys off the actual column presence (not
the exact `user_version` history), so it is safe on new and old dbs and idempotent across runs;
`ALTER TABLE … ADD COLUMN` is a lightweight metadata-only op and historical rows take the `''`
default (no backfill). Both `node:sqlite` and `bun:sqlite` support `PRAGMA table_info` /
`ALTER TABLE ADD COLUMN` through the shared `exec`/`all` adapter (RM-R14).

## Store (`store.ts`)

- **Path normalization (RM-R10):** every `projectPath` arg is `resolve()`d before read/write,
  matching the workspace key / runtime `workspacePath` / SDK `cwd`. Otherwise queries miss and
  hidden filtering breaks.
- Requirements: `listRequirements(projectPath, status?)` (with `dependsOn` aggregation),
  `insertRequirements(projectPath, items)` (transactional batch, uuid, status `todo`; persists
  `module` as `it.module ?? ''`), `updateStatus`, `setLastDevSession`, `updateRequirement`,
  `getRequirement`. The internal `Row`/`hydrate` carry `module` so every read path returns it;
  `updateRequirement` does not yet patch `module` (out of scope, no schema blocker).
- Communication session (single table): `getChatSession(projectPath)`
  (`is_current=1`), `setChatSession` (clear the project's `is_current` then upsert the new row as
  `is_current=1`, also entering the hidden set), `isHiddenSession`/`listHiddenSessions`,
  `rebindChatSession(pendingId, realId)` (rewrite the pending row to the real id on first bind,
  keeping `is_current` and hidden-set membership).

## Run variant (`claude.ts` + `runs.ts`)

- `SessionRuntime` gains `kind: 'normal' | 'requirement'` (default `'normal'`); `user_prompt`
  dispatches on `rt.kind` to the standard or requirement variant of `runClaude`.
- A shared launcher `launchRun(rt, prompt, opts?)` is extracted from `user_prompt`. **Boundary:**
  it only touches module-level `emit`/`broadcastStatuses`/the registry; connection-specific
  `send(ws, …)`/`sendSessions(ws, …)` stay with the caller as optional callbacks — so
  `start_development` (no-ws background run) and `refine_requirement` (seeded first prompt) reuse
  the same launcher.
- `runClaude` gains optional `appendSystemPrompt`, `disallowedTools`, `mcpServers`, and
  `gate: 'standard' | 'requirement'` without breaking existing callers. The communication agent's
  `mcpServers` is constructed **server-side** in the `user_prompt` branch (closing over the
  resolved `rt.workspacePath`), keeping `claude.ts` free of `store`.

## Read-only communication session (ADR 0007)

- **Forced `default` mode (RM-R3).** The communication runtime is started with
  `permissionMode: 'default'` and does **not** inherit the system default mode; `set_mode` is
  ignored for `kind==='requirement'` and the view renders no mode selector. Under
  `bypassPermissions` the SDK skips `canUseTool`, which would silently save — forbidden.
- **Double-locked read-only (RM-R2).** `disallowedTools` =
  `['Write','Edit','MultiEdit','NotebookEdit','Bash','BashOutput','KillShell','Task','SlashCommand']`.
  `Task` and `SlashCommand` are essential: a spawned sub-agent's tool calls bypass the parent
  `canUseTool`, and slash commands could trigger writing skills. On top of that the
  `gate==='requirement'` `canUseTool` **denies by default**: read-class tools (Read/Grep/Glob/
  WebFetch/WebSearch) auto-allow; `mcp__c3__save_requirements` raises a `permission_request`;
  `AskUserQuestion` is a clarifying-only tool (no write/exec side effects) so it is **allowed but
  routed via user-answer injection** — `send` a `permission_request`, await the user decision, on
  allow return `withAnswers(input, answers)` (the SDK only echoes answers when `input.answers` is
  pre-filled), on cancel deny. It runs **without consensus** (single agent, no voting party). The
  `askQuestions(input)` guard filters empty/invalid questions, which fall through to the default
  deny. Everything else is denied (belt-and-braces even if the SDK adds a new write tool). The
  SDK-level `disallowedTools` hard-disabled list is unchanged.
- **Independent viewer orchestration.** `open_requirement_chat` / `refine_requirement` manage the
  viewer switch themselves (`removeViewer(old)` → `viewing=chatId` → `addViewer`) and do **not**
  reuse `select_session`'s internals (which unconditionally set the active session). The
  communication session's `onSessionId` binds the real id (`bindPending` +
  `store.rebindChatSession`) but **never** writes `activeSessionId` — hidden sessions must not
  pollute the persisted active-session hint.
- **Open/resume (`open_requirement_chat`):** db unavailable → `error`; an existing
  `getChatSession` → resume it (cold-load history into a `requirement`-kind, `default`-mode
  runtime); none → create a `pending:` requirement runtime and `setChatSession` it. Then switch
  the viewer, reply `session_selected` (history), and reply a `requirements` list. This same
  branch is what re-loads the project's current communication session on first entry, WS
  reconnect, and full-page refresh (RM-R4).
- **Refine (`refine_requirement`):** switch away from the old communication view, start a new
  `pending:` requirement runtime (`default` mode), `setChatSession` to it, reply `session_selected`
  (empty), then `launchRun` injects a first `user_prompt` ("开始完善需求 …, 定稿后调用
  save_requirements") equivalent to a user message (RM-R7).

## Communication system prompt (`prompt.ts`)

Injected as `appendSystemPrompt` on the `claude_code` preset. In brief: you are a requirement
analyst; read project material only, never edit/write/run change commands/spawn sub-agents/run
slash commands; converse with the user and break requests into discrete, verifiable,
right-sized items (each with title/content/priority P0–P3/optional dependencies/**inferred
module name**); confirm a list with the user first; on approval call `save_requirements` (the
system pops the confirmation, the real write follows the user's allow); never pretend a save
happened. The prompt asks the agent to infer each item's **module name** from its title/content
(e.g. 认证、会话、需求管理), leaving it blank when unsure, and to pass `module` per item to
`save_requirements`. This is scheme **a** (infer from title/content); a future extension may key
off the project's actual module structure for more precise classification (RM-R14).

## `save_requirements` tool (`save-tool.ts`)

`createSdkMcpServer({ name: 'c3', tools: [ saveRequirementsTool(projectPath) ] })`. The `tool()`
call uses four positional args (name, required description, a **raw zod shape** — not
`z.object(...)` — and an async handler returning a `CallToolResult`). Each requirement element
includes an optional `module: z.string().optional()` (described as the inferred module name, may
be left blank); the handler passes it straight through to `insertRequirements` (RM-R14). The handler runs **only
after** the human confirmation (the gateway already allowed); it writes via
`store.insertRequirements` and broadcasts a `requirements` refresh, returning a text result (or
`isError` text on db-unavailable / failure so the agent learns it did not save). `projectPath` is
closed over from the runtime's resolved `workspacePath` and re-bound each run, so the tool never
crosses projects.

## Launch development (`start_development`)

1. Validate the requirement exists and is `todo`, or `in_progress` with a dangling (deleted)
   `lastDevSessionId` (allowing relaunch; other states → `error`) (RM-R8).
2. Unmet-dependency check: any `dependsOn` not `done` → still allowed, but the response carries a
   warning (the frontend also second-confirms before sending) (RM-R11).
3. Start a **background normal runtime** (`pending:`) via `launchRun` with
   prompt `/sdd-lite <title + content + dependency summary>`; on `onSessionId`,
   `setLastDevSession` + `updateStatus(in_progress)` + broadcast `requirements` + `broadcastStatuses`.
4. The run is backgrounded and survives disconnect; the development session is a **normal**
   session that appears in the sidebar; `lastDevSessionId` powers the back-link.

## List & back-link

- `list_requirements` / `update_requirement_status` read/write the store and reply `requirements`.
- Dev back-link: the frontend sends `select_session` with `lastDevSessionId`; if the session no
  longer exists, the existing `error` path returns and the frontend offers a friendly
  restart/cancel exit (RM-R13).

## Hidden-set filtering (`sessions.ts`)

`listWorkspaceSessions(dir)` filters out `store.listHiddenSessions(resolve(dir))` so communication
sessions never enter the normal list (RM-R4) — using the resolved path so the key matches the
stored `project_path`. If the store is unavailable it does **not** filter (degrade, don't break
the list) (RM-R12).

## Frontend (`web/`)

- **Entry button:** `SessionSidebar.vue` adds an idea (💡) button left of "＋ new session"
  emitting `open-requirements` with the workspace path.
- **View switch:** `App.vue` gains `viewMode: 'console' | 'requirements'` + `requirementsProject`.
  Opening sends `open_requirement_chat` (its response carries the list); selecting any normal
  session resets to `console`. The requirement view renders no mode selector (RM-R3).
- **Reconnect / refresh recovery:** each project's current communication session is persisted in
  `requirement_chats.is_current`, so entering the requirement view auto-reloads it. On WS reopen,
  if `viewMode==='requirements'`, re-send `open_requirement_chat`; `viewMode`/`requirementsProject`
  are also mirrored to `localStorage` to survive a hard refresh. No new server message is needed —
  the existing resume branch suffices.
- **Layout:** left `RequirementList.vue` (status filter; per-row title/priority badge/status/
  dependency hint; per-status actions: Refine + Launch-development for `todo`, Development-details
  for launched, mark done/cancel for any); right **reuses** `ChatMessages` + `SessionStatusBar` +
  `MessageInput` against the already-viewed communication session.
- **Save confirmation:** `PermissionPrompt.vue` adds a branch for
  `toolName==='mcp__c3__save_requirements'` rendering each proposed item as a card
  (title/priority/dependency) with Save/Cancel mapped to allow/deny.
- **Requirement data:** `App.vue` holds `requirements: Record<projectPath, Requirement[]>`,
  refreshed by the `requirements` message.

## Dependencies

- **SQLite** — `node:sqlite` (Node) / `bun:sqlite` (Bun single binary); both `external` in
  esbuild.
- **agent-session** — the `requirement`-kind runtime and the shared `launchRun`.
- **permission-gateway** — gates `save_requirements` via the existing `canUseTool` flow.
- **session-registry** — its list filter consumes this domain's hidden set.
- **`@anthropic-ai/claude-agent-sdk`** — `appendSystemPrompt` preset, `disallowedTools`,
  `createSdkMcpServer` / `tool`.
