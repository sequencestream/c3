/**
 * Intent-management domain store over {@link Db}.
 *
 * Owns the schema (created lazily, versioned via `PRAGMA user_version`) and all
 * intent / dependency / communication-session operations. Every
 * `workspacePath` is `resolve()`d so it matches the workspace registry key, the
 * runtime `workspacePath`, and the SDK `cwd` (otherwise lookups and the
 * hidden-session filter silently miss).
 *
 * Degradation: when the db is unavailable, reads return empty and writes throw
 * (callers surface an error or skip), so c3 keeps running without intents.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  DependencyInfo,
  DepType,
  IntentDevSession,
  IntentDevSessionExitCode,
  IntentSessionInfo,
  ProposedIntent,
  Intent,
  IntentPrStatus,
  IntentRunStatus,
  IntentStatus,
} from '@ccc/shared/protocol'
import { pathToId } from '../../state.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

const SCHEMA_VERSION = 14

/** Max persisted length of `short_en_title` (doc says VARCHAR(128); SQLite is TEXT). */
const SHORT_EN_TITLE_MAX = 128

/** Clamp a short English title to the persisted max length before writing. */
function truncateShortEnTitle(s: string): string {
  return s.length > SHORT_EN_TITLE_MAX ? s.slice(0, SHORT_EN_TITLE_MAX) : s
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  id              TEXT PRIMARY KEY,
  workspace_path    TEXT NOT NULL,
  title           TEXT NOT NULL,
  short_en_title  TEXT,
  content         TEXT NOT NULL,
  priority        TEXT NOT NULL,
  status          TEXT NOT NULL,
  module          TEXT NOT NULL DEFAULT '',
  last_dev_session_id TEXT,
  automate        INTEGER NOT NULL DEFAULT 0,
  branch_name     TEXT,
  latest_commit_hash TEXT,
  pr_id           TEXT,
  pr_status       TEXT,
  spec_path         TEXT,
  spec_approved     INTEGER NOT NULL DEFAULT 0,
  spec_approve_user TEXT,
  spec_session_id   TEXT,
  intent_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);

CREATE TABLE IF NOT EXISTS intent_deps (
  intent_id       TEXT NOT NULL,
  depends_on_id   TEXT NOT NULL,
  dep_type        TEXT NOT NULL DEFAULT 'blocks' CHECK(dep_type IN ('blocks','informs','soft_after')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (intent_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS intent_chats (
  session_id    TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  is_current    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_project ON intent_chats(workspace_path);

CREATE TABLE IF NOT EXISTS tool_sessions (
  session_id    TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  vendor        TEXT NOT NULL,
  summary       TEXT,
  start_at      INTEGER,
  end_at        INTEGER,
  exit_code     TEXT CHECK(exit_code IN ('success','failure','cancelled')),
  agent_id      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_session_intent ON intent_sessions(intent_id);
`

let schemaReady = false

/**
 * Idempotently add a column to an existing table when it's missing. Used for
 * backward-compatible migrations: a fresh db already has the column via SCHEMA,
 * so we check `PRAGMA table_info` rather than relying on `user_version` history.
 * Works on both `node:sqlite` and `bun:sqlite` (only `exec`/`all`).
 */
function ensureColumn(d: Db, table: string, col: string, decl: string): void {
  const cols = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
}

function tableExists(d: Db, name: string): boolean {
  return !!d.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name)
}

function columnExists(d: Db, table: string, col: string): boolean {
  return d.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === col)
}

function indexExists(d: Db, name: string): boolean {
  return !!d.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", name)
}

/**
 * v5 → v6: rename the LEGACY `requirement*` tables / column / index to `intent*`
 * IN PLACE (zero data movement — the product renamed the concept "requirement" to
 * "intent"). The `requirement*` string literals below are the v5 ON-DISK names of
 * legacy databases; they MUST stay literal to be detected and migrated, so they are
 * exempt from the requirements→intents source rename (the one place old names live).
 *
 * MUST run BEFORE `exec(SCHEMA)`: SCHEMA now declares `CREATE TABLE IF NOT EXISTS
 * intents …`, so running it first on a legacy db would create an EMPTY `intents`
 * and strand the data under `requirements` (the later RENAME would then no-op).
 *
 * Idempotent and re-entrant on a PARTIAL-migration db: every step is independently
 * guarded via `sqlite_master` / `PRAGMA table_info`, so a db interrupted mid-rename
 * converges to the `intent*` terminal state on any re-run. Per the project DB
 * migration discipline, this NEVER drops a table — table renames use `ALTER … RENAME
 * TO`; the index rename uses `DROP INDEX` (an index, not a table) and lets SCHEMA's
 * `CREATE INDEX IF NOT EXISTS` rebuild it. Rollback is forward-fix only.
 */
function migrateLegacyTablesToIntents(d: Db): void {
  // Tables: rename only when the legacy name exists and the new one doesn't yet.
  if (tableExists(d, 'requirements') && !tableExists(d, 'intents')) {
    d.exec('ALTER TABLE requirements RENAME TO intents')
  }
  if (tableExists(d, 'requirement_deps') && !tableExists(d, 'intent_deps')) {
    d.exec('ALTER TABLE requirement_deps RENAME TO intent_deps')
  }
  if (tableExists(d, 'requirement_chats') && !tableExists(d, 'intent_chats')) {
    d.exec('ALTER TABLE requirement_chats RENAME TO intent_chats')
  }
  // Column: the lone legacy-named column lives on (the now-renamed) intent_deps.
  if (tableExists(d, 'intent_deps') && columnExists(d, 'intent_deps', 'requirement_id')) {
    d.exec('ALTER TABLE intent_deps RENAME COLUMN requirement_id TO intent_id')
  }
  // Index: SQLite has no RENAME INDEX — drop the old (the table rename re-pointed it
  // at `intents`) and let SCHEMA recreate `idx_intent_workspace_status`.
  if (indexExists(d, 'idx_req_project_status')) {
    d.exec('DROP INDEX idx_req_project_status')
  }
}

/**
 * v10 → v11: rename the workspace-key column `project_path` → `workspace_path` IN
 * PLACE on `intents` and `intent_chats` (zero data movement — the product renamed
 * the term "project" to "workspace" at the DB layer). DELIBERATELY DIVERGES from the
 * `projectConfigs` settings.json key, which keeps its legacy name for back-compat —
 * here the user chose to rename the DB columns through; see the 012 migration record.
 *
 * MUST run BEFORE `exec(SCHEMA)`: SCHEMA now declares `workspace_path` and the index
 * `idx_intent_workspace_status` on it, so creating the index before the rename would
 * reference a missing column. Order in db(): legacy rename → THIS → exec(SCHEMA).
 *
 * Idempotent + re-entrant: every step guards on `PRAGMA table_info` / `sqlite_master`,
 * so a db interrupted mid-rename converges on re-run. NEVER drops a table — columns use
 * `ALTER … RENAME COLUMN`; the composite index uses `DROP INDEX` (an index, not a table)
 * and lets SCHEMA's `CREATE INDEX IF NOT EXISTS` rebuild it under the new name. The
 * single-column `idx_chat_project` keeps its name — SQLite's RENAME COLUMN auto-updates
 * its column reference, so no drop/rebuild is needed.
 */
function migrateProjectPathToWorkspacePath(d: Db): void {
  for (const table of ['intents', 'intent_chats']) {
    if (
      tableExists(d, table) &&
      columnExists(d, table, 'project_path') &&
      !columnExists(d, table, 'workspace_path')
    ) {
      d.exec(`ALTER TABLE ${table} RENAME COLUMN project_path TO workspace_path`)
    }
  }
  // Composite index renamed (project_status → workspace_status): drop old, SCHEMA rebuilds.
  if (indexExists(d, 'idx_intent_project_status')) {
    d.exec('DROP INDEX idx_intent_project_status')
  }
}

/** Return the db with the schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    // v5 → v6 rename MUST precede SCHEMA (see migrateLegacyTablesToIntents docstring).
    migrateLegacyTablesToIntents(d)
    // v10 → v11 project_path → workspace_path; MUST also precede SCHEMA (see docstring).
    migrateProjectPathToWorkspacePath(d)
    d.exec(SCHEMA)
    // v1 → v2: add `module` to pre-existing intents tables (historic rows default to '').
    ensureColumn(d, 'intents', 'module', "TEXT NOT NULL DEFAULT ''")
    // v2 → v3: add nullable `completed_at` (historic rows stay null until re-marked done).
    ensureColumn(d, 'intents', 'completed_at', 'INTEGER')
    // v3 → v4: add `automate` (historic rows default to 0 — opt-in to automation).
    ensureColumn(d, 'intents', 'automate', 'INTEGER NOT NULL DEFAULT 0')
    // v7 → v8: add git tracking fields (nullable — historic rows stay null).
    ensureColumn(d, 'intents', 'branch_name', 'TEXT')
    ensureColumn(d, 'intents', 'latest_commit_hash', 'TEXT')
    ensureColumn(d, 'intents', 'pr_id', 'TEXT')
    ensureColumn(d, 'intents', 'pr_status', 'TEXT')
    // v6 → v7: add `title` to intent_chats (nullable — fallback to 'New Intent' or first-prompt derivation on the client).
    ensureColumn(d, 'intent_chats', 'title', 'TEXT')
    // v8 → v9: add dep_type + created_at to intent_deps (historic rows get defaults 'blocks' / 0).
    ensureColumn(d, 'intent_deps', 'dep_type', "TEXT NOT NULL DEFAULT 'blocks'")
    ensureColumn(d, 'intent_deps', 'created_at', 'INTEGER NOT NULL DEFAULT 0')
    // v11 → v12: add short_en_title (nullable — historic rows stay null until refined; used as the
    // stable ASCII source for deriving branch / worktree names).
    ensureColumn(d, 'intents', 'short_en_title', 'TEXT')
    // v12 → v13: add spec quality-gate + session fields (nullable, except spec_approved which
    // defaults 0). Persisted so approval state, spec path, and the spec/refine session ids
    // survive reconnect / refresh. Historic rows: spec_approved=0, the rest null.
    ensureColumn(d, 'intents', 'spec_path', 'TEXT')
    ensureColumn(d, 'intents', 'spec_approved', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(d, 'intents', 'spec_approve_user', 'TEXT')
    ensureColumn(d, 'intents', 'spec_session_id', 'TEXT')
    ensureColumn(d, 'intents', 'intent_session_id', 'TEXT')
    // v13 → v14: add pr_url (clickable PR link; nullable — historic rows stay null).
    // Distinct from latest_commit_hash; carries the PR's web URL alongside pr_id.
    ensureColumn(d, 'intents', 'pr_url', 'TEXT')
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('需求库不可用 (c3.db unavailable)')
  return d
}

/** Whether the store can be used (db opened). */
export function isStoreAvailable(): boolean {
  return isDbAvailable()
}

/** Test-only: forget the "schema ensured" flag (pair with `resetDbForTests`). */
export function resetStoreForTests(): void {
  schemaReady = false
}

function tx<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw err
  }
}

interface Row {
  id: string
  workspace_path: string
  title: string
  short_en_title: string | null
  content: string
  priority: string
  status: string
  module: string
  last_dev_session_id: string | null
  automate: number
  branch_name: string | null
  latest_commit_hash: string | null
  pr_id: string | null
  pr_url: string | null
  pr_status: string | null
  spec_path: string | null
  spec_approved: number
  spec_approve_user: string | null
  spec_session_id: string | null
  intent_session_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

/** Attach `dependsOn` and `dependsOnTypes` to a set of rows in one deps query, preserving row order. */
function hydrate(d: Db, rows: Row[]): Intent[] {
  if (rows.length === 0) return []
  const byId = new Map<string, string[]>()
  const typesById = new Map<string, Record<string, DepType>>()
  for (const r of rows) {
    byId.set(r.id, [])
    typesById.set(r.id, {})
  }
  const placeholders = rows.map(() => '?').join(',')
  const deps = d.all<{ intent_id: string; depends_on_id: string; dep_type: string }>(
    `SELECT intent_id, depends_on_id, dep_type FROM intent_deps WHERE intent_id IN (${placeholders})`,
    ...rows.map((r) => r.id),
  )
  for (const dep of deps) {
    byId.get(dep.intent_id)?.push(dep.depends_on_id)
    const types = typesById.get(dep.intent_id)
    if (types) types[dep.depends_on_id] = dep.dep_type as DepType
  }
  return rows.map((r) => ({
    id: r.id,
    workspaceId: pathToId(r.workspace_path)!,
    title: r.title,
    shortEnTitle: r.short_en_title,
    content: r.content,
    priority: r.priority as Intent['priority'],
    module: r.module,
    status: r.status as IntentStatus,
    dependsOn: byId.get(r.id) ?? [],
    dependsOnTypes: typesById.get(r.id) ?? {},
    lastDevSessionId: r.last_dev_session_id,
    automate: r.automate === 1,
    branchName: r.branch_name,
    latestCommitHash: r.latest_commit_hash,
    prId: r.pr_id,
    prUrl: r.pr_url,
    prStatus: (r.pr_status ?? null) as IntentPrStatus | null,
    specPath: r.spec_path,
    specApproved: r.spec_approved === 1,
    specApproveUser: r.spec_approve_user,
    specSessionId: r.spec_session_id,
    intentSessionId: r.intent_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    runStatus: 'idle' as IntentRunStatus,
  }))
}

// ---- Intents ----

/** A project's intents (optionally status-filtered), priority then recency. */
export function listIntents(workspacePath: string, status?: IntentStatus): Intent[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  const rows = status
    ? d.all<Row>(
        'SELECT * FROM intents WHERE workspace_path=? AND status=? ORDER BY priority ASC, updated_at DESC',
        proj,
        status,
      )
    : d.all<Row>(
        'SELECT * FROM intents WHERE workspace_path=? ORDER BY priority ASC, updated_at DESC',
        proj,
      )
  return hydrate(d, rows)
}

/**
 * Status → count for a project's intents, optionally restricted to rows whose
 * `updated_at` falls in `[startTime, endTime]` (ms epoch; either bound may be
 * omitted). Statuses with no matching rows are absent from the map. Returns an
 * empty map when the db is unavailable (graceful degradation, never throws).
 */
export function countByStatusInRange(
  workspacePath: string,
  startTime?: number,
  endTime?: number,
): Record<string, number> {
  const d = db()
  if (!d) return {}
  const where: string[] = ['workspace_path=?']
  const params: (string | number)[] = [resolve(workspacePath)]
  if (startTime != null) {
    where.push('updated_at >= ?')
    params.push(startTime)
  }
  if (endTime != null) {
    where.push('updated_at <= ?')
    params.push(endTime)
  }
  const rows = d.all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM intents WHERE ${where.join(' AND ')} GROUP BY status`,
    ...params,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status] = r.count
  return out
}

export function getIntent(id: string): Intent | null {
  const d = db()
  if (!d) return null
  const row = d.get<Row>('SELECT * FROM intents WHERE id=?', id)
  return row ? hydrate(d, [row])[0] : null
}

/** Escape LIKE wildcards so a keyword matches literally (paired with `ESCAPE '\'`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Search a project's intents for the read-only intent agent's
 * `find_intents` tool. Filters compose with AND; all are optional:
 *  - `keyword` — case-handled LIKE substring over `title` OR `content` (wildcards escaped).
 *  - `module` / `status` — exact-match column filters.
 * Same `(workspace_path)` scoping + `resolve()` as the rest of the store, so the
 * agent can never read another project's ledger. Ordered like `listIntents`
 * (priority asc, then recency). Returns `[]` when the db is unavailable.
 */
export function findIntents(
  workspacePath: string,
  filter: { keyword?: string; module?: string; status?: IntentStatus } = {},
): Intent[] {
  const d = db()
  if (!d) return []
  const where: string[] = ['workspace_path=?']
  const params: (string | number)[] = [resolve(workspacePath)]
  if (filter.keyword) {
    where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(filter.keyword)}%`
    params.push(like, like)
  }
  if (filter.module) {
    where.push('module=?')
    params.push(filter.module)
  }
  if (filter.status) {
    where.push('status=?')
    params.push(filter.status)
  }
  const rows = d.all<Row>(
    `SELECT * FROM intents WHERE ${where.join(' AND ')} ORDER BY priority ASC, updated_at DESC`,
    ...params,
  )
  return hydrate(d, rows)
}

/**
 * Resolve each item's effective dependency-id list for a batch insert (RM-R17),
 * given the ids freshly minted for the SAME batch (`ids[i]` belongs to `items[i]`).
 *
 * Two sources are merged & de-duplicated per item:
 *  - `dependsOn` — ids of intents that already exist in the ledger (unchanged).
 *  - `dependsOnIndexes` — 0-based indexes into THIS batch, resolved to the sibling's
 *    `ids[index]`. Lets a batch express its own先后关系 before any row has an id.
 *
 * Pure (items + ids in, id-lists out) so the validation is unit-testable without a
 * db. Throws — rejecting the WHOLE batch — when an index reference is out of range,
 * points at itself, or forms a cycle among the batch's intra-batch edges (existing-id
 * deps can't form a cycle with brand-new rows, so only index edges are checked).
 */
export function resolveBatchDependencies(
  items: Pick<ProposedIntent, 'dependsOn' | 'dependsOnIndexes'>[],
  ids: string[],
): string[][] {
  const n = items.length
  // Validate index references and collect the intra-batch edge list per item.
  const idxEdges: number[][] = items.map((it, i) => {
    const refs = it.dependsOnIndexes ?? []
    for (const j of refs) {
      if (!Number.isInteger(j) || j < 0 || j >= n) {
        throw new Error(`批内依赖下标越界:第 ${i} 条引用了不存在的下标 ${j}(有效范围 0..${n - 1})`)
      }
      if (j === i) {
        throw new Error(`批内依赖不能自引用:第 ${i} 条依赖了自身`)
      }
    }
    return refs
  })
  detectBatchCycle(idxEdges)
  // Merge existing-id deps with the resolved sibling ids, de-duplicated.
  return items.map((it, i) => {
    const merged = new Set<string>(it.dependsOn ?? [])
    for (const j of idxEdges[i]) merged.add(ids[j])
    return [...merged]
  })
}

/** Throw if the intra-batch index edges contain a cycle (3-colour DFS). */
function detectBatchCycle(edges: number[][]): void {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colour = new Array<number>(edges.length).fill(WHITE)
  const visit = (n: number): void => {
    colour[n] = GRAY
    for (const m of edges[n]) {
      if (colour[m] === GRAY) {
        throw new Error(`批内依赖成环:第 ${n} 条与第 ${m} 条互相依赖`)
      }
      if (colour[m] === WHITE) visit(m)
    }
    colour[n] = BLACK
  }
  for (let i = 0; i < edges.length; i++) {
    if (colour[i] === WHITE) visit(i)
  }
}

/** Insert a batch of proposed intents (status `todo`) in one transaction. */
export function insertIntents(workspacePath: string, items: ProposedIntent[]): Intent[] {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  // Mint every id up front so intra-batch `dependsOnIndexes` can resolve to a real
  // sibling id; validate + resolve BEFORE any write so an invalid batch (out-of-range
  // / self / cyclic) rejects atomically with nothing persisted (RM-R17).
  const ids: string[] = items.map(() => randomUUID())
  const deps = resolveBatchDependencies(items, ids)
  tx(d, () => {
    items.forEach((it, i) => {
      // Stagger created_at by batch index so same-priority, dependency-free items keep
      // a stable, submission-order rank in the orchestrator's `createdAt` tiebreak —
      // a single shared `now` left them arbitrarily ordered (RM-A3).
      const createdAt = now + i
      d.run(
        `INSERT INTO intents
           (id, workspace_path, title, short_en_title, content, priority, status, module, last_dev_session_id, created_at, updated_at, completed_at, branch_name, latest_commit_hash, pr_id, pr_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ids[i],
        proj,
        it.title,
        truncateShortEnTitle(it.shortEnTitle),
        it.content,
        it.priority,
        'todo',
        it.module ?? '',
        null,
        createdAt,
        createdAt,
        null,
        null,
        null,
        null,
        null,
      )
      for (const dep of deps[i]) {
        d.run(
          'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
          ids[i],
          dep,
          'blocks',
          createdAt,
        )
      }
    })
  })
  // Re-read so callers get fully-hydrated rows (incl. dependsOn).
  const placeholders = ids.map(() => '?').join(',')
  const rows = d.all<Row>(`SELECT * FROM intents WHERE id IN (${placeholders})`, ...ids)
  // Preserve insertion order.
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return hydrate(d, rows)
}

/**
 * Upsert a batch of proposed intents in ONE transaction (RM-R18).
 *
 * Each item is an INSERT (no `id`) or an UPDATE (carries `id`). All validation runs
 * BEFORE any write so the whole batch is atomic — any failure rejects it with nothing
 * persisted:
 *  - an UPDATE `id` must resolve to an intent in THIS project (else throw);
 *  - an UPDATE target in `in_progress` or `done` is immutable → throw (caller surfaces
 *    a "正在开发 / 已完成,不可修改" message);
 *  - `dependsOnIndexes` out-of-range / self / cyclic → throw (resolveBatchDependencies).
 *
 * Status rules on UPDATE: `draft`/`todo` keep their status; `cancelled` is reactivated
 * to `todo` (completed_at stays null per the updateStatus rule). New rows insert as
 * `todo`. Un-supplied optional fields are preserved: `module` keeps its prior value when
 * omitted, and deps are only rewritten when `dependsOn`/`dependsOnIndexes` is supplied.
 * `dependsOnIndexes` resolves against the FULL batch, so a new item can depend (by index)
 * on an updated sibling and vice-versa.
 */
export function upsertIntents(workspacePath: string, items: ProposedIntent[]): Intent[] {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  // Resolve every item to a stable id up front: the existing id for updates, a fresh
  // uuid for inserts. dependsOnIndexes then resolves against THIS id array regardless of
  // whether the referenced sibling is brand-new or being updated.
  const ids: string[] = items.map((it) => it.id ?? randomUUID())
  // Pre-validate UPDATE targets (existence + project binding + status lock) BEFORE
  // resolving deps, so an immutable / foreign / unknown id rejects the batch atomically.
  const priors = items.map((it) => {
    if (it.id === undefined) return null
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', it.id)
    if (!row || row.workspace_path !== proj) {
      throw new Error(`无法更新意图 ${it.id}:它在本项目中不存在`)
    }
    if (row.status === 'in_progress' || row.status === 'done') {
      const why = row.status === 'in_progress' ? '正在开发' : '已完成'
      throw new Error(`意图 ${it.id}(${row.title})${why},不可修改`)
    }
    return row
  })
  // Validate + resolve intra-batch deps (out-of-range / self / cyclic throws here).
  const deps = resolveBatchDependencies(items, ids)
  tx(d, () => {
    items.forEach((it, i) => {
      const prior = priors[i]
      // Whether this item supplied its dependency set; only then do we rewrite deps.
      const depsSupplied = it.dependsOn !== undefined || it.dependsOnIndexes !== undefined
      if (prior) {
        // UPDATE: cancelled → todo (reactivate); else keep status. Neither outcome is
        // `done`, so completed_at is always cleared to null.
        const status: IntentStatus =
          prior.status === 'cancelled' ? 'todo' : (prior.status as IntentStatus)
        const module = it.module !== undefined ? it.module : prior.module
        d.run(
          `UPDATE intents
             SET title=?, short_en_title=?, content=?, priority=?, module=?, status=?, updated_at=?, completed_at=?
           WHERE id=?`,
          it.title,
          truncateShortEnTitle(it.shortEnTitle),
          it.content,
          it.priority,
          module,
          status,
          now,
          null,
          ids[i],
        )
        if (depsSupplied) {
          d.run('DELETE FROM intent_deps WHERE intent_id=?', ids[i])
          for (const dep of deps[i]) {
            d.run(
              'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
              ids[i],
              dep,
              'blocks',
              now,
            )
          }
        }
      } else {
        // INSERT: stagger created_at by batch index for a stable submission-order rank.
        const createdAt = now + i
        d.run(
          `INSERT INTO intents
             (id, workspace_path, title, short_en_title, content, priority, status, module, last_dev_session_id, created_at, updated_at, completed_at, branch_name, latest_commit_hash, pr_id, pr_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ids[i],
          proj,
          it.title,
          truncateShortEnTitle(it.shortEnTitle),
          it.content,
          it.priority,
          'todo',
          it.module ?? '',
          null,
          createdAt,
          createdAt,
          null,
          null,
          null,
          null,
          null,
        )
        for (const dep of deps[i]) {
          d.run(
            'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
            ids[i],
            dep,
            'blocks',
            createdAt,
          )
        }
      }
    })
  })
  // Re-read so callers get fully-hydrated rows (incl. dependsOn), in batch order.
  const placeholders = ids.map(() => '?').join(',')
  const rows = d.all<Row>(`SELECT * FROM intents WHERE id IN (${placeholders})`, ...ids)
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return hydrate(d, rows)
}

/**
 * Guard: is the `from → to` status transition legal?
 *
 * Transition graph (7-state):
 * ```
 * draft ──→ todo ──→ in_progress ──→ failed ──→ todo
 *   │         │            │            │
 *   │         │            └──→ blocked ──→ todo
 *   │         │                 │
 *   │         └──→ cancelled    └──→ cancelled
 *   │
 *   └──→ blocked
 *   └──→ cancelled
 *
 *              in_progress ──→ done
 * ```
 * Terminal states (`done`, `cancelled`) have no outgoing edges.
 * Same-state transitions are always allowed (no-op).
 */
export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  if (from === to) return true
  const ALLOWED: Record<IntentStatus, readonly IntentStatus[]> = {
    draft: ['todo', 'cancelled', 'blocked'],
    todo: ['in_progress', 'cancelled', 'blocked'],
    in_progress: ['done', 'cancelled', 'blocked', 'failed'],
    done: [],
    cancelled: [],
    blocked: ['todo', 'cancelled'],
    failed: ['todo', 'cancelled'],
  }
  return (ALLOWED[from] as readonly IntentStatus[]).includes(to)
}

export function updateStatus(id: string, status: IntentStatus): void {
  const d = requireDb()
  const now = Date.now()
  // `done` stamps the completion time; any other status clears it (covers reverting from done).
  const completedAt = status === 'done' ? now : null
  d.run(
    'UPDATE intents SET status=?, updated_at=?, completed_at=? WHERE id=?',
    status,
    now,
    completedAt,
    id,
  )
}

/** Toggle a intent's automation flag (whether the orchestrator may pick it). */
export function setAutomate(id: string, automate: boolean): void {
  const d = requireDb()
  d.run('UPDATE intents SET automate=?, updated_at=? WHERE id=?', automate ? 1 : 0, Date.now(), id)
}

export function setLastDevSession(id: string, sessionId: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET last_dev_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/** Set the git branch name for an intent (called after dev session launch). */
export function setBranchName(id: string, branchName: string): void {
  const d = requireDb()
  d.run('UPDATE intents SET branch_name=?, updated_at=? WHERE id=?', branchName, Date.now(), id)
}

/** Set the latest known commit hash for an intent's dev branch. */
export function setLatestCommitHash(id: string, commitHash: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET latest_commit_hash=?, updated_at=? WHERE id=?',
    commitHash,
    Date.now(),
    id,
  )
}

/**
 * Set PR id, status, and clickable URL for an intent (called after PR creation).
 * `prUrl` is optional so existing callers that only know the id keep working; when
 * omitted the URL column is left null. The three move together (set on PR create).
 */
export function setPrInfo(
  id: string,
  prId: string,
  prStatus: IntentPrStatus,
  prUrl: string | null = null,
): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET pr_id=?, pr_status=?, pr_url=?, updated_at=? WHERE id=?',
    prId,
    prStatus,
    prUrl,
    Date.now(),
    id,
  )
}

/** Set the written spec document path for an intent (relative to the workspace). */
export function setSpecPath(id: string, specPath: string): void {
  const d = requireDb()
  d.run('UPDATE intents SET spec_path=?, updated_at=? WHERE id=?', specPath, Date.now(), id)
}

/**
 * Set the spec approval checkpoint state. `approved` and `approveUser` move
 * together (like `setPrInfo`): on approval pass the approving user; on un-approval
 * pass `approved=false` and `approveUser=null` to clear the recorded approver.
 */
export function setSpecApproved(id: string, approved: boolean, approveUser: string | null): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET spec_approved=?, spec_approve_user=?, updated_at=? WHERE id=?',
    approved ? 1 : 0,
    approveUser,
    Date.now(),
    id,
  )
}

/** Set the spec-authoring session id (c3SessionId) for an intent. */
export function setSpecSessionId(id: string, sessionId: string): void {
  const d = requireDb()
  d.run('UPDATE intents SET spec_session_id=?, updated_at=? WHERE id=?', sessionId, Date.now(), id)
}

/** Set the refine / communication session id (c3SessionId) for an intent. */
export function setIntentSessionId(id: string, sessionId: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET intent_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/** Patch editable fields; `dependsOn`, when present, replaces the dependency set. */
export function updateIntent(
  id: string,
  patch: Partial<Pick<Intent, 'title' | 'content' | 'priority' | 'status' | 'dependsOn'>> & {
    /** Dep types keyed by depended-on intent id. Only meaningful together with `dependsOn`; absent entries default to `'blocks'`. */
    depTypes?: Record<string, DepType>
  },
): void {
  const d = requireDb()
  tx(d, () => {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.title !== undefined) {
      sets.push('title=?')
      params.push(patch.title)
    }
    if (patch.content !== undefined) {
      sets.push('content=?')
      params.push(patch.content)
    }
    if (patch.priority !== undefined) {
      sets.push('priority=?')
      params.push(patch.priority)
    }
    if (patch.status !== undefined) {
      sets.push('status=?')
      params.push(patch.status)
      // Keep completed_at in sync with status, same rule as updateStatus.
      sets.push('completed_at=?')
      params.push(patch.status === 'done' ? Date.now() : null)
    }
    if (sets.length > 0) {
      sets.push('updated_at=?')
      params.push(Date.now())
      params.push(id)
      d.run(`UPDATE intents SET ${sets.join(', ')} WHERE id=?`, ...params)
    }
    if (patch.dependsOn !== undefined) {
      d.run('DELETE FROM intent_deps WHERE intent_id=?', id)
      const now = Date.now()
      const types = patch.depTypes ?? {}
      for (const dep of patch.dependsOn) {
        const depType = types[dep] ?? 'blocks'
        d.run(
          'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
          id,
          dep,
          depType,
          now,
        )
      }
    }
  })
}

// ---- Intent dependency management ----

/** Return all dependencies for an intent, with type metadata. */
export function listDependencies(intentId: string): DependencyInfo[] {
  const d = db()
  if (!d) return []
  return d
    .all<{
      depends_on_id: string
      dep_type: string
      created_at: number
    }>(
      'SELECT depends_on_id, dep_type, created_at FROM intent_deps WHERE intent_id=? ORDER BY created_at ASC',
      intentId,
    )
    .map((r) => ({
      dependsOnId: r.depends_on_id,
      depType: r.dep_type as DepType,
      createdAt: r.created_at,
    }))
}

/** Insert a single dependency edge. dep_type defaults to 'blocks'. */
export function insertDependency(
  intentId: string,
  dependsOnId: string,
  depType: DepType = 'blocks',
): void {
  const d = requireDb()
  d.run(
    'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
    intentId,
    dependsOnId,
    depType,
    Date.now(),
  )
}

/**
 * Replace all dependencies for an intent with dep_type per edge.
 * Previous edges are deleted first. Each edge specifies its dep_type,
 * so callers can mix blocks / informs / soft_after in one call.
 */
export function updateIntentDeps(
  intentId: string,
  deps: { dependsOnId: string; depType: DepType }[],
): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM intent_deps WHERE intent_id=?', intentId)
    const now = Date.now()
    for (const dep of deps) {
      d.run(
        'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
        intentId,
        dep.dependsOnId,
        dep.depType,
        now,
      )
    }
  })
}

// ---- Communication session mapping / hidden set ----
// `intent_chats` doubles as the per-project "current comm session" map and
// the hidden-session set (every row is hidden from the normal session list).

/** The current comm session id for a project, or null. */
export function getChatSession(workspacePath: string): string | null {
  const d = db()
  if (!d) return null
  const row = d.get<{ session_id: string }>(
    'SELECT session_id FROM intent_chats WHERE workspace_path=? AND is_current=1',
    resolve(workspacePath),
  )
  return row?.session_id ?? null
}

/** Make `sessionId` the project's current comm session (clearing any prior one). */
export function setChatSession(workspacePath: string, sessionId: string, title?: string): void {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  tx(d, () => {
    d.run('UPDATE intent_chats SET is_current=0 WHERE workspace_path=? AND is_current=1', proj)
    if (title !== undefined) {
      d.run(
        `INSERT INTO intent_chats (session_id, workspace_path, is_current, updated_at, title)
         VALUES (?,?,1,?,?)
         ON CONFLICT(session_id) DO UPDATE SET is_current=1, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at`,
        sessionId,
        proj,
        now,
        title,
      )
    } else {
      d.run(
        `INSERT INTO intent_chats (session_id, workspace_path, is_current, updated_at)
         VALUES (?,?,1,?)
         ON CONFLICT(session_id) DO UPDATE SET is_current=1, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at`,
        sessionId,
        proj,
        now,
      )
    }
  })
}

/** Re-key a comm session row when a pending session binds to its real SDK id. */
export function rebindChatSession(pendingId: string, realId: string): void {
  const d = requireDb()
  tx(d, () => {
    // If realId somehow already exists, drop it so the pending row can take it.
    d.run('DELETE FROM intent_chats WHERE session_id=?', realId)
    d.run('UPDATE intent_chats SET session_id=? WHERE session_id=?', realId, pendingId)
  })
}

/** Whether a session id belongs to the comm-session hidden set. */
export function isHiddenSession(sessionId: string): boolean {
  if (!isDbAvailable()) return false
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM intent_chats WHERE session_id=?', sessionId)
}

/** All comm session ids for a project (the hidden set), for list filtering. */
export function listHiddenSessions(workspacePath: string): string[] {
  if (!isDbAvailable()) return []
  const d = db()
  if (!d) return []
  return d
    .all<{
      session_id: string
    }>('SELECT session_id FROM intent_chats WHERE workspace_path=?', resolve(workspacePath))
    .map((r) => r.session_id)
}

/** All spec session ids for a project, for list filtering. Spec sessions are
 * not user work sessions and must not appear in the work-session list. */
export function listSpecSessionIds(workspacePath: string): string[] {
  if (!isDbAvailable()) return []
  const d = db()
  if (!d) return []
  return d
    .all<{
      spec_session_id: string
    }>(
      'SELECT spec_session_id FROM intents WHERE workspace_path=? AND spec_session_id IS NOT NULL',
      resolve(workspacePath),
    )
    .map((r) => r.spec_session_id)
}

// ---- Communication session CRUD (session-collection upgrade) ----
// `intent_chats` now holds multiple rows per project (not just one current).
// `title` is nullable — null means render "New Intent" or a first-prompt/time
// derivation on the client. `is_current` is the "default-open" pointer.

/** All comm sessions for a project, newest-first. */
export function listChatSessions(workspacePath: string): IntentSessionInfo[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  return d
    .all<{
      session_id: string
      title: string | null
      updated_at: number
    }>(
      'SELECT session_id, title, updated_at FROM intent_chats WHERE workspace_path=? ORDER BY updated_at DESC',
      proj,
    )
    .map((r) => ({
      sessionId: r.session_id,
      title: r.title ?? null,
      updatedAt: r.updated_at,
    }))
}

/** Rename a comm session (also bumps updatedAt). */
export function renameChatSession(sessionId: string, title: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intent_chats SET title=?, updated_at=? WHERE session_id=?',
    title,
    Date.now(),
    sessionId,
  )
}

/**
 * Physically delete a comm session row. If the deleted row was `is_current`,
 * the most recent remaining row (by updatedAt) for the same project becomes
 * the new is_current (is_current=1). Otherwise no fallback — callers surface
 * "no sessions" to the user. Also removes runtime (abort + drop) — callers
 * must call `removeRuntime` before this to avoid a stale runtime outlasting
 * the db row.
 *
 * @returns The project path of the deleted session (for callers to broadcast).
 */
export function deleteChatSession(workspacePath: string, sessionId: string): void {
  const d = requireDb()
  const proj = resolve(workspacePath)
  tx(d, () => {
    const row = d.get<{ is_current: number }>(
      'SELECT is_current FROM intent_chats WHERE session_id=?',
      sessionId,
    )
    if (!row) return
    d.run('DELETE FROM intent_chats WHERE session_id=?', sessionId)
    // If the deleted row was is_current, promote the latest remaining.
    if (row.is_current) {
      const next = d.get<{ session_id: string }>(
        'SELECT session_id FROM intent_chats WHERE workspace_path=? ORDER BY updated_at DESC LIMIT 1',
        proj,
      )
      if (next) {
        d.run(
          'UPDATE intent_chats SET is_current=1, updated_at=? WHERE session_id=?',
          Date.now(),
          next.session_id,
        )
      }
    }
  })
}

// ---- Tool-created session set ----
// Sessions spawned by tools (completion judge, consensus advisor). Persisted so
// the "show tool sessions" filter survives restarts — an in-memory-only set
// would be empty after a restart, leaving historic tool sessions unrecognised
// and thus visible even when the setting is off.

/** Record a session id as tool-created (idempotent). */
export function recordToolSession(sessionId: string): void {
  const d = db()
  if (!d) return
  d.run(
    'INSERT OR IGNORE INTO tool_sessions (session_id, created_at) VALUES (?,?)',
    sessionId,
    Date.now(),
  )
}

/** Whether a session id was recorded as tool-created. */
export function isToolSessionRecorded(sessionId: string): boolean {
  if (!isDbAvailable()) return false
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM tool_sessions WHERE session_id=?', sessionId)
}

/** Forget a tool-session record (called when its session is deleted). */
export function deleteToolSessionRecord(sessionId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM tool_sessions WHERE session_id=?', sessionId)
}

// ---- Intent dev session execution records (审计追踪) ----

interface IntentSessionRow {
  id: number
  intent_id: string
  session_id: string
  vendor: string
  summary: string | null
  start_at: number | null
  end_at: number | null
  exit_code: string | null
  agent_id: string | null
  created_at: number
}

function toIntentDevSession(r: IntentSessionRow): IntentDevSession {
  return {
    id: r.id,
    intentId: r.intent_id,
    sessionId: r.session_id,
    vendor: r.vendor as IntentDevSession['vendor'],
    summary: r.summary,
    startAt: r.start_at,
    endAt: r.end_at,
    exitCode: r.exit_code as IntentDevSessionExitCode | null,
    agentId: r.agent_id,
    createdAt: r.created_at,
  }
}

/**
 * Insert a new intent dev session record.
 * Returns the auto-generated id.
 */
export function insertIntentSession(
  intentId: string,
  sessionId: string,
  vendor: string,
  agentId?: string,
): number {
  const d = requireDb()
  const now = Date.now()
  d.run(
    `INSERT INTO intent_sessions (intent_id, session_id, vendor, agent_id, created_at)
     VALUES (?,?,?,?,?)`,
    intentId,
    sessionId,
    vendor,
    agentId ?? null,
    now,
  )
  const row = d.get<{ id: number }>('SELECT last_insert_rowid() AS id')
  return Number(row!.id)
}

/**
 * Update an intent dev session record post-hoc (end timestamp, exit code, summary).
 * Only updates non-`undefined` fields; no-op when no fields are supplied.
 * Skips when the db is unavailable (degradation — caller may log but must not throw).
 */
export function updateIntentSession(
  id: number,
  patch: {
    exitCode?: IntentDevSessionExitCode
    summary?: string
    startAt?: number
    endAt?: number
  },
): void {
  const d = db()
  if (!d) return
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.exitCode !== undefined) {
    sets.push('exit_code=?')
    params.push(patch.exitCode)
  }
  if (patch.summary !== undefined) {
    sets.push('summary=?')
    params.push(patch.summary)
  }
  if (patch.startAt !== undefined) {
    sets.push('start_at=?')
    params.push(patch.startAt)
  }
  if (patch.endAt !== undefined) {
    sets.push('end_at=?')
    params.push(patch.endAt)
  }
  if (sets.length > 0) {
    params.push(id)
    d.run(`UPDATE intent_sessions SET ${sets.join(', ')} WHERE id=?`, ...params)
  }
}

/**
 * Find the most recent intent session record for a given (sessionId, intentId)
 * pair. Returns `null` when the db is unavailable or no match is found.
 * Useful for `run:settled` handlers that need to update a record inserted at
 * `run:bound` time but whose auto-increment id was not captured.
 */
export function getIntentSessionBySessionId(
  sessionId: string,
  intentId: string,
): IntentDevSession | null {
  const d = db()
  if (!d) return null
  const row = d.get<IntentSessionRow>(
    'SELECT * FROM intent_sessions WHERE session_id=? AND intent_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
    sessionId,
    intentId,
  )
  return row ? toIntentDevSession(row) : null
}

/**
 * List dev session records for an intent, newest first.
 * Returns `[]` when the db is unavailable.
 */
export function listIntentSessions(intentId: string): IntentDevSession[] {
  const d = db()
  if (!d) return []
  return d
    .all<IntentSessionRow>(
      'SELECT * FROM intent_sessions WHERE intent_id=? ORDER BY created_at DESC, id DESC',
      intentId,
    )
    .map(toIntentDevSession)
}

/**
 * Get a single intent dev session record by its primary key.
 * Returns `null` when the db is unavailable or the record is not found.
 */
export function getIntentSession(id: number): IntentDevSession | null {
  const d = db()
  if (!d) return null
  const row = d.get<IntentSessionRow>('SELECT * FROM intent_sessions WHERE id=?', id)
  return row ? toIntentDevSession(row) : null
}
