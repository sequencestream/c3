# requirement-management — Design

Implements the [spec](spec.md). Lives in `server/src/requirements/` (SQLite layer, store,
communication prompt, save tool), with hooks into `server/src/claude.ts` (run variant),
`server/src/runs.ts` (runtime `kind` + shared launcher), `server/src/server.ts` (new WS
branches), and `server/src/sessions.ts` (hidden-set filtering). The frontend adds a requirement
view to `web/src/`.

**Reuse baseline.** Almost everything rides on existing machinery: the runtime registry +
`emit`/viewers + background runs (`runs.ts`); the chat stream and `user_prompt`; the permission
gateway for the save confirmation; `select_session` for the dev back-link. The genuinely new
parts are: the **SQLite layer**, the **read-only communication run variant + `save_requirements`
tool**, the **requirement frontend**, and the **automation orchestrator** (state machine +
completion judge + git helper) layered on the same runtime/launcher/viewer machinery.

## Module split

| Concern                      | File                                    | Notes                                                                                                                          |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SQLite driver adapter        | `server/src/requirements/db.ts`         | Cross-runtime: `node:sqlite` vs `bun:sqlite`; minimal synchronous API                                                          |
| Ledger operations            | `server/src/requirements/store.ts`      | Requirement CRUD, dependency aggregation, communication-session map                                                            |
| Communication system prompt  | `server/src/requirements/prompt.ts`     | Read-only analyst prompt, injected as `appendSystemPrompt`                                                                     |
| `save_requirements` MCP tool | `server/src/requirements/save-tool.ts`  | `createSdkMcpServer` exposing the confirmed-save tool                                                                          |
| Run variant                  | `server/src/claude.ts`                  | `runClaude` gains `appendSystemPrompt`/`disallowedTools`/`mcpServers`/`gate`; `askOneShot` (tool-less one-shot, for the judge) |
| Runtime kind + launcher      | `server/src/runs.ts`                    | `SessionRuntime.kind: 'normal' \| 'requirement'`; shared `launchRun`                                                           |
| WS branches + orchestration  | `server/src/server.ts`                  | Eight new branches; communication-session viewer management; `runDevTurn` + `broadcastAutomation`                              |
| Hidden-set list filter       | `server/src/sessions.ts`                | `listWorkspaceSessions` excludes the project's hidden set                                                                      |
| Automation orchestrator      | `server/src/requirements/automation.ts` | Per-project state machine: `pickNext`, continuation loop, judge+commit; injected `AutomationHooks`                             |
| Completion judge             | `server/src/requirements/judge.ts`      | `judgeCompletion` — builds the prompt, runs `askOneShot`, parses `done`/`in_progress`/`stuck`                                  |
| Git helper                   | `server/src/git.ts`                     | `gitDiffStat` + `gitRecentLog` + `commitAndPush` (scoped via `git -C`); never rejects, returns codes/errors                    |

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
  `module`, `last_dev_session_id`, `automate`, `created_at`, `updated_at`, `completed_at`), indexed
  by `(project_path, status)`. `module` is `TEXT NOT NULL DEFAULT ''`; `automate` is
  `INTEGER NOT NULL DEFAULT 0`.
- `requirement_deps` — `(requirement_id, depends_on_id)` edges.
- `requirement_chats` — one table doubling as the **per-project current communication session**
  map and the **hidden set**: `session_id` (PK, may be a `pending:` id), `project_path`,
  `is_current` (0/1, at most one per project), `updated_at`. The full set of rows for a project is
  the hidden set; the `is_current=1` row is the current communication session.

**Schema version (current: v4).** `SCHEMA_VERSION` is `4`. Each bump adds one idempotent
`ensureColumn` after `exec(SCHEMA)`: v2 `module`, v3 `completed_at` (nullable), v4 `automate`
(`INTEGER NOT NULL DEFAULT 0`). Same key-off-column-presence pattern as below.

**Schema version & migration (v1 → v2).** The fresh-create `SCHEMA`
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
  `module` as `it.module ?? ''`, `automate` defaults to `0`), `updateStatus`, `setLastDevSession`,
  `setAutomate(id, automate)`, `updateRequirement`, `getRequirement`. The internal `Row`/`hydrate`
  carry `module` + `automate` (mapped to boolean) so every read path returns them;
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
  `gate==='requirement'` `canUseTool` **denies by default**: read-class tools (`REQUIREMENT_READ_TOOLS`
  = Read/Grep/Glob/LS/NotebookRead/WebFetch/WebSearch/TodoWrite) auto-allow;
  `mcp__c3__save_requirements` raises a `permission_request`; `AskUserQuestion` is an **interactive
  (clarifying-only) tool, not a write tool** — it has no file/exec side effects, so the read-only
  agent may use it. It is therefore **kept out of `disallowedTools`** and **allowed but routed via
  user-answer injection** — `send` a `permission_request`, await the user decision, on allow return
  `withAnswers(input, answers)` (the SDK only echoes answers when `input.answers` is pre-filled),
  on cancel deny. It runs **without consensus** (single agent, no voting party). The
  `askQuestions(input)` guard filters empty/invalid questions, which fall through to the default
  deny. Everything else is denied (belt-and-braces even if the SDK adds a new write tool). The
  SDK-level `disallowedTools` hard-disabled list
  (Write/Edit/MultiEdit/NotebookEdit/Bash/BashOutput/KillShell/Task/SlashCommand) is unchanged and
  **does not include `AskUserQuestion`**.
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

Injected as `appendSystemPrompt` on the `claude_code` preset. **The prompt text is in English**
(the agent still converses with the user in Chinese). In brief: you are a requirement analyst; read
project material only, never edit/write/run change commands/spawn sub-agents/run slash commands;
converse with the user and break requests into discrete, verifiable, right-sized items (each with
title/content/priority P0–P3/optional dependencies/**inferred module name**); confirm a list with
the user first; on approval call `save_requirements` (the system pops the confirmation, the real
write follows the user's allow); never pretend a save happened. The prompt asks the agent to infer
each item's **module name** from its title/content (e.g. auth、session、requirement-management),
leaving it blank when unsure, and to pass `module` per item to `save_requirements`. This is scheme
**a** (infer from title/content); a future extension may key off the project's actual module
structure for more precise classification (RM-R14).

The prompt also carries a **decomposition rule (a single goal is never split)**: when one goal
touches **code, its tests, and/or its companion docs** (spec / README / comments), the analyst
folds the test- and doc-sync work into the **same** requirement's content + acceptance points
rather than emitting a separate「更新测试」/「文档更新」item — code, its tests, and its docs are one
change, kept on one ticket so no half is scheduled apart or dropped, which would drift tests/docs
out of sync with code (RM-R15).

## `save_requirements` tool (`save-tool.ts`)

`createSdkMcpServer({ name: 'c3', alwaysLoad: true, tools: [ saveRequirementsTool(projectPath) ] })`.
`alwaysLoad: true` stamps `_meta['anthropic/alwaysLoad']` on each registered tool (≡ API
`defer_loading: false`), so `save_requirements` stays resident in the turn-1 prompt instead of
being deferred behind the harness's tool search — the agent never has to ToolSearch its schema
back before a save. The "blocks startup until the server connects" side effect is moot: this is an
in-process SDK MCP server, so it connects instantly. Scope is the requirement agent only — this
server is built solely on the `kind === 'requirement'` / `gate: 'requirement'` launch path
(ADR 0007). The `tool()`
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

## Automation orchestrator (`automation.ts` + `git.ts` + `judge.ts`)

A per-project, in-memory state machine driven entirely by message handlers and an internal viewer
— no polling, no cron. One `AutomationController` per project lives in a module map; its `status`
(the `AutomationStatus` model) is the single source of truth, broadcast on every change.

- **Wire branches (`server.ts`).** `set_requirement_automate` → `store.setAutomate` + broadcast
  `requirements`. `start_automation` → `startAutomation(proj, hooks, now)` (no-op if already
  running) then broadcast the status. `stop_automation` → `stopAutomation(proj)` (aborts the live
  run). Entering the requirement view (`open_requirement_chat`) also pushes the current
  `automation_status` so a fresh connection restores the button state.
- **Dependency injection.** `automation.ts` imports the store/judge/git directly but takes server
  wiring via `AutomationHooks`: `runDevTurn` (bound to the WS-server closure),
  `broadcastRequirements`, `emitStatus` (→ `broadcastAutomation`), and `sessionExists` (the same
  `sessions.ts` disk check manual `start_development` uses — injected so the resume/dangling branch
  stays unit-testable with fakes). This keeps the state machine unit-testable (see `automation.test.ts`).
- **`runDevTurn` (server closure).** Ensures a `normal` runtime for the requirement (fresh
  `pending:` id, or resume an existing id for the "继续" continuation), registers an **internal
  viewer** on it, and launches/resumes via the shared `launchRun`. It surfaces the SDK session bind
  **early** via an `onSessionId` callback (fired from `launchRun`'s own `onSessionId`, well before
  the turn ends). The viewer captures the last `assistant_text` and resolves the turn on: `turn_end`
  → `complete`/`error`; `permission_request` → `blocked` (it also `stopRun`s the otherwise-hanging
  run, since no human is watching — RM-A9); the controller's abort → `blocked('aborted')`. A live
  team lead (rare for `/sdd-lite`) is fed via `pushInput` instead of a fresh launch.
- **Main loop (`AutomationController.run`).** `pickNext` selects the best eligible requirement
  (RM-A3: `automate` ∧ status∈{todo,in_progress} ∧ deps done; sorted P0→P3 then `createdAt`). For
  each, `develop()` first picks its **starting** session id: an `in_progress` requirement whose
  `lastDevSessionId` passes `sessionExists` is **resumed** (real id ⇒ `runDevTurn` continues that
  context, first prompt "继续"); a `todo` or dangling one starts `null` (fresh launch) — the same
  dangling rule as manual `start_development`. Then `develop()` loops: run a dev turn → **as soon as the dev session binds** (`onSessionId`,
  early — mirroring manual `start_development`) `markInProgress` does `setLastDevSession` +
  `updateStatus(in_progress)` + broadcast + emit, so the UI flips to `in_progress` immediately, not
  at turn end (a fallback re-marks if the early bind never fired); → on `complete`, `gitDiffStat` +
  `judgeCompletion`; `done` → `commitAndPush` then `updateStatus(done)` + push id to `completedIds`;
  `in_progress` → resume "继续" (cap `MAX_CONTINUATIONS=10`, RM-A8); `stuck`/`error`/`blocked`/push-fail
  → `fail(reason)` and stop the whole loop (RM-A6). No eligible item → state `done` (RM-A7). Abort
  mid-run → state `idle`.
- **Completion judge (`judge.ts`).** `judgeCompletion` builds a Chinese prompt (requirement + last
  message + **evidence**: `git diff HEAD --stat` for uncommitted work AND `git log --oneline -5` for
  recent commits — `/sdd-lite` often self-commits, leaving a clean tree, so an empty diff must NOT
  read as incomplete; the prompt instructs the judge to accept either source and lean `done` when
  the agent reports completion and the evidence is consistent) demanding a strict
  `{"verdict","reason"}` JSON, runs it through the tool-less `askOneShot` (default-agent env/model
  via `resolveSessionLaunch(null)`), logs the verdict, and tolerantly
  parses the first `{…}`; an unparseable answer is treated as `stuck` (fail-safe, RM-A4).
- **Git (`git.ts`).** `gitDiffStat`, `gitRecentLog`, and `commitAndPush` shell out via
  `execFile('git', ['-C', cwd, …])` and never reject (they return exit codes/stderr).
  `commitAndPush` stages all, commits `feat: <title>` **only when there are changes**, and then
  **always pushes** (an empty tree means `/sdd-lite` already committed its own work — we still push
  so those local commits reach the remote). Any non-zero step returns `{ ok:false, error }` which
  becomes the orchestrator's stop reason (RM-A5/A6).

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
- **Layout:** left `RequirementList.vue` (默认完整宽度 960px,窄屏 `min(960px,68vw)`;可在标题栏
  通过 `.req-collapse-btn` 在展开/收缩两态间切换,折叠态是组件本地 UI 状态 `collapsed`(同 `expandedId`
  范式),收缩态宽度减半至 480px 并以 `v-if` **不渲染** `.req-module` 与 `.req-actions`,展开态恢复;
  折叠态文案/可见性由纯函数 `lib/req-list-view.ts` 的 `panelToggleLabel`/`rowVisibility` 决定)
  (header: title + an **automation** button [▶ / ■ stop,
  highlighted while running, red on error] + status filter, with a status line below showing the
  current item or the stop reason;
  **列表排序(纯客户端 `displayRequirements`,服务端 `listRequirements` 的 `priority ASC, updated_at DESC`
  不变):**「全部」视图未完成项保持服务端原序置顶、已完成(`done`)项置底;置底段与「已完成」筛选整列均
  **按完成时间倒序、再优先级排序**——`lib/req-list-view.ts` 的 `compareByCompletion`:`completedAt` 降序为
  主键(缺失时回退 `createdAt`),同完成时刻按 `priority` 升序 P0→P3;其它单状态筛选原样不重排;
  per row a `MM/DD` date prefix
  — `completedAt` for done items, else `createdAt`, both zero-padded — an optional **module tag**
  (`.req-module` 胶囊标签,渲染于 date 与 title 之间;`module===''` 时 `v-if` 不渲染,无占位不破版)
  before the title/priority badge/status (`.req-status` 为彩色 pill 徽标,`:class="r.status"` 按
  draft 灰 / todo 主色 / in_progress 橙 / done 绿 / cancelled 红映射语义色,风格同 `.req-priority`,
  收缩态不隐藏;标签文案来自 `lib/req-list-view.ts` 的 `statusLabel`)
  and a dependency hint; per-status actions: Refine + Launch-development for `todo`, Development-details
  for launched, mark done/cancel for any), then a **trailing automate toggle icon** (`.req-automate`,
  渲染于 `.req-actions` 操作按钮排末尾、所有操作按钮之后;`r.automate` → ⏳ tooltip `in auto queue`,
  否则 ✋ tooltip `manual trigger mode`;因属于 `.req-actions`,收缩态随操作区一并隐藏);
  right **reuses** `ChatMessages` + `SessionStatusBar` +
  `MessageInput` against the already-viewed communication session. The automate icon emits
  `set-automate` (`@click.stop`, toggles `!r.automate`); the button emits `start-automation`/`stop-automation`.
- **Save confirmation:** `PermissionPrompt.vue` adds a branch for
  `toolName==='mcp__c3__save_requirements'` rendering each proposed item as a card
  (title/priority/dependency) with Save/Cancel mapped to allow/deny.
- **Requirement data:** `App.vue` holds `requirements: Record<projectPath, Requirement[]>`,
  refreshed by the `requirements` message, and `automation: Record<projectPath, AutomationStatus>`,
  refreshed by the `automation_status` message; `RequirementList` receives the current project's
  status as the `automation` prop.

## Dependencies

- **SQLite** — `node:sqlite` (Node) / `bun:sqlite` (Bun single binary); both `external` in
  esbuild.
- **agent-session** — the `requirement`-kind runtime and the shared `launchRun`.
- **permission-gateway** — gates `save_requirements` via the existing `canUseTool` flow.
- **session-registry** — its list filter consumes this domain's hidden set.
- **git (local CLI)** — `automation.ts`'s commit/push on a verified `done` (`git.ts`).
- **agent-session (one-shot)** — the completion judge runs `askOneShot` (tool-less SDK query).
- **`@anthropic-ai/claude-agent-sdk`** — `appendSystemPrompt` preset, `disallowedTools`,
  `createSdkMcpServer` / `tool`.
