/**
 * Requirement-management domain store over {@link Db}.
 *
 * Owns the schema (created lazily, versioned via `PRAGMA user_version`) and all
 * requirement / dependency / communication-session operations. Every
 * `projectPath` is `resolve()`d so it matches the workspace registry key, the
 * runtime `workspacePath`, and the SDK `cwd` (otherwise lookups and the
 * hidden-session filter silently miss).
 *
 * Degradation: when the db is unavailable, reads return empty and writes throw
 * (callers surface an error or skip), so c3 keeps running without requirements.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  ProposedRequirement,
  Requirement,
  RequirementRunStatus,
  RequirementStatus,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../db.js'

const SCHEMA_VERSION = 5

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requirements (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  priority        TEXT NOT NULL,
  status          TEXT NOT NULL,
  module          TEXT NOT NULL DEFAULT '',
  last_dev_session_id TEXT,
  automate        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_req_project_status ON requirements(project_path, status);

CREATE TABLE IF NOT EXISTS requirement_deps (
  requirement_id  TEXT NOT NULL,
  depends_on_id   TEXT NOT NULL,
  PRIMARY KEY (requirement_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS requirement_chats (
  session_id    TEXT PRIMARY KEY,
  project_path  TEXT NOT NULL,
  is_current    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_project ON requirement_chats(project_path);

CREATE TABLE IF NOT EXISTS tool_sessions (
  session_id    TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL
);
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

/** Return the db with the schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    // v1 → v2: add `module` to pre-existing requirements tables (historic rows default to '').
    ensureColumn(d, 'requirements', 'module', "TEXT NOT NULL DEFAULT ''")
    // v2 → v3: add nullable `completed_at` (historic rows stay null until re-marked done).
    ensureColumn(d, 'requirements', 'completed_at', 'INTEGER')
    // v3 → v4: add `automate` (historic rows default to 0 — opt-in to automation).
    ensureColumn(d, 'requirements', 'automate', 'INTEGER NOT NULL DEFAULT 0')
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
  project_path: string
  title: string
  content: string
  priority: string
  status: string
  module: string
  last_dev_session_id: string | null
  automate: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

/** Attach `dependsOn` to a set of rows in one deps query, preserving row order. */
function hydrate(d: Db, rows: Row[]): Requirement[] {
  if (rows.length === 0) return []
  const byId = new Map<string, string[]>()
  for (const r of rows) byId.set(r.id, [])
  const placeholders = rows.map(() => '?').join(',')
  const deps = d.all<{ requirement_id: string; depends_on_id: string }>(
    `SELECT requirement_id, depends_on_id FROM requirement_deps WHERE requirement_id IN (${placeholders})`,
    ...rows.map((r) => r.id),
  )
  for (const dep of deps) byId.get(dep.requirement_id)?.push(dep.depends_on_id)
  return rows.map((r) => ({
    id: r.id,
    projectPath: r.project_path,
    title: r.title,
    content: r.content,
    priority: r.priority as Requirement['priority'],
    module: r.module,
    status: r.status as RequirementStatus,
    dependsOn: byId.get(r.id) ?? [],
    lastDevSessionId: r.last_dev_session_id,
    automate: r.automate === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    runStatus: 'idle' as RequirementRunStatus,
  }))
}

// ---- Requirements ----

/** A project's requirements (optionally status-filtered), priority then recency. */
export function listRequirements(projectPath: string, status?: RequirementStatus): Requirement[] {
  const d = db()
  if (!d) return []
  const proj = resolve(projectPath)
  const rows = status
    ? d.all<Row>(
        'SELECT * FROM requirements WHERE project_path=? AND status=? ORDER BY priority ASC, updated_at DESC',
        proj,
        status,
      )
    : d.all<Row>(
        'SELECT * FROM requirements WHERE project_path=? ORDER BY priority ASC, updated_at DESC',
        proj,
      )
  return hydrate(d, rows)
}

export function getRequirement(id: string): Requirement | null {
  const d = db()
  if (!d) return null
  const row = d.get<Row>('SELECT * FROM requirements WHERE id=?', id)
  return row ? hydrate(d, [row])[0] : null
}

/** Escape LIKE wildcards so a keyword matches literally (paired with `ESCAPE '\'`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Search a project's requirements for the read-only requirement agent's
 * `find_requirements` tool. Filters compose with AND; all are optional:
 *  - `keyword` — case-handled LIKE substring over `title` OR `content` (wildcards escaped).
 *  - `module` / `status` — exact-match column filters.
 * Same `(project_path)` scoping + `resolve()` as the rest of the store, so the
 * agent can never read another project's ledger. Ordered like `listRequirements`
 * (priority asc, then recency). Returns `[]` when the db is unavailable.
 */
export function findRequirements(
  projectPath: string,
  filter: { keyword?: string; module?: string; status?: RequirementStatus } = {},
): Requirement[] {
  const d = db()
  if (!d) return []
  const where: string[] = ['project_path=?']
  const params: (string | number)[] = [resolve(projectPath)]
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
    `SELECT * FROM requirements WHERE ${where.join(' AND ')} ORDER BY priority ASC, updated_at DESC`,
    ...params,
  )
  return hydrate(d, rows)
}

/**
 * Resolve each item's effective dependency-id list for a batch insert (RM-R17),
 * given the ids freshly minted for the SAME batch (`ids[i]` belongs to `items[i]`).
 *
 * Two sources are merged & de-duplicated per item:
 *  - `dependsOn` — ids of requirements that already exist in the ledger (unchanged).
 *  - `dependsOnIndexes` — 0-based indexes into THIS batch, resolved to the sibling's
 *    `ids[index]`. Lets a batch express its own先后关系 before any row has an id.
 *
 * Pure (items + ids in, id-lists out) so the validation is unit-testable without a
 * db. Throws — rejecting the WHOLE batch — when an index reference is out of range,
 * points at itself, or forms a cycle among the batch's intra-batch edges (existing-id
 * deps can't form a cycle with brand-new rows, so only index edges are checked).
 */
export function resolveBatchDependencies(
  items: Pick<ProposedRequirement, 'dependsOn' | 'dependsOnIndexes'>[],
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

/** Insert a batch of proposed requirements (status `todo`) in one transaction. */
export function insertRequirements(
  projectPath: string,
  items: ProposedRequirement[],
): Requirement[] {
  const d = requireDb()
  const proj = resolve(projectPath)
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
        `INSERT INTO requirements
           (id, project_path, title, content, priority, status, module, last_dev_session_id, created_at, updated_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ids[i],
        proj,
        it.title,
        it.content,
        it.priority,
        'todo',
        it.module ?? '',
        null,
        createdAt,
        createdAt,
        null,
      )
      for (const dep of deps[i]) {
        d.run(
          'INSERT OR IGNORE INTO requirement_deps (requirement_id, depends_on_id) VALUES (?,?)',
          ids[i],
          dep,
        )
      }
    })
  })
  // Re-read so callers get fully-hydrated rows (incl. dependsOn).
  const placeholders = ids.map(() => '?').join(',')
  const rows = d.all<Row>(`SELECT * FROM requirements WHERE id IN (${placeholders})`, ...ids)
  // Preserve insertion order.
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return hydrate(d, rows)
}

export function updateStatus(id: string, status: RequirementStatus): void {
  const d = requireDb()
  const now = Date.now()
  // `done` stamps the completion time; any other status clears it (covers reverting from done).
  const completedAt = status === 'done' ? now : null
  d.run(
    'UPDATE requirements SET status=?, updated_at=?, completed_at=? WHERE id=?',
    status,
    now,
    completedAt,
    id,
  )
}

/** Toggle a requirement's automation flag (whether the orchestrator may pick it). */
export function setAutomate(id: string, automate: boolean): void {
  const d = requireDb()
  d.run(
    'UPDATE requirements SET automate=?, updated_at=? WHERE id=?',
    automate ? 1 : 0,
    Date.now(),
    id,
  )
}

export function setLastDevSession(id: string, sessionId: string): void {
  const d = requireDb()
  d.run(
    'UPDATE requirements SET last_dev_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/** Patch editable fields; `dependsOn`, when present, replaces the dependency set. */
export function updateRequirement(
  id: string,
  patch: Partial<Pick<Requirement, 'title' | 'content' | 'priority' | 'status' | 'dependsOn'>>,
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
      d.run(`UPDATE requirements SET ${sets.join(', ')} WHERE id=?`, ...params)
    }
    if (patch.dependsOn !== undefined) {
      d.run('DELETE FROM requirement_deps WHERE requirement_id=?', id)
      for (const dep of patch.dependsOn) {
        d.run(
          'INSERT OR IGNORE INTO requirement_deps (requirement_id, depends_on_id) VALUES (?,?)',
          id,
          dep,
        )
      }
    }
  })
}

// ---- Communication session mapping / hidden set ----
// `requirement_chats` doubles as the per-project "current comm session" map and
// the hidden-session set (every row is hidden from the normal session list).

/** The current comm session id for a project, or null. */
export function getChatSession(projectPath: string): string | null {
  const d = db()
  if (!d) return null
  const row = d.get<{ session_id: string }>(
    'SELECT session_id FROM requirement_chats WHERE project_path=? AND is_current=1',
    resolve(projectPath),
  )
  return row?.session_id ?? null
}

/** Make `sessionId` the project's current comm session (clearing any prior one). */
export function setChatSession(projectPath: string, sessionId: string): void {
  const d = requireDb()
  const proj = resolve(projectPath)
  const now = Date.now()
  tx(d, () => {
    d.run('UPDATE requirement_chats SET is_current=0 WHERE project_path=? AND is_current=1', proj)
    d.run(
      `INSERT INTO requirement_chats (session_id, project_path, is_current, updated_at)
       VALUES (?,?,1,?)
       ON CONFLICT(session_id) DO UPDATE SET is_current=1, project_path=excluded.project_path, updated_at=excluded.updated_at`,
      sessionId,
      proj,
      now,
    )
  })
}

/** Re-key a comm session row when a pending session binds to its real SDK id. */
export function rebindChatSession(pendingId: string, realId: string): void {
  const d = requireDb()
  tx(d, () => {
    // If realId somehow already exists, drop it so the pending row can take it.
    d.run('DELETE FROM requirement_chats WHERE session_id=?', realId)
    d.run('UPDATE requirement_chats SET session_id=? WHERE session_id=?', realId, pendingId)
  })
}

/** Whether a session id belongs to the comm-session hidden set. */
export function isHiddenSession(sessionId: string): boolean {
  if (!isDbAvailable()) return false
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM requirement_chats WHERE session_id=?', sessionId)
}

/** All comm session ids for a project (the hidden set), for list filtering. */
export function listHiddenSessions(projectPath: string): string[] {
  if (!isDbAvailable()) return []
  const d = db()
  if (!d) return []
  return d
    .all<{
      session_id: string
    }>('SELECT session_id FROM requirement_chats WHERE project_path=?', resolve(projectPath))
    .map((r) => r.session_id)
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
