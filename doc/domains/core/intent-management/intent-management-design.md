# intent-management — Design

Implements the [spec](intent-management-spec.md). The capability is built from a SQLite ledger layer, a store over
it, the read-only communication run variant plus the save tool, launch-development wiring, and the
automation orchestrator (state machine + completion judge + git helper), with hooks into the agent
run loop (a run variant), the runtime registry (a run `kind` + shared launcher), the WS dispatch
layer (new message branches), and session listing (hidden-set filtering). The frontend adds an
intent view.

**Reuse baseline.** Almost everything rides on existing machinery: the runtime registry, the
emit/viewer fan-out, and background runs; the chat stream and `user_prompt`; the permission
gateway for the save confirmation; `select_session` for the dev back-link. The genuinely new
parts are: the **SQLite layer**, the **read-only communication run variant + `save_intents`
tool**, the **intent frontend**, and the **automation orchestrator** (state machine +
completion judge + git helper) layered on the same runtime/launcher/viewer machinery.

## Responsibilities

| Concern                     | Notes                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SQLite driver adapter       | Shared cross-runtime adapter (Node vs Bun built-in SQLite); minimal synchronous API (also used by the discussion store)       |
| Ledger operations           | Intent CRUD, dependency aggregation, communication-session map                                                                |
| Communication system prompt | Read-only analyst prompt, injected as an appended system prompt                                                               |
| `c3` MCP tools              | Exposes `save_intents` (handler-gated confirmation) + read-only `find_intents` / `view_intent` (RM-R19)                       |
| Run variant                 | The run loop gains appended-system-prompt / disallowed-tools / MCP-servers / gate options; a tool-less one-shot for the judge |
| Runtime kind + launcher     | A run kind (`session` or `intent`) on the runtime; a shared launcher                                                          |
| WS branches + orchestration | Eight new message branches; communication-session viewer management; dev-turn helper + automation broadcast                   |
| Hidden-set list filter      | Session listing excludes the project's hidden set                                                                             |
| Automation orchestrator     | Per-project state machine: pick-next, continuation loop, judge + commit; injected hooks                                       |
| Completion judge            | Builds the prompt, runs the tool-less one-shot, parses `done`/`in_progress`/`stuck`                                           |
| Reconcile                   | Reconciles dead-process `in_progress` intents on list entry (injected deps)                                                   |
| Git helper                  | Diff-stat + recent-log + commit-and-push (scoped per repo, multi-repo aware); never rejects, returns codes/errors             |

## SQLite layer

- **Location:** `~/.c3/c3.db` — aligned with the c3 settings home `~/.c3/`, **not** the registry's
  `~/.claude/c3/`.
- **Cross-runtime driver (ADR 0007).** The layer exposes a minimal **synchronous** interface
  (exec / run / all / get) and picks the driver by runtime: the Bun binary uses Bun's built-in
  SQLite, Node uses Node's built-in synchronous SQLite. The two never cross. Both are synchronous, so a
  single sync adapter matches c3's existing synchronous persistence style.
- **Adapter constraints (the two APIs differ for real):** use only positional placeholders
  (named params bind differently); read rows by field only (one driver returns null-prototype objects,
  the other plain objects). The drivers differ in their prepare/query and multi-statement APIs, which
  the adapter normalizes.
- **Build (mandatory):** the server bundle must mark both built-in SQLite modules as external. A
  dynamic import is **not** enough — the bundler still fails to resolve the Bun module without an
  external marker.
- **PRAGMA on create:** WAL journal mode + a busy timeout, cheaply reducing lock conflicts
  when multiple c3 processes point at one db (cross-process is not a v1 goal but the setting is
  free).
- **Fail-soft (per entry point):** on open/create failure, mark the db unavailable,
  disabling intent features without affecting c3 boot (RM-R12) — consistent with the
  "boot even with broken config" rule.

## Schema (`PRAGMA user_version` migrations)

- `intents` — the ledger (`id`, `workspace_path`, `title`, `content`, `priority`, `status`,
  `module`, `last_dev_session_id`, `automate`, `created_at`, `updated_at`, `completed_at`), indexed
  by `(workspace_path, status)`. `module` is `TEXT NOT NULL DEFAULT ''`; `automate` is
  `INTEGER NOT NULL DEFAULT 0`.
- `intent_deps` — `(intent_id, depends_on_id)` edges.
- `intent_chats` — one table doubling as the **per-workspace communication session
  collection** and the **hidden set**: `session_id` (PK, may be a `pending:` id), `workspace_path`,
  `title` (nullable, client fallback to "New Intent" or first-prompt derivation),
  `is_current` (0/1, at most one per project — the default-open pointer),
  `updated_at`. The full set of rows for a project is the hidden set; the `is_current=1` row
  is the session re-loaded on entering the intent view without a specific `sessionId`.

**Schema version (current: v11).** The schema version is `11`. Each bump adds one idempotent
migration after the legacy renames and before applying the schema: v2 `module`, v3
`completed_at` (nullable), v4 `automate` (`INTEGER NOT NULL DEFAULT 0`), v6 legacy `requirement*`
→ `intent*` rename, v7 `intent_chats.title` (`TEXT`), v8 git-tracking fields, v9 `intent_deps`
(`dep_type` and `created_at`), v10 an audit table, **v11 the workspace-key column
`project_path` → `workspace_path` in-place rename** on `intents` + `intent_chats` (composite index rebuilt as
`idx_intent_workspace_status`; the single-column chat index keeps its name, its column reference
auto-updated by the rename). v11 **deliberately diverges** from the back-compat `projectConfigs`
settings.json key, which keeps its legacy name (see the 2026-06-14 workspace-path migration record). The rename
runs BEFORE the schema is applied (the new composite index references
the renamed column); idempotent, never drops a table. Same key-off-column-presence pattern as below.

**Schema version & migration (v1 → v2).** The fresh-create schema
already declares `intents.module`. For pre-existing dbs (v1, no `module` column), the open path
runs an **idempotent column migration** after applying the schema and before writing the schema
version: it checks the table info and only adds the `module` column (`TEXT NOT NULL DEFAULT ''`) if
absent. This keys off the actual column presence (not
the exact version history), so it is safe on new and old dbs and idempotent across runs;
adding a column is a lightweight metadata-only op and historical rows take the `''`
default (no backfill). Both built-in SQLite drivers support table-info inspection and
add-column through the shared adapter (RM-R14).

## Store

- **Path normalization (RM-R10):** every `workspacePath` arg is resolved to an absolute path before
  read/write, matching the workspace key / runtime working directory / agent working directory.
  Otherwise queries miss and hidden filtering breaks.
- Intents: list (with `dependsOn` aggregation), insert (transactional batch, uuid, status `todo`;
  persists `module` as `it.module ?? ''`, `automate` defaults to `0`), upsert
  (the `save_intents` write path — insert or in-place update per item `id`, RM-R20; see below),
  update-status, set-last-dev-session, set-automate, update-intent, get-intent. The
  internal row hydration carries `module` + `automate` (mapped to boolean) so every read path returns
  them; the plain update does not patch `module` (the upsert writes `module` directly instead).
- **Upsert write path (RM-R20).** The upsert backs `save_intents` (replacing
  the old direct insert call). It resolves each item to a stable id up front — the supplied
  `id` for an update, a fresh uuid for an insert — so `dependsOnIndexes` (RM-R17) resolves against the
  full batch regardless of whether a referenced sibling is new or being updated. **All validation runs
  before the transaction opens** (atomic reject, nothing half-written): each update `id` is fetched and
  guarded to belong to the resolved workspace (unknown / cross-project ⇒ reject), and its current
  status is checked — `in_progress`/`done` reject as immutable, `cancelled` is flagged for reactivation.
  Inside the single transaction, an update writes `title`/`content`/`priority`, writes `module` only when supplied
  (else keeps the prior), sets status to `todo` for a reactivated `cancelled` (else unchanged) with
  `completed_at` cleared, and rewrites the dependency edges only when `dependsOn`/`dependsOnIndexes` was supplied;
  an insert behaves exactly as a plain insert (status `todo`, creation time offset by index). The
  `save_intents` handler turns any rejection into an error result so the agent learns nothing was written.
  - **Single-intent session back-link (`intentSessionId`).** When — and only when — the batch holds
    **exactly one** item carrying `intentSessionId`, the upsert writes it to that row's
    `intent_session_id` (on both the insert and the in-place-update sub-path; the update uses
    `COALESCE(?, intent_session_id)` so an absent value preserves any prior link). A batch of more than
    one item forces the column to null regardless of what was supplied — there is no single source
    session for a batch. This is a **double guard**: the schema description tells the agent "single
    only", and the store enforces it independently. `insertIntents` (the schedule-only
    `save_intent_directly` path) never reads the field — drafts have no communication-session semantics.
    This explicit-field write covers the gap the refine `run:bound` backfill (below) cannot reach:
    a comm session that **creates a brand-new** intent has no pending→intent link to backfill, so the
    one-shot field is how that new intent links back to its originating conversation.
- **Read-only agent query (RM-R19):** the find operation backs the agent's `find_intents` tool —
  filters compose with `AND`, all optional: `keyword`
  is a substring match over `title` OR `content` (wildcard characters in the keyword are escaped so a
  literal `%` doesn't act as a wildcard), `module`/`status` are exact-match;
  same resolve + workspace scoping and `priority ASC, updated_at DESC` order as
  the list; empty when the db is unavailable. The `view_intent` tool reuses the id-only
  get and the **tool handler** guards that the intent belongs to the bound project,
  so an id from another project reads as not-found (no cross-project leak).
- **Intra-batch dependencies (RM-R17).** The insert mints **all** row ids up front
  so a batch can reference its own siblings before any row has an
  id. A pure batch-dependency resolver then, per item, validates
  `dependsOnIndexes` (each must be an in-range, non-self index), runs a 3-colour cycle detection
  to reject any intra-batch cycle, and returns the merged & de-duplicated
  dependency-id list (existing-id `dependsOn` ∪ the indexes resolved to sibling ids). It runs
  **before** the transaction opens, so an invalid batch is rejected and nothing is written; the
  `save_intents` handler turns the rejection into an error result. Being pure (items + ids in,
  id-lists out) it is unit-tested without a db. Each row is stamped with a creation time offset by index so
  same-priority, dependency-free items keep a deterministic submission-order rank in the
  orchestrator's oldest-first tiebreak (RM-A3), instead of the arbitrary order a single shared
  timestamp produced.
- Communication session (collection table): get the current session
  (`is_current=1` — default-open pointer); set the current session (clear the project's `is_current` then
  upsert the new row as `is_current=1`, also entering the hidden set);
  list all rows (ordered by `updated_at` DESC);
  rename (updates `title` + bumps `updated_at`);
  delete (physically deletes the row; if the deleted row was
  `is_current`, promotes the most recent remaining row by `updated_at` to `is_current=1`);
  hidden-set queries;
  rebind (rewrite the pending row to the real id on first bind,
  keeping `is_current` and hidden-set membership).

## Run variant

- The runtime gains a run `kind` (default `session`; was a two-value `normal | intent`, with
  `normal → session` — see glossary / ADR-0018); `user_prompt`
  dispatches on the runtime's kind to the standard or intent variant of the run loop.
- A shared launcher is extracted from `user_prompt`. **Boundary:**
  it only touches module-level emit / status-broadcast / the registry; connection-specific
  replies stay with the caller as optional callbacks — so
  `start_development` (no-connection background run) and `refine_intent` (seeded first prompt) reuse
  the same launcher.
- The run loop gains optional appended system prompt, disallowed tools, MCP servers, and a
  gate selector (`standard` | `intent`) without breaking existing callers. The communication agent's
  MCP servers are constructed **server-side** in the `user_prompt` branch (closing over the
  resolved workspace), keeping the run loop free of the store.

## Read-only communication session (ADR 0007)

- **Forced `default` mode (RM-R3, auxiliary).** The communication runtime is started in
  `default` permission mode and does **not** inherit the system default mode; `set_mode` is
  ignored for the intent kind and the view renders no mode selector. This is now an _auxiliary_
  constraint: it does **not** carry the silent-save defence on its own. A vendor allow-rule can
  pre-approve `save_intents` and skip the permission gate even under `default` mode, so the save
  confirmation is enforced **inside the save handler** instead (see "Save confirmation in the
  handler" below) — immune to every pre-approval vector.
- **Double-locked read-only (RM-R2).** The hard-disabled tool list blocks
  Write / Edit / MultiEdit / NotebookEdit / Bash / BashOutput / KillShell / Task / SlashCommand.
  Task and SlashCommand are essential: a spawned sub-agent's tool calls bypass the parent
  permission gate, and slash commands could trigger writing skills. On top of that the
  intent gate **denies by default**, routed by a pure, exported tool classifier
  → `allow` | `ask` | `deny` (unit-tested, since the live closure is otherwise
  e2e-only): read-class tools
  (Read / Grep / Glob / LS / NotebookRead / WebFetch / WebSearch / TaskCreate / TaskList / TaskUpdate / TaskGet) **and**
  the two read-only c3 query tools (`find_intents` / `view_intent`, RM-R19) → `allow` (auto-allow,
  no prompt — they only read the agent's own project ledger); `save_intents` → `allow` **through to
  its handler** (the handler raises the confirmation itself — see "Save confirmation in the handler";
  the gate must not prompt for save, or it would double-prompt); `AskUserQuestion` → `ask`. `AskUserQuestion` is an **interactive
  (clarifying-only) tool, not a write tool** — it has no file/exec side effects, so the read-only
  agent may use it. It is therefore **kept out of the hard-disabled list** and **allowed but routed via
  user-answer injection** — send a `permission_request`, await the user decision, on allow return
  the answers (the SDK only echoes answers when they are pre-filled),
  on cancel deny. It runs **without consensus** (single agent, no voting party). A guard
  filters empty/invalid questions, which fall through to the default
  deny. Everything else is denied (belt-and-braces even if the SDK adds a new write tool). The
  SDK-level hard-disabled list
  (Write / Edit / MultiEdit / NotebookEdit / Bash / BashOutput / KillShell / Task / SlashCommand) is unchanged and
  **does not include `AskUserQuestion`**.
- **Codex driver permission shape.** When the default/bound communication agent is Codex, the
  driver path still runs the intent profile and injects the localhost HTTP MCP server, but uses the
  Codex grid `plan + never-ask` (mapped to `read-only + never`) instead of `plan + always-ask`.
  Codex has no live approval channel, so `always-ask` can block MCP use; the filesystem remains
  read-only, while `save_intents` is still gated by c3 inside the MCP handler before any ledger
  write.
- **Independent viewer orchestration.** `open_intent_chat` / `new_intent_chat` /
  `refine_intent` manage the
  viewer switch themselves (remove the old viewer → set the viewed session → add the new viewer) and
  do **not** reuse `select_session`'s internals (which unconditionally set the active session). The
  communication session's session-id binding rebinds the real id but **never** writes the persisted
  active-session hint — hidden sessions must not pollute it.
- **Open/resume (`open_intent_chat`):** db unavailable → `error`. Accepts an optional
  `sessionId` — when provided, verifies the session exists for this project and opens it (also
  making it `isCurrent` so a subsequent no-sessionId open returns here); when absent, uses
  the current (`is_current=1`) session, creating a new `pending:` session if none exists.
  Then switch the viewer, reply `session_selected` (history), and reply an `intents` list
  **immediately** (run-state reconcile runs in the background afterward — see Reconcile). This same
  branch is what re-loads the project's current communication session on first entry, WS
  reconnect, and full-page refresh (RM-R4).
- **New session (`new_intent_chat`):** unknown workspace / db unavailable → `error`; otherwise
  unconditionally start a fresh `pending:` intent runtime (`default` mode) and set it as the current
  session — which clears the project's prior current row before marking the new one current.
  Switch the viewer, reply `session_selected` (empty history) and an `intents` list. No first
  prompt is injected (unlike refine): the dialog opens empty for a new round of communication.
  Because the new session is now current, a later `open_intent_chat` (refresh/reconnect)
  resumes **this** session, not the abandoned one. Triggered by the "+" in the title bar (RM-R4).
- **Refine (`refine_intent`):** switch away from the old communication view, start a new
  `pending:` intent runtime (`default` mode), set it as current, reply `session_selected`
  (empty), then the launcher injects a first `user_prompt` equivalent to a user message (RM-R7). The
  seed prompt carries the **original intent id and its current status** and instructs the agent to
  call `save_intents` with that id so定稿 updates the original entry in place (upsert, RM-R20)
  — not a duplicate — and to tell the user it cannot be modified if the intent is already
  `in_progress`/`done`. ("开始完善已存在意图 <id>(当前状态:…) …, 定稿后调用 save_intents 并回填
  id 以原地更新原意图") Refine also registers a **pending→intent link** before launch so the
  resident `run:bound` subscription backfills the originating intent's `intentSessionId` with the
  real comm session id on first bind — mirroring the spec-session link that backfills
  `specSessionId` — making the refine conversation reopenable later from the intent detail's
  「intent session」tab (`open_intent_chat` with that id). An error-before-bind edge is swept by a
  `run:settled` (kind=intent) safety net.
- **From discussion (`discussion_to_intent`):** the same refine machinery, but the seed is a
  completed discussion's `conclusion` rather than an existing intent. The server loads the
  discussion, rejects unless `completed` with a non-empty `conclusion`, resolves
  the project from the discussion's workspace, then runs the identical `pending:` intent-runtime
  flow with a first prompt carrying the discussion title + conclusion ("基于以下讨论结论拆分出可验证
  的需求条目 …, 定稿后调用 save_intents"). Triggered by the discussion view's **Convert to
  Intent** button (RM-R7).
- **Reset intent session (`reset_intent_session`):** the escape hatch for a context-rotted refine
  conversation after the intent changed (RM-R24). The intent detail header's 「我要修改」 opens the
  controlled input dialog; the intent-session tab itself has no reset button. Identical machinery to
  **Refine**, but the seed prompt prepends the user's **new steering input** ahead of the intent's
  current title + content, then instructs the agent to upsert the original id in place
  ("继续完善已存在意图 <id>… 我的新输入:… 当前意图内容:…"). It registers the same pending→intent link, so
  the resident `run:bound` subscription **replaces** the intent's `intentSessionId` with the new
  comm session id on first bind. The prior session stays queryable under Works (Run center) but is
  no longer the intent's linked session; no batch reset.
- **Reset spec session (`reset_spec_session`):** the spec document tab's 「我要修改」 action, mirroring
  **Write spec** but reusing the EXISTING spec directory / path (no scaffolding). The spec-session
  tab itself has no reset button. Rejected (`error`
  `intent.specNotWritten`) when no spec was ever written; claude-only, same as authoring (the codex
  driver cannot path-confine writes — `intent.specAgentUnsupported`). The server launches a fresh
  write-confined `'spec'` session seeded with the user's **new input** + a pointer to the current
  `spec_path` (only the path — the agent reads the spec file itself; the prompt no longer inlines the
  spec body), replies `session_selected` (so the detail's 「spec session」tab switches to it), and
  registers the pending→intent link so `run:bound` replaces the intent's `specSessionId` on first
  bind. The server no longer pre-reads the spec file, so its readability is not a launch
  precondition; a missing/unreadable spec becomes a normal file error the agent faces when it reads
  the path.

## Communication system prompt

Injected as an appended system prompt on the `claude_code` preset, built per run with the display
language. **The prompt skeleton is in English**; only the closing
"reply in this language" instruction follows the **Display language** —
read at run start so the analyst converses in the user's console language,
instead of a hard-coded one. In brief: you are an intent analyst; read
project material only, never edit/write/run change commands/spawn sub-agents/run slash commands;
you may query THIS project's existing ledger read-only via `find_intents` / `view_intent`,
and should do so **before** splitting new items or setting `dependsOn` (reuse related items, avoid
duplicates, reference the correct existing id — RM-R19);
converse with the user and break requests into discrete, verifiable, right-sized items (each with
title/content/priority P0–P3/optional dependencies/**inferred module name**); confirm a list with
the user first; on approval call `save_intents` (the system pops the confirmation, the real
write follows the user's allow); never pretend a save happened. The dependency guidance is
explicit: use `dependsOn` for intents that already exist (by id) and `dependsOnIndexes` for
**sibling items in the same batch** (by 0-based array index), and **must** declare the batch's
order — putting the prerequisite earlier in the array and pointing the dependent item's
`dependsOnIndexes` at it — whenever items have先后关系, so the orchestrator sequences them right
(RM-R17). The prompt asks the agent to infer
each item's **module name** from its title/content (e.g. auth、session、intent-management),
leaving it blank when unsure, and to pass `module` per item to `save_intents`. This is scheme
**a** (infer from title/content); a future extension may key off the project's actual module
structure for more precise classification (RM-R14).

The prompt also carries a **refine-upsert rule (RM-R20):** when refining an intent that already
exists (the seed prompt hands the agent its id), the agent **must** set that item's `id` on
`save_intents` so the original entry is updated in place — never omit it and create a duplicate; a
`cancelled` original is reactivated to `todo`, while an `in_progress`/`done` original is immutable
(the agent tells the user it cannot be modified rather than attempting a save). A batch may mix
updates (with id) and brand-new items (without id).

The prompt **injects this run's session id** so the agent can back-link a single saved intent to
the conversation: when a round saves **exactly one** intent, the agent copies the injected id into
that item's `intentSessionId` (the prompt forbids it on a multi-item batch — there is no single
source session). The id injected at prompt-build time is a `pending:` id (the SDK has not bound
yet), so the **save handler normalizes** it to the bound comm-session id before persisting — the
same id `open_intent_chat` resolves against and that the refine `run:bound` backfill writes, so the
two link sources land in one id space. The model only decides **whether** to set the field; the
**value** is server-authoritative.

The prompt also carries a **decomposition rule (a single goal is never split)**: when one goal
touches **code, its tests, and/or its companion docs** (spec / README / comments), the analyst
folds the test- and doc-sync work into the **same** intent's content + acceptance points
rather than emitting a separate「更新测试」/「文档更新」item — code, its tests, and its docs are one
change, kept on one ticket so no half is scheduled apart or dropped, which would drift tests/docs
out of sync with code (RM-R15).

## `c3` MCP tools

The in-process MCP server is named `c3` and carries `save_intents`, `find_intents`, and
`view_intent`. Each registered tool is stamped to **stay resident in the turn-1 prompt** instead of
being deferred behind the harness's tool search — so `save_intents` is available without the agent
having to search its schema back before a save. The "blocks startup until the server connects" side
effect is moot: this is an in-process MCP server, so it connects instantly. Scope is the intent
agent only — this server is built solely on the intent kind / intent gate launch path (ADR 0007).
Each intent element
includes an optional `id` (the existing-intent id to update
in place — upsert, RM-R20; omit to insert) and an optional `module`
(the inferred module name, may be left blank); both flow through to the upsert
(RM-R14/RM-R20). It also carries `dependsOn` (ids of already-existing intents) and
`dependsOnIndexes` (0-based indexes into the same batch,
the intra-batch dependency to fill when items have先后关系); both flow through to
the upsert, which resolves the indexes against the full batch (RM-R17). The tool's top-level
description tells the agent to use `id` for refine-in-place and `dependsOnIndexes` for intra-batch
order so the orchestrator sequences correctly. The handler **runs the confirmation gate itself**
(emit `permission_request`, block on the decision, persist only on `allow` — see "Save confirmation
in the handler"); on allow it writes via the store's upsert (insert or in-place update per
item id) and broadcasts an `intents` refresh, returning a text result that notes the insert/update
split (or an error text on db-unavailable / failure — incl. an immutable-status or unknown / cross-project
update id rejecting the whole batch — so the agent learns it did not save). The handler binding —
project path, **live** run-id getter, and abort signal — is supplied per run (the run-id getter and
signal are constructed at query time, where they exist; the project path is closed over from the
runtime's resolved workspace), so the tool never crosses projects and routes the confirmation to the
bound session.

**Save confirmation in the handler (immune to vendor pre-approval).** Originally the claude path
gated save in `canUseTool`. But a vendor's permission-rule engine can _pre-approve_ a tool and skip
`canUseTool` entirely (a user/project allow-rule matching `mcp__c3__save_intents`, or a non-`default`
mode), which let a save persist silently. So the confirmation is **sunk into the save handler** — its
single execution point, reached whenever the tool is called, which vendor rules cannot bypass (they
only decide _whether_ to call it). This converges **both vendors on one gate**: the codex/driver path
(calling the tools over HTTP MCP, outside any `canUseTool`) already gated in the handler, and the
claude in-process path now matches it. The intent gate therefore allows save straight through (no
`confirm-save` branch, no second prompt). On non-`default` modes / allow-rules the handler still
prompts; on deny / cancel / abort it returns a「未落库」result and never touches the store.

The three tools' shapes, descriptions, and core logic live in ONE source, consumed by both MCP
surfaces (the in-process SDK MCP here and the HTTP MCP below) so they never drift.

**Read-only query tools (RM-R19).** The same server also carries `find_intents`
(`{ keyword?, module?, status? }`, all optional; `status` is constrained to the five
status values) → the store's find → a **slim** JSON list
(`id`/`title`/`module`/`priority`/`status`/`dependsOn`; `content` is deliberately omitted to keep the
list compact) or a「未找到」message, and `view_intent` (`{ id }`) → the store's get →
the single intent's **full** JSON, guarding that the intent belongs to the bound project so an
unknown / other-project id returns a friendly「未找到」text (not an error). Both close over the same
workspace (no cross-project reads), stay resident, and are auto-allowed by the gate, unlike
`save_intents`'s confirmation. The agent is
prompted to query the ledger before splitting items or setting `dependsOn`.

## Intent tools over localhost HTTP MCP — cross-vendor (2026-06-12-005)

The `c3` server above is an **in-process** SDK MCP server, which only the Claude path can see;
driver-path vendors cannot. To keep the intent
panel vendor-neutral, the SAME three tools are re-exposed over a **localhost streamable-HTTP MCP
route**, mounted on c3's own server (before the SPA catch-all, like the codex relay).

- **Per-run binding + isolation.** The intent profile binds a per-run MCP server (only for Codex
  today): an opaque token maps to a private MCP server whose tool handlers close over that run's
  project. The token rides the URL query; the project binding lives in the closure, so an agent can
  neither read nor write another project's ledger. The binding is evicted at run end.
- **Loopback-only.** A defence-in-depth guard rejects non-loopback peers (403) on top of c3's
  localhost bind; an unknown/expired token is 404 (Constitution localhost-only / deny-by-default).
- **Save gate (shared by both vendors).** The save confirmation lives **in the save handler**, the
  one gate both surfaces share: it emits the same `permission_request` frame (the `save_intents` tool
  name plus the proposed intents), blocks on the decision, and persists only on `allow`.
  `find_intents`/`view_intent` are auto-allowed (read-only). A deny / aborted run never reaches the
  store. Codex must gate here because it calls the tool outside any c3 `canUseTool`; the claude
  in-process path now gates here too, so a vendor pre-approval that skips `canUseTool` still prompts.
- **Driver translation.** The neutral remote-MCP descriptor (type, url, optional bearer-token env
  var) is translated by the codex driver to the streamable-HTTP MCP form it writes.
- **Claude isolation.** The claude path still uses the in-process MCP server (now bound per run with
  the same gate deps) and ignores the token URL — a later intent must design its isolation, not relax
  the per-project guard.

## Launch development (`start_development`)

1. Resolve the project and synchronously claim the intent id in the feature-private in-memory
   launch set before worktree creation or launch. If already claimed, reply
   a dev-start-in-flight error and stop. Release the claim once the pending dev link
   is consumed on bind, and on every pre-launch / startup failure path (including worktree creation failure
   and launch rejection).
2. Validate the intent exists and is `todo`, or `in_progress` with a dangling (deleted)
   `lastDevSessionId` (allowing relaunch; other states → `error`) (RM-R8).
3. Unmet-dependency check: any `dependsOn` not `done` → still allowed, but the frontend
   second-confirms before sending in the manual path (RM-R11).
4. **Pull latest before launch** (2026-06-20) so the work session builds on up-to-date code:
   - `worktree` mode: `git fetch` the base branch from the remote and root the worktree at
     `<remote>/<base>` (via `git worktree add --no-track`), falling back to the local base branch
     when there is no remote / the fetch fails. Synchronous — preserves the automation controller's
     microtask timing contract. Fetch never merges, so this branch never blocks.
   - `current-branch` mode: `git pull --ff-only` on the project checkout. No remote / no upstream /
     offline ⇒ best-effort skip; a **diverged** branch (non-fast-forward) ⇒ hard stop returning a
     pull-failed error (manual path: send error + release claim; automation: surfaced as an
     automation failure). Never auto-merges / auto-rebases.
5. Start a **background normal runtime** (`pending:`) via the shared dev prompt builder. The
   visible prompt is `title + content + dependency summary`, plus the approved spec-path note
   when SDD is enabled and a spec path exists. Internal prompt channels are separate from the
   visible echo: a configured `devSkill` leads the model user turn, while SDD's work-session
   prompt uses the system-instruction channel when no `devSkill` is configured. Manual launch and
   automation use the same prompt construction and do not change the branch/worktree/session flow.
   On session bind, set last-dev-session + status `in_progress` + broadcast `intents` + broadcast
   statuses.
6. The run is backgrounded and survives disconnect; the development session is a **normal**
   session that appears in the sidebar; `lastDevSessionId` powers the back-link.

## Automation orchestrator

A per-project, in-memory state machine driven entirely by message handlers and an internal viewer
— no polling, no cron. One controller per project lives in a module map; its automation status
is the single source of truth, broadcast on every change.

- **Wire branches.** `set_intent_automate` → set the automate flag + broadcast
  `intents`. `start_automation` → start the orchestrator (no-op if already
  running) then broadcast the status. `stop_automation` → stop the orchestrator (aborts the live
  run). Entering the intent view (`open_intent_chat`) also pushes the current
  `automation_status` so a fresh connection restores the button state.
- **Dependency injection.** The orchestrator imports the store/judge/git directly but takes server
  wiring via injected hooks: a dev-turn runner (bound to the WS-server closure),
  an intents broadcaster, a status emitter, a session-exists disk check (the same
  one manual launch uses — injected so the resume/dangling branch
  stays unit-testable with fakes), and an is-running in-flight check (injected so the
  attach branch — RM-A10 — stays unit-testable with fakes). This keeps the state machine unit-testable.
- **Dev-turn runner (server closure).** Ensures a normal runtime for the intent (fresh
  `pending:` id, or resume an existing id for the continue continuation), registers an **internal
  viewer** on it, and launches/resumes via the shared launcher. It surfaces the SDK session bind
  **early** via a callback (fired well before the turn ends). The viewer captures the last
  assistant message and resolves the turn on: `turn_end`
  → `complete`/`error`; the controller's abort → blocked (aborted). A `permission_request` does
  **not** resolve the turn — automation **mirrors manual** (RM-A9): the run stays alive awaiting the
  watching human's browser answer, and the viewer only flips the awaiting-permission flag (cleared on
  the answering tool-result, or on `turn_end`) so the controller can flip `awaitingPermission` on
  the status ("awaiting authorization" hint). A live team lead (rare for a dev skill) is fed via a
  push instead of a fresh launch.
  - **Attach mode (RM-A10).** When the controller passes attach mode, the closure
    only registers the viewer — it **never** launches or pushes. It seeds the last text from the runtime
    **buffer**'s last assistant message (the in-flight turn's latest message may have been emitted
    before the viewer attached, so the judge would otherwise read empty). If the run already settled in
    the race between the controller's is-running check and viewer registration, it resolves
    immediately from the buffer's trailing `turn_end` (`complete`/`error`) instead of hanging. On
    this replay path it also computes the pending-question flag from the buffer so a settled turn
    that ended on an unanswered `AskUserQuestion` is flagged for the human-decision guard
    (RM-A11) — otherwise it would read as a plain `complete` and risk a blind continue.
- **Main loop.** At the top of each loop iteration, **before** picking the next intent, the global concurrency gate (RM-A12) scans **all** `in_progress` intents (regardless of the `automate` flag) for a dev session that is **truly running** (`lastDevSessionId` non-null AND the run is live). When found, it attaches an internal viewer to that in-flight turn (in attach mode) and waits for it to settle — logging the outcome but **never** judging or interfering with the intent's lifecycle (manual intents are outside the orchestrator's scope). After the turn settles, the loop re-checks the gate; when clear, it falls through to pick the next intent. A dangling session (on disk but not running) passes the gate immediately. This is independent of the per-intent attach logic (RM-A10), which handles a **selected** intent's own running session after the pick; the gate covers **any** running session from intents the pick would not select (notably non-`automate` manual runs), preventing concurrent dev sessions that would conflict on file modifications in the same working tree.
- **Pick next** selects the best eligible intent
  (RM-A3: `automate` ∧ status∈{todo,in_progress} ∧ deps done; sorted P0→P3 then `createdAt`). For
  each, the develop step first picks its **starting** action by precedence: (1) if `lastDevSessionId` is
  **already running** it **attaches** (RM-A10) — attach mode, starting id =
  `lastDevSessionId`, and the in-progress mark is applied **before** the dev turn (no launch ⇒ no early
  bind, so the status must point at the tracked session up front); else (2) an `in_progress`
  intent whose `lastDevSessionId` passes the session-exists check is **resumed** (real id ⇒ the dev turn
  continues that context, first prompt continue); else (3) a `todo` or dangling one starts a fresh
  launch — the same dangling rule as manual launch. The attach flag applies to the
  **first** turn only; it is cleared after the first turn so any continue continuation uses the
  ordinary resume path (the attached turn settled the run). Then the develop step loops: run a dev turn → **as soon as the dev session binds**
  (early — mirroring manual launch) the in-progress mark does set-last-dev-session +
  status `in_progress` + broadcast + emit, so the UI flips to `in_progress` immediately, not
  at turn end (a fallback re-marks if the early bind never fired); → on `complete`, gather diff-stat +
  run the completion judge; `done` → commit (with lint self-heal) then mark `done` + push id to the completed set;
  `in_progress` → resume continue (cap of 10 continuations, RM-A8); `stuck`/`error`/push-fail (and a
  torn-down pending question, RM-A11) → fail with a reason and stop the whole loop (RM-A6). A live
  permission prompt does **not** stop the loop — it waits for the watching human (RM-A9), and
  the awaiting-permission flag flips the status hint while paused. No eligible item
  → state `done` (RM-A7). Abort mid-run (blocked/aborted) → state `idle`.
  - **Human-decision guard (RM-A11).** Before the `done`/`in_progress`/`stuck` branch, the develop step
    checks the turn's pending-question flag: when the turn ended on an **unanswered `AskUserQuestion`**, it
    fails immediately — **even if the judge said `in_progress`** — so a mis-judged verdict
    can never drive a blind continue over a real user choice. The flag is computed by a pure
    detector (exported, unit-tested): an `AskUserQuestion`
    tool-use with no matching tool-result (by tool-use id) means the question was never answered.
    A **live** AskUserQuestion no longer blocks — the dev-turn runner keeps the run alive for the watching
    human to answer (RM-A9); the flag specifically covers the **torn-down / attach buffer-replay** path, where a
    settled run carrying a pending question would otherwise surface as `complete`.
  - **Auto-commit lint self-heal (RM-A13).** The `done` branch commits through
    a commit-with-lint-heal helper rather than a bare commit. It first commits; on
    success it returns committed. A failure that is **not** a commit-hook failure (push rejected, no
    upstream, no repo …) is returned verbatim → hard stop (RM-A6), **never** retried. A
    commit-hook failure (a pre-commit lint hook) is healed by a **single dev-agent attempt** —
    lint toolchains differ per project, so there is no portable fix _command_: it resumes the **same**
    dev session (same id, no attach) with a targeted prompt embedding the
    lint error summary, lets the agent fix it, then retries the commit **once** (re-staging
    everything). A retry that succeeds ends the heal; a retry that fails non-commit-hook surfaces
    verbatim; a retry that is still a lint failure returns `lint 自动修复失败(修复 agent 介入后仍未通过)…`
    → fail (RM-A6, intent not `done`). The abort signal is checked around every await (abort returns
    failure with no error so the caller stays quiet); the agent fix turn's permission pause flips
    the awaiting flag per RM-A9. Every stage logs a trail.
- **Completion judge.** The judge builds an English prompt (intent + last
  message + **evidence**: `git diff HEAD --stat` for uncommitted work AND `git log --oneline -5` for
  recent commits — the dev skill often self-commits, leaving a clean tree, so an empty diff must NOT
  read as incomplete; either source counts) demanding a strict `{"verdict","reason"}` JSON. The
  verdict rules are ordered **stuck → done → in_progress** with the priority pinned in the prompt:
  (1) **stuck first** — any human-intervention signal (asking the user / `AskUserQuestion`,
  presenting options or seeking a preference/direction/scope/trade-off; waiting on a permission;
  blocked for lack of context; errored/gave up; or claims done with no consistent evidence);
  (2) **done** only if not stuck and the change evidence is consistent (the agent's word alone is
  insufficient); (3) **in_progress** as the **fallback** for a pure dev-skill checkpoint or
  self-driven remaining steps. The old "bias toward done / continue" wording is **removed** —
  `in_progress` is no longer a default. It runs through the tool-less one-shot query (default-agent
  env/model), logs the verdict, and tolerantly parses the first
  JSON object; an unparseable / out-of-range answer is treated as `stuck` (fail-safe — never silently
  `in_progress`, RM-A4). The judge is the **first** line of the human-decision defence; the
  orchestrator's pending-question guard (RM-A11) is the second.
- **Git helper.** Diff-stat, recent-log, and commit-and-push shell out via the git CLI scoped to a
  directory and never reject (they return exit codes/stderr).
  Commit-and-push is **multi-repo aware**:
  - If the project root has a `.git` marker it is treated as the single repo — classic behaviour:
    stage all, commit `feat: <title>` **only when there are changes**, then **always push** (an empty
    tree means the dev skill already self-committed — we still push so those commits reach the remote).
  - Otherwise it discovers git repos under the root (recursive, bounded depth,
    skips `node_modules`/`dist`/etc., stops at each repo boundary) and commits each **affected** repo
    independently. Staging is scoped per repo, so changed files group to their
    owning repo by location. A repo is affected when its tree is dirty **or** it is ahead of upstream
    (covers a subrepo the dev skill self-committed); untouched repos are left alone. Finding **no** repo
    is an error (`工作区内未找到 git 仓库,无法提交`).
  - Any non-zero step returns a failure (the failing subrepo's relative path is
    named in the message), which becomes the orchestrator's stop reason (RM-A5/A6). The failure
    kind classifies **why**: a failed `git commit` whose output carries a
    lint/pre-commit-hook signature (`eslint`/`prettier`/`lint-staged`/`husky`/`pre-commit`/`✖`, via a
    pure, unit-tested classifier) is a commit-hook failure (self-heal-eligible, RM-A13); every
    other failure (`git add`/`status`/`push`, no-repo) is a hard stop. Multi-repo runs
    propagate the sub-repo's failure kind so a sub-repo lint failure still triggers the self-heal
    (RM-A13). There is **no** lint-fix _command_ helper — the heal is a single dev-agent fix, since
    lint toolchains are not portable across projects.

## Reconcile

A standalone (injected) reconcile function is called by the server's
`open_intent_chat` handler **in the background, after** the intent
list is already sent to the client (perf: the panel renders immediately on the
cached/derived `runStatus`, and an intents-refresh broadcast pushes the refreshed
list once reconcile settles — judging a dead session is an LLM call and must
never block the first paint). It processes every `in_progress` intent for a
project:

1. **Liveness check:** if `lastDevSessionId` is non-null and the run is live,
   the dev process is still alive — yields `runStatus: 'running'`.
2. **Dead process path:** otherwise, load the session's last 3 assistant
   messages from disk and run the completion
   judge (**without git evidence** since the process is gone).
3. **Judge `done`:** commit & push + mark `done` — yields
   `runStatus: 'idle'` (auto-completed).
4. **Judge `in_progress` / `stuck` or no session:** yields `runStatus: 'dangling'`
   (keeps `in_progress`, but marked interrupted).

All side-effect access (runtime registry, disk transcripts, AI judge, git,
store) is injected so the logic is pure and
unit-testable. The reconcile auto-`done` is the explicit, documented exception
to RM-R9 for process death, covering both manual and automation-started runs
(RM-R18). On completion the server caches each derived `runStatus` (consumed
on later broadcasts) and pushes an intents refresh so every
connection sees the refreshed run-states and any auto-completes.

**Dead-session de-dup (perf).** The handler keeps a judged-sessions map
(intent id → the `lastDevSessionId` last judged while dead) and filters the
reconcile input: an intent whose **current dead session** is already recorded
is skipped — re-judging on every entry / refresh / WS reconnect yields the same
verdict at the cost of another LLM call. A live process (re-derived cheaply) and
a brand-new session id (differs from the record) still get
(re)judged. The entry is cleared when the intent leaves `in_progress`.

## List / Rename / Delete communication sessions

Three new WS handlers round out the session-collection CRUD:

- **`list_intent_sessions`**: reads the session list, derives a run-states snapshot
  (sessions with a live agent run are running, absent = idle), and replies `intent_sessions`
  on the same connection.
- **`rename_intent_session`**: renames the session, then broadcasts
  `intent_sessions` to all connections.
- **`delete_intent_session`**: removes the runtime (abort + drop the in-memory
  runtime), then deletes the session row (with `is_current` fallback).
  Clears the connection's viewed session if the deleted session was being watched, then broadcasts both
  `intent_sessions` and `session_status` to all connections.

All three check store availability first and return `error` on db-unavailable.

A fourth, read-only opener serves the intent detail's 「spec session」tab:

- **`open_spec_session`**: resolves the intent's stored `specSessionId`; if that `'spec'` runtime
  was dropped (process restart / GC) it is rebuilt from the transcript with writes re-confined to
  the spec directory (the parent of the intent's **absolute** centralized `specPath`) and the spec
  agent re-pinned, then replies
  `session_selected` and registers the viewer. The intent's own comm/refine session
  (`intentSessionId`) is opened by the existing `open_intent_chat` instead — the two sessions are
  different runtime kinds. Rejected (`error`) when the intent has no `specSessionId`.

## Broadcast

The intent-session broadcast follows the same pattern as the discussion broadcast:
it reads the session list, attaches a run-states snapshot derived from the
in-flight check, and fans out `{ type: 'intent_sessions', workspacePath, items, runStates }` to
every connection. It is wired into the shared kernel context so intent session handlers
and any background mutation can push the refreshed list.

- `list_intents` / `update_intent_status` read/write the store and reply `intents`.
- Dev back-link: the frontend sends `select_session` with `lastDevSessionId`; if the session no
  longer exists, the existing `error` path returns and the frontend offers a friendly
  restart/cancel exit (RM-R13).

## Hidden-set filtering

The workspace session listing filters out the project's hidden set so communication
sessions **and intent spec sessions** never enter the normal list (RM-R4) — both are gathered
into one hidden set at list-build time, using the resolved path so the keys match the stored
workspace path. The filter runs before pagination, so the page window and `hasMore` are computed
over the already-filtered list. If the store is unavailable it does **not** filter (degrade,
don't break the list) (RM-R12).

## Frontend

- **Entry button:** the session sidebar adds an idea (💡) button left of "＋ new session"
  emitting an open-intents event with the workspace path.
- **View switch:** the app gains a view mode (`console` | `intents`) + the intents project.
  Opening sends `open_intent_chat` (its response carries the list); selecting any normal
  session resets to `console`. The intent view renders no mode selector (RM-R3).
- **Title bar (RM-R3):** the dialog column reuses the session title bar with the mode selector
  hidden. The console tab keeps the mode selector shown. Title shows the active title or "New Intent".
- **New-intent button:** the "+" button lives in the intent list's header, to the
  right of the status filter. It emits a new-intent event → the app sends
  `new_intent_chat`; the resulting `session_selected` (empty history) clears the dialog so a
  fresh round starts.
- **Reconnect / refresh recovery:** each project's current communication session is persisted in
  the chat table's current flag, so entering the intent view auto-reloads it. On WS reopen,
  if the view mode is intents, re-send `open_intent_chat`; the view mode and intents project
  are also mirrored to local storage to survive a hard refresh. No new server message is needed —
  the existing resume branch suffices.
- **Layout:** left intent list (默认完整宽度 960px,窄屏 `min(960px,68vw)`;可在标题栏
  通过折叠按钮在展开/收缩两态间切换,折叠态是组件本地 UI 状态,收缩态宽度减半至 480px 并**不渲染**
  模块标签与操作区,展开态恢复;折叠态文案/可见性由一个纯函数决定)
  (header: title + an **automation** button [▶ / ■ stop,
  highlighted while running, red on error] + status filter, with a status line below showing the
  current item or the stop reason;
  **列表排序(纯客户端展示排序,服务端 `priority ASC, updated_at DESC`
  不变):**「全部」视图未完成项保持服务端原序置顶、已完成(`done`)项置底;置底段与「已完成」筛选整列均
  **按完成时间倒序、再优先级排序**——一个纯比较函数:`completedAt` 降序为
  主键(缺失时回退 `createdAt`),同完成时刻按 `priority` 升序 P0→P3;其它单状态筛选原样不重排;
  per row a `MM/DD` date prefix
  — `completedAt` for done items, else `createdAt`, both zero-padded — an optional **module tag**
  (胶囊标签,渲染于 date 与 title 之间;`module===''` 时不渲染,无占位不破版)
  before the title/priority badge/status (彩色 pill 徽标,按
  draft 灰 / todo 主色 / in_progress 橙 / done 绿 / cancelled 红映射语义色,风格同优先级徽标,
  收缩态不隐藏;标签文案来自一个纯函数)
  and a dependency hint;
  **展开详情(手风琴,至多一项展开):** 详情区复用安全 Markdown 渲染
  把 `content` 全文以 Markdown 安全渲染——
  详情显式走 Markdown 管线(markdown-it `html:false` → DOMPurify 清洗 → 注入),与聊天消息
  一致的 XSS 防护与外链加固(`target=_blank rel=noopener noreferrer`,剔除 `javascript:`/`data:`);
  套用同一排版样式,聊天既有行为不回归。
  下方元信息区显示次要元信息(小字号、灰色):
  创建时间 (完整格式 `YYYY-MM-DD HH:mm`)、
  完成时间(仅 `completedAt` 非空时显示,同完整格式)、
  依赖列表(无依赖时不显示;已完成依赖灰色、未完成依赖橙色并加 ⚠ 标记);
  时间与依赖格式化由纯函数完成;
  再下方仅当存在未完成依赖时显示简短警告;
  per-status actions: Refine + Launch-development for `todo`, Development-details
  for launched, mark done/cancel for any), then a **trailing automate toggle icon**
  (渲染于操作按钮排末尾、所有操作按钮之后;`automate` → ⏳ tooltip `in auto queue`,
  否则 ✋ tooltip `manual trigger mode`;因属于操作区,收缩态随操作区一并隐藏);
  right **reuses** the chat messages + session status bar +
  message input against the already-viewed communication session. The automate icon emits
  a set-automate event (toggles the flag); the button emits start/stop-automation.
- **Save confirmation:** the permission prompt adds a branch for the
  `save_intents` tool name, rendering each proposed item as a card
  (title/priority/dependency) with Save/Cancel mapped to allow/deny. Dependencies render on two
  lines: existing-id deps as "依赖:…" and intra-batch deps (`dependsOnIndexes`) as
  "依赖本批:#N「title」" — a helper resolves each 0-based index back to the
  sibling's title in the same proposed-intents array so the user sees the order relationship
  before allowing (RM-R17).
- **Intent data:** the app holds intents keyed by workspace path,
  refreshed by the `intents` message, and automation status keyed by workspace path,
  refreshed by the `automation_status` message; the intent list receives the current project's
  status as a prop.

## Dependencies

- **SQLite** — Node's built-in SQLite (Node) / Bun's built-in SQLite (Bun single binary); both
  marked external in the server bundle.
- **agent-session** — the intent-kind runtime and the shared launcher.
- **permission-gateway** — gates `save_intents` via the existing permission flow.
- **session-registry** — its list filter consumes this domain's hidden set.
- **git (local CLI)** — the orchestrator's commit/push on a verified `done`.
- **agent-session (one-shot)** — the completion judge runs a tool-less one-shot SDK query.
- **Claude Agent SDK** — appended-system-prompt preset, disallowed tools, in-process MCP server.
