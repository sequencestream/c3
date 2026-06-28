# intent-management — Models

Entity definitions in domain terms; physical wiring (SQLite driver, schema migrations)
in [intent-management-design.md](intent-management-design.md). The intent, proposed-intent, priority, and status wire shapes are
defined once in the [shared protocol](../../../shared/api-conventions/websocket-protocol.md);
domain docs reference them rather than redefining message shapes.

## Intent

A ledger item scoped to one project.

| Attribute          | Type                        | Description                                                                                                                                           |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | text (UUID)                 | Stable identifier; referenced by dependencies and the dev back-link                                                                                   |
| `workspacePath`    | text (path)                 | Resolved absolute workspace path; the project key (RM-R1, RM-R10)                                                                                     |
| `title`            | text                        | Short intent title                                                                                                                                    |
| `shortEnTitle`     | text \| null                | 简短英文 ASCII 短标题 — 派生 Git 分支名 / worktree 目录名的稳定来源；落库前截断到 128 字符；历史行为 `null`，仅在 refine 时补齐                       |
| `content`          | text                        | Full intent description                                                                                                                               |
| `priority`         | enum `P0`\|`P1`\|`P2`\|`P3` | 需求级别; P0 highest                                                                                                                                  |
| `module`           | text                        | 模块名称 — the intent's owning module, inferred by the communication agent from title/content; `''` when unidentified or for historical rows (RM-R14) |
| `status`           | enum                        | `draft`\|`todo`\|`in_progress`\|`done`\|`cancelled` (RM-R6, RM-R8, RM-R9)                                                                             |
| `dependsOn`        | `id[]`                      | Intra-project intent ids this item depends on (aggregated; RM-R1)                                                                                     |
| `lastDevSessionId` | text \| null                | The session id the last development run produced; back-link target (RM-R8/13)                                                                         |
| `automate`         | boolean                     | Whether the automation orchestrator may pick this item up; user-toggled, `false` by default (RM-A1)                                                   |
| `createdAt`        | timestamp                   | Creation time                                                                                                                                         |
| `updatedAt`        | timestamp                   | Last mutation time                                                                                                                                    |
| `completedAt`      | timestamp \| null           | When the intent entered `done`; stamped on transition to `done`, cleared (null) whenever status leaves `done` (RM-R6/RM-R9)                           |

Relationships: belongs to one project (by `workspacePath`); has zero or more Intent
Dependencies; may reference one development Session (a normal session, owned by session-registry).

## Proposed Intent

A single item inside a `save_intents` call; also what the confirmation dialog renders. Without
`id` it is not yet persisted — it becomes a Intent (status `todo`) only on confirmed save
(RM-R5/RM-R6). With `id` it is an **update** of that existing intent (upsert, RM-R20).

| Attribute          | Type                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `id` (optional)             | When set, update this **existing** same-project intent in place instead of inserting (upsert, RM-R20); the `refine_intent` flow fills it so a refined intent updates its original. Omit to insert a new intent.                                                                                                                                                                                                                                                                                                                 |
| `title`            | text                        | Proposed title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `shortEnTitle`     | text (required)             | 必填的简短英文 ASCII 短标题 — 派生分支/worktree 名的稳定来源；agent 应产出 ≤64 ASCII 字符，落库前截断到 128。新建与更新均要求传入                                                                                                                                                                                                                                                                                                                                                                                               |
| `content`          | text                        | Proposed description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `priority`         | enum `P0`\|`P1`\|`P2`\|`P3` | Proposed 需求级别                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `module`           | text (optional)             | Inferred module name; omitted → on insert persisted as `''` (RM-R14); on update keeps the prior value (RM-R20)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dependsOn`        | `id[]` (optional)           | Proposed dependencies on **already-existing** intra-project intents (by id); on update, supplying it (or `dependsOnIndexes`) replaces the dep set, omitting both keeps it (RM-R20)                                                                                                                                                                                                                                                                                                                                              |
| `dependsOnIndexes` | `number[]` (optional)       | Proposed dependencies on **sibling** items in the same batch, by 0-based array index; resolved to the sibling's id at save time (RM-R17). A sibling referenced by index may itself be an update target (RM-R20).                                                                                                                                                                                                                                                                                                                |
| `intentSessionId`  | text (optional)             | Back-link to the communication session that produced this intent, persisted to `intent_session_id`. **Only effective when the batch saves exactly one intent** — a multi-item batch ignores it (the store writes it only for `length === 1`). The agent fills it with the session id injected into its prompt; the save handler normalizes that to the bound comm-session id so it resolves via `open_intent_chat`. Covers the new-intent gap the refine `run:bound` backfill cannot reach. Absent from `save_intent_directly`. |

## Intent Dependency

A directed edge within one project.

| Attribute     | Type        | Description              |
| ------------- | ----------- | ------------------------ |
| `intentId`    | text (UUID) | The dependent intent     |
| `dependsOnId` | text (UUID) | The intent it depends on |

Display + warning only: an item with any dependency not `done` shows a hint, and launching
development on it warns but is not blocked (RM-R11). No topological/cycle enforcement in v1
**for the persisted graph** — but a single `save_intents` batch's intra-batch references
(`dependsOnIndexes`) are validated at insert time (out-of-range / self / cycle reject the whole
batch, RM-R17), since they are resolved to real ids before any row is written.

## Communication Session

The per-project hidden agent sessions used to refine intents. Each project holds a
**collection** of these sessions (multiple rows), all of which are hidden from the
normal `list_sessions` response. One session per project is marked `isCurrent` as
the default-open pointer when entering the intent view without an explicit session id.
Sessions can be listed, renamed, and deleted.

| Attribute       | Type         | Description                                                                                        |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `sessionId`     | text         | The SDK session id (may be a `pending:` id before its first run binds it)                          |
| `workspacePath` | text (path)  | Resolved absolute workspace path (RM-R10)                                                          |
| `title`         | text \| null | User-assigned title; null ⇒ client fallback to "New Intent" or first-prompt / timestamp derivation |
| `isCurrent`     | boolean      | Default-open pointer — at most one per project is current (RM-R4)                                  |
| `updatedAt`     | timestamp    | Last bind / rename / run time                                                                      |

Relationships: every row for a project forms that project's **hidden set** (excluded from
`list_sessions`, RM-R4); the `isCurrent` row is the session re-loaded on entering the
intent view without a specific `sessionId`. On its first run the `pending:` id is rebound
to the real vendor-native id while keeping `isCurrent` and hidden-set membership. Sessions may be
renamed or physically deleted (row + runtime removal, with `isCurrent` fallback to the most
recent remaining session). The session is also mirrored into `session_metadata` with
`session_kind='intent'`; refine/back-linked sessions carry `owner_kind='intent'` and this
intent's id so the unified Sessions page and WorkCenter can jump back without adding a
wire-level `jumpTarget`.

Spec-authoring sessions are linked by `intents.spec_session_id`, not by a separate spec table.
After a `write_spec` or `reset_spec_session` pending runtime binds to a real vendor session id,
the same session is projected into `session_metadata` with `session_kind='spec'`,
`owner_kind='intent'`, and `owner_id=<intent.id>`. Replacing the current spec session clears the
old projected owner so one intent exposes only the current spec entry as its jump-back target.
The intent ledger remains the SoT for the current spec session and approval state; the projection
is a rebuildable Sessions-page cache.

## Automation Status

The live state of a project's automation orchestrator (RM-A1–RM-A9). In-memory only (one per
project; not persisted — a server restart resets it to `idle`). Pushed to every connection as the
`automation_status` wire event.

| Attribute            | Type              | Description                                                                                                                     |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `workspacePath`      | text (path)       | Resolved absolute workspace path (RM-R10)                                                                                       |
| `state`              | enum              | `idle`\|`running`\|`done`\|`error` (RM-A2/A6/A7)                                                                                |
| `currentIntentId`    | id \| null        | The intent being developed now (null when not running)                                                                          |
| `currentSessionId`   | text \| null      | The current intent's dev session, for a back-link                                                                               |
| `awaitingPermission` | boolean           | True while the current dev turn is paused on a permission prompt awaiting a human answer (RM-A9); cleared when the turn settles |
| `error`              | text \| null      | Why it stopped abnormally; null unless `state = error` (RM-A6/A7)                                                               |
| `completedIds`       | `id[]`            | Intent ids completed (committed + pushed) in this run                                                                           |
| `startedAt`          | timestamp \| null | When the orchestrator was started; null when never started                                                                      |

## Persisted store (c3.db)

The SQLite ledger at `~/.c3/c3.db` (distinct from the registry's `state.json`). Schema version is
managed via `PRAGMA user_version` (currently `12` — v2 added the `intents.module` column, v3
added the nullable `intents.completed_at` column, v4 added `intents.automate` INTEGER NOT
NULL DEFAULT 0, v6 renamed legacy requirement- tables to intent-, v7 added the nullable
`intent_chats.title` column, v8 added git-tracking fields, v9 added `intent_deps.dep_type` +
`created_at`, v10 added the `intent_sessions` audit table, v11 renamed the workspace-key column
`project_path` → `workspace_path` in place on `intents` + `intent_chats` and rebuilt the composite
index as `idx_intent_workspace_status`, v12 added the nullable `intents.short_en_title` column (the
stable ASCII source for deriving branch / worktree names; historic rows stay null, the write side
truncates to 128). The rename deliberately diverges from the back-compat
`projectConfigs` settings.json key, which keeps its legacy name — see the 2026-06-14 workspace-path
migration record). Tables: `intents`, `intent_deps`, `intent_chats`
(session collection + hidden set in one table), and `tool_sessions`
(`session_id` PRIMARY KEY + `created_at`) — the persisted set of tool-created sessions (completion
judge, consensus advisor) so the session-registry's "show tool sessions" filter survives restarts.
A session's row is dropped when the session is deleted. See [intent-management-design.md](intent-management-design.md) for the
cross-runtime driver adapter and migration handling.

The cross-domain `session_metadata` projection lives outside the intent ledger's source-of-truth
tables. Intent writes upsert/delete projection rows for list/count reads, but intent content,
current-session selection, and hidden-set membership remain owned by `intent_chats`.
