# discussion — Design

The SQLite persistence layer for the [discussion](discussion-overview.md) domain. Lives in
`server/src/discussions/store.ts` over the shared adapter `server/src/db.ts`. Implements the
[models](models.md). **This is the persistence foundation only** — no agent, orchestration, wire
protocol, or frontend yet.

## Module split

| Concern               | File                              | Notes                                                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Shared SQLite adapter | `server/src/db.ts`                | Cross-runtime `node:sqlite` / `bun:sqlite` (ADR 0007); shared with requirement-management |
| Discussion store      | `server/src/discussions/store.ts` | Schema ownership + discussion/message CRUD                                                |

## SQLite layer (shared `db.ts`)

The discussion store reuses the shared adapter unchanged (see
[requirement-management design §SQLite layer](../requirement-management/design.md) and
[ADR 0007](../../../architecture/adr/0007-read-only-requirement-agent.md) for the full rationale):
one minimal **synchronous** interface (`exec`/`run`/`all`/`get`) selected by `globalThis.Bun`,
`?`-only placeholders, rows read by field, `~/.c3/c3.db`, WAL + `busy_timeout`, esbuild `external`
for both driver modules.

`db.ts` was promoted from `server/src/requirements/db.ts` to a neutral location precisely because it
is generic: the discussion store and the requirement store are **sibling domains** over one db, and
neither should depend on the other. Both ride the single c3.db connection; each owns its own tables
and a private `schemaReady` flag.

## Schema (`PRAGMA user_version` migrations)

Two tables, ensured lazily on the discussion store's first access via `exec(SCHEMA)`
(`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`):

- `discussions` — `id` (PK), `project_path`, `title`, `type`, `goal` (`TEXT NOT NULL DEFAULT ''`),
  `context` (`TEXT NOT NULL DEFAULT ''`), `status`, `conclusion` (nullable), `created_at`,
  `updated_at`, `completed_at` (nullable). Indexed by `idx_disc_project_status (project_path,
status)`.
- `discussion_messages` — `id` (PK), `discussion_id`, `seq`, `speaker_kind`, `speaker_agent_id`
  (nullable), `speaker_name` (nullable), `content`, `created_at`. Indexed by
  `idx_disc_msg_discussion (discussion_id, seq)` — the natural read path for `listMessages`.

**Schema version (current: v1).** `SCHEMA_VERSION = 1`, written via `PRAGMA user_version`. The
single c3.db `user_version` counter is **shared** with the requirement store, so the two clobber
each other on write — this is intentional and harmless: migrations key off **actual presence**
(`PRAGMA table_info` for columns, `CREATE TABLE IF NOT EXISTS` for tables), never off the version
number. The value is informational only.

**Idempotent migration (`ensureColumn`).** After `exec(SCHEMA)` and before writing `user_version`,
the store runs `ensureColumn` for the optional/nullable columns
(`goal`, `context`, `conclusion`, `completed_at`): each checks `PRAGMA table_info(discussions)` and
only runs `ALTER TABLE … ADD COLUMN` when the column is absent. This is a **defensive forward-compat
backfill** — a `discussions` table created by an earlier in-development build that predated these
columns is upgraded in place; on a fresh schema each call is a no-op, and the whole sequence is
idempotent across runs. Same key-off-column-presence paradigm as the requirement store's
`module`/`completed_at`/`automate` migrations. Both drivers support `PRAGMA table_info` /
`ALTER TABLE ADD COLUMN` through the shared `exec`/`all` surface.

**Fail-soft.** When `getDb()` returns null (open/create failure), reads return empty/null and
writes throw (`requireDb` → `Error('讨论库不可用')`) — c3 boots and runs without the discussion
feature, consistent with the requirement store's degradation contract.

## Store (`store.ts`)

- **Path normalization:** every `projectPath` arg (`listDiscussions`, `createDiscussion`) is
  `resolve()`d before read/write, matching the workspace key / runtime `workspacePath` / SDK `cwd`.
  Id-keyed operations (`getDiscussion`, `updateDiscussionStatus`, `setConclusion`, `appendMessage`,
  `listMessages`) take no `projectPath`.
- `listDiscussions(projectPath, status?)` → `Discussion[]`, `ORDER BY updated_at DESC` (optionally
  status-filtered).
- `getDiscussion(id)` → `Discussion | null`.
- `createDiscussion({ projectPath, title, type, goal?, context?, status? })` → `Discussion`. Mints a
  uuid, `created_at = updated_at = now`, default `status = 'draft'`; if created directly as
  `completed`, `completed_at` is stamped.
- `updateDiscussionStatus(id, status)` — updates status + `updated_at`; `completed_at = completed ?
now : null` (mirrors the requirement store's done-stamping rule, including clearing on revert).
- `setConclusion(id, conclusion)` — sets `conclusion` + bumps `updated_at`.
- `appendMessage({ discussionId, speakerKind, speakerAgentId?, speakerName?, content })` →
  `DiscussionMessage`. In **one transaction**: reads `COALESCE(MAX(seq),0)+1` for that discussion,
  inserts the message, and bumps the discussion's `updated_at`. The transaction makes the seq
  race-free under the single synchronous connection; `seq` is independent per discussion.
- `listMessages(discussionId)` → `DiscussionMessage[]`, `ORDER BY seq ASC`.
- `isStoreAvailable()` / `resetStoreForTests()` mirror the requirement store.

## Testing

`server/src/discussions/store.test.ts` (real temp-file db, `node:sqlite` branch): table + index
creation and `user_version`; CRUD (create defaults + explicit fields, list ordering [tie-safe
non-increasing `updatedAt`] + status filter + project scope + trailing-slash `resolve()`
normalization, `completed_at` stamp/clear, conclusion, real-file persistence across cache reset);
messages (monotonic per-discussion seq, seq independence across discussions, `updated_at` bump,
ordered list, nullable speaker fields → null); migration (old db with **no** discussion tables →
created; old `discussions` table with **only core columns** → `ensureColumn` backfills, historic
row survives, idempotent on re-ensure); fail-soft degradation (reads empty/null, write throws).

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts` (`node:sqlite` / `bun:sqlite`, both `external`).
- **shared protocol** — `Discussion` / `DiscussionMessage` / `DiscussionStatus` /
  `DiscussionSpeakerKind` entity types.
