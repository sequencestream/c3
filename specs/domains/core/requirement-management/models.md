# requirement-management — Models

Entity definitions. Business-semantic types; physical wiring (SQLite driver, schema migrations)
in [design.md](design.md). The wire shapes (`Requirement`, `ProposedRequirement`,
`RequirementPriority`, `RequirementStatus`) are defined once in `shared/src/protocol.ts` and
documented in the [shared protocol](../../../shared/api-conventions/websocket-protocol.md);
domain docs reference them rather than redefining message shapes.

## Requirement

A ledger item scoped to one project.

| Attribute          | Type                        | Description                                                                                                                                                |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | text (UUID)                 | Stable identifier; referenced by dependencies and the dev back-link                                                                                        |
| `projectPath`      | text (path)                 | Resolved absolute workspace path; the project key (RM-R1, RM-R10)                                                                                          |
| `title`            | text                        | Short requirement title                                                                                                                                    |
| `content`          | text                        | Full requirement description                                                                                                                               |
| `priority`         | enum `P0`\|`P1`\|`P2`\|`P3` | 需求级别; P0 highest                                                                                                                                       |
| `module`           | text                        | 模块名称 — the requirement's owning module, inferred by the communication agent from title/content; `''` when unidentified or for historical rows (RM-R14) |
| `status`           | enum `RequirementStatus`    | `draft`\|`todo`\|`in_progress`\|`done`\|`cancelled` (RM-R6, RM-R8, RM-R9)                                                                                  |
| `dependsOn`        | `id[]`                      | Intra-project requirement ids this item depends on (aggregated; RM-R1)                                                                                     |
| `lastDevSessionId` | text \| null                | The session id the last development run produced; back-link target (RM-R8/13)                                                                              |
| `automate`         | boolean                     | Whether the automation orchestrator may pick this item up; user-toggled, `false` by default (RM-A1)                                                        |
| `createdAt`        | timestamp                   | Creation time                                                                                                                                              |
| `updatedAt`        | timestamp                   | Last mutation time                                                                                                                                         |
| `completedAt`      | timestamp \| null           | When the requirement entered `done`; stamped on transition to `done`, cleared (null) whenever status leaves `done` (RM-R6/RM-R9)                           |

Relationships: belongs to one project (by `projectPath`); has zero or more Requirement
Dependencies; may reference one development Session (a normal session, owned by session-registry).

## Proposed Requirement

A single item inside a `save_requirements` call; also what the confirmation dialog renders. Not
yet persisted — it becomes a Requirement (status `todo`) only on confirmed save (RM-R5/RM-R6).

| Attribute          | Type                        | Description                                                                                                                                       |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`            | text                        | Proposed title                                                                                                                                    |
| `content`          | text                        | Proposed description                                                                                                                              |
| `priority`         | enum `P0`\|`P1`\|`P2`\|`P3` | Proposed 需求级别                                                                                                                                 |
| `module`           | text (optional)             | Inferred module name; omitted → persisted as `''` (RM-R14)                                                                                        |
| `dependsOn`        | `id[]` (optional)           | Proposed dependencies on **already-existing** intra-project requirements (by id)                                                                  |
| `dependsOnIndexes` | `number[]` (optional)       | Proposed dependencies on **sibling** items in the same batch, by 0-based array index; resolved to the sibling's minted id at insert time (RM-R17) |

## Requirement Dependency

A directed edge within one project.

| Attribute       | Type        | Description                   |
| --------------- | ----------- | ----------------------------- |
| `requirementId` | text (UUID) | The dependent requirement     |
| `dependsOnId`   | text (UUID) | The requirement it depends on |

Display + warning only: an item with any dependency not `done` shows a hint, and launching
development on it warns but is not blocked (RM-R11). No topological/cycle enforcement in v1
**for the persisted graph** — but a single `save_requirements` batch's intra-batch references
(`dependsOnIndexes`) are validated at insert time (out-of-range / self / cycle reject the whole
batch, RM-R17), since they are resolved to real ids before any row is written.

## Communication Session

The per-project hidden agent session used to refine requirements. A real SDK session (owned by
agent-session / session-registry); this domain only tracks which session is _current_ and which
ids form the project's hidden set.

| Attribute     | Type        | Description                                                               |
| ------------- | ----------- | ------------------------------------------------------------------------- |
| `sessionId`   | text        | The SDK session id (may be a `pending:` id before its first run binds it) |
| `projectPath` | text (path) | Resolved absolute workspace path (RM-R10)                                 |
| `isCurrent`   | boolean     | At most one per project is current (RM-R4)                                |
| `updatedAt`   | timestamp   | Last bind/use time                                                        |

Relationships: every row for a project forms that project's **hidden set** (excluded from
`list_sessions`, RM-R4); the one `isCurrent` row is the session re-loaded on entering the
requirement view. On its first run the `pending:` id is rebound to the real SDK id while keeping
`isCurrent` and hidden-set membership.

## Automation Status

The live state of a project's automation orchestrator (RM-A1–RM-A9). In-memory only (one per
project; not persisted — a server restart resets it to `idle`). Pushed to every connection as the
`automation_status` wire event.

| Attribute              | Type                   | Description                                                                                                                     |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `projectPath`          | text (path)            | Resolved absolute workspace path (RM-R10)                                                                                       |
| `state`                | enum `AutomationState` | `idle`\|`running`\|`done`\|`error` (RM-A2/A6/A7)                                                                                |
| `currentRequirementId` | id \| null             | The requirement being developed now (null when not running)                                                                     |
| `currentSessionId`     | text \| null           | The current requirement's dev session, for a back-link                                                                          |
| `awaitingPermission`   | boolean                | True while the current dev turn is paused on a permission prompt awaiting a human answer (RM-A9); cleared when the turn settles |
| `error`                | text \| null           | Why it stopped abnormally; null unless `state = error` (RM-A6/A7)                                                               |
| `completedIds`         | `id[]`                 | Requirement ids completed (committed + pushed) in this run                                                                      |
| `startedAt`            | timestamp \| null      | When the orchestrator was started; null when never started                                                                      |

## Persisted store (c3.db)

The SQLite ledger at `~/.c3/c3.db` (distinct from the registry's `state.json`). Schema version is
managed via `PRAGMA user_version` (currently `5` — v2 added the `requirements.module` column, v3
added the nullable `requirements.completed_at` column, v4 added `requirements.automate` INTEGER NOT
NULL DEFAULT 0, v5 added the `tool_sessions` table). Tables: `requirements`, `requirement_deps`,
`requirement_chats` (current-session map + hidden set in one table), and `tool_sessions`
(`session_id` PRIMARY KEY + `created_at`) — the persisted set of tool-created sessions (completion
judge, consensus advisor) so the session-registry's "show tool sessions" filter survives restarts.
A session's row is dropped when the session is deleted. See [design.md](design.md) for the
cross-runtime driver adapter and migration handling.
