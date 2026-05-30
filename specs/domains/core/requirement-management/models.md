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
| `createdAt`        | timestamp                   | Creation time                                                                                                                                              |
| `updatedAt`        | timestamp                   | Last mutation time                                                                                                                                         |
| `completedAt`      | timestamp \| null           | When the requirement entered `done`; stamped on transition to `done`, cleared (null) whenever status leaves `done` (RM-R6/RM-R9)                           |

Relationships: belongs to one project (by `projectPath`); has zero or more Requirement
Dependencies; may reference one development Session (a normal session, owned by session-registry).

## Proposed Requirement

A single item inside a `save_requirements` call; also what the confirmation dialog renders. Not
yet persisted — it becomes a Requirement (status `todo`) only on confirmed save (RM-R5/RM-R6).

| Attribute   | Type                        | Description                                                |
| ----------- | --------------------------- | ---------------------------------------------------------- |
| `title`     | text                        | Proposed title                                             |
| `content`   | text                        | Proposed description                                       |
| `priority`  | enum `P0`\|`P1`\|`P2`\|`P3` | Proposed 需求级别                                          |
| `module`    | text (optional)             | Inferred module name; omitted → persisted as `''` (RM-R14) |
| `dependsOn` | `id[]` (optional)           | Proposed intra-project dependencies                        |

## Requirement Dependency

A directed edge within one project.

| Attribute       | Type        | Description                   |
| --------------- | ----------- | ----------------------------- |
| `requirementId` | text (UUID) | The dependent requirement     |
| `dependsOnId`   | text (UUID) | The requirement it depends on |

Display + warning only: an item with any dependency not `done` shows a hint, and launching
development on it warns but is not blocked (RM-R11). No topological/cycle enforcement in v1.

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

## Persisted store (c3.db)

The SQLite ledger at `~/.c3/c3.db` (distinct from the registry's `state.json`). Schema version is
managed via `PRAGMA user_version` (currently `3` — v2 added the `requirements.module` column, v3 added the nullable `requirements.completed_at` column).
Tables: `requirements`, `requirement_deps`, and `requirement_chats` (current-session map + hidden
set in one table). See [design.md](design.md) for the cross-runtime driver adapter and migration
handling.
