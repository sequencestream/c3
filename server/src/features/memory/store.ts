/**
 * The workspace memory notebook: durable user consensus and learned context a
 * repository cannot prove about itself.
 *
 * What belongs here is what a later work session would otherwise have to ask the
 * user to repeat — a stated preference, a constraint that was verified once, a
 * durable fact, a lesson paid for. What does NOT belong here is anything the
 * repository already records; that is what `CLAUDE.md` and the domain docs are
 * for, and duplicating it would create a second, silently diverging source.
 *
 * Three properties make the table safe to read back into a model's context:
 *
 *  - **Workspace isolation is the boundary of every statement.** Reads and
 *    writes take `workspaceName` and no path; `subject` groups statements, it
 *    never widens access.
 *  - **Identity is deterministic.** Two writes whose titles normalize equal are
 *    the same memory and the second replaces the first in place. This is the only
 *    automatic semantic decision made anywhere in the capability — prose is never
 *    compared, and no model is asked whether two statements agree. Genuinely
 *    contradictory statements must therefore carry distinct titles and may share
 *    a `subject`; both stay active.
 *  - **Nothing is lost quietly.** A write that violates a bound is refused with a
 *    reason; it is never truncated, downgraded, or traded for an eviction. Delete
 *    is a status change, and physical removal waits out the janitor's recovery
 *    window.
 *
 * Availability follows the established store contract: reads degrade to an empty
 * result when the database is unavailable, writes throw. A write that failed must
 * never come back as a receipt.
 */
import { randomUUID } from 'node:crypto'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { detectMemoryGuardViolation, memoryGuardMessage } from './content-guard.js'

// ---- Model ----

/** The four kinds of statement a memory may be. A closed set, checked in SQL. */
export const MEMORY_TYPES = ['preference', 'constraint', 'fact', 'lesson'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * Lifecycle state. `active` is the only state normal search returns; the other
 * two are a recovery and cleanup concern, not model context.
 */
export const MEMORY_STATUSES = ['active', 'superseded', 'deleted'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** One memory as the store hands it back. */
export interface WorkspaceMemory {
  id: string
  workspaceName: string
  /** Optional grouping label; it does not participate in identity or access. */
  subject: string | null
  type: MemoryType
  title: string
  content: string
  status: MemoryStatus
  /** The work session responsible for the latest saved form. */
  sourceSessionId: string
  createdAt: number
  updatedAt: number
  /** The retained replacement when this row lost a deduplication. */
  supersededBy: string | null
}

// ---- Bounds ----

/** Longest accepted field value, counted in Unicode code points, not UTF-16 units. */
export const MEMORY_MAX_CHARS = 2000

/** Most physical rows one workspace may hold, across every status. */
export const MEMORY_MAX_ROWS_PER_WORKSPACE = 500

// ---- Errors ----

/** Why a store call refused. The tool layer maps these to a safe MCP error. */
export type MemoryErrorCode =
  | 'db_unavailable'
  | 'invalid_type'
  | 'invalid_title'
  | 'invalid_content'
  | 'too_long'
  | 'rejected_content'
  | 'capacity'
  | 'not_found'
  | 'no_change'

/** A refusal carrying a machine-readable code and a message safe to surface. */
export class MemoryStoreError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryStoreError'
  }
}

// ---- Schema ----

/**
 * `title_key` is the normalized title — a derived comparison key, not part of the
 * domain model. It exists as a column so same-title deduplication and the
 * janitor's repair sweep are indexed point work instead of a scan the application
 * has to re-derive on every write.
 */
const TABLE = `
CREATE TABLE IF NOT EXISTS workspace_memories (
  id                TEXT PRIMARY KEY,
  workspace_name    TEXT NOT NULL,
  subject           TEXT,
  type              TEXT NOT NULL CHECK(type IN ('preference','constraint','fact','lesson')),
  title             TEXT NOT NULL,
  title_key         TEXT NOT NULL,
  content           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
  source_session_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  superseded_by     TEXT
);
`

/** Declared after the column check, so an index can name a column just added. */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope
  ON workspace_memories(workspace_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_title
  ON workspace_memories(workspace_name, title_key, status);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_inactive
  ON workspace_memories(status, updated_at);
`

/**
 * Keyed on the connection, not a boolean: `resetDbForTests` hands out a new
 * connection to a new file, and a plain flag would claim the table exists there.
 */
let schemaReadyFor: Db | null = null

/** Add a column a partially initialized database is missing. Idempotent. */
function ensureColumn(d: Db, col: string, decl: string): boolean {
  const cols = d.all<{ name: string }>('PRAGMA table_info(workspace_memories)')
  if (cols.some((c) => c.name === col)) return false
  d.exec(`ALTER TABLE workspace_memories ADD COLUMN ${col} ${decl}`)
  return true
}

function ensureSchema(d: Db): void {
  d.exec(TABLE)
  ensureColumn(d, 'subject', 'TEXT')
  ensureColumn(d, 'superseded_by', 'TEXT')
  // A table that predates the comparison key carries rows holding the column
  // default. Deriving them here is what keeps deduplication correct on a database
  // c3 did not create in one piece.
  if (ensureColumn(d, 'title_key', "TEXT NOT NULL DEFAULT ''")) {
    for (const r of d.all<{ id: string; title: string }>(
      "SELECT id, title FROM workspace_memories WHERE title_key = ''",
    )) {
      d.run(
        'UPDATE workspace_memories SET title_key = ? WHERE id = ?',
        normalizeTitle(r.title),
        r.id,
      )
    }
  }
  d.exec(INDEXES)
}

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
    } catch {
      return null
    }
    schemaReadyFor = d
  }
  return d
}

/** Throwing accessor for the write paths — an unavailable database is visible. */
function requireDb(): Db {
  const d = db()
  if (!d) throw new MemoryStoreError('db_unavailable', '记忆库不可用,本次写入未生效。')
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetMemoryStoreForTests(): void {
  schemaReadyFor = null
}

/** Materialize the table at startup so an unusable database is found before a write needs it. */
export function ensureMemorySchema(): boolean {
  return db() !== null
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

// ---- Identity ----

/**
 * The comparison key for title identity: surrounding whitespace trimmed,
 * internal whitespace runs collapsed to one space, Unicode-aware lowercase.
 * Scoped by workspace — two workspaces may hold the same title independently.
 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

// ---- Validation ----

function charCount(value: string): number {
  return Array.from(value).length
}

/** Reject anything past the length ceiling or matching the shared deny patterns. */
function checkField(value: string, label: string): void {
  if (charCount(value) > MEMORY_MAX_CHARS) {
    throw new MemoryStoreError(
      'too_long',
      `${label}超出 ${MEMORY_MAX_CHARS} 字符上限(当前 ${charCount(value)}),已拒绝写入。请压缩成一句结论。`,
    )
  }
  const violation = detectMemoryGuardViolation(value)
  if (violation)
    throw new MemoryStoreError('rejected_content', memoryGuardMessage(violation, label))
}

function validTitle(title: string): string {
  const normalized = normalizeTitle(title)
  if (!normalized) throw new MemoryStoreError('invalid_title', 'title 归一化后为空,已拒绝写入。')
  const trimmed = title.trim()
  checkField(trimmed, 'title')
  return trimmed
}

function validContent(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) throw new MemoryStoreError('invalid_content', 'content 为空,已拒绝写入。')
  checkField(trimmed, 'content')
  return trimmed
}

function validSubject(subject: string | null | undefined): string | null {
  if (subject == null) return null
  const trimmed = subject.trim()
  if (!trimmed) return null
  checkField(trimmed, 'subject')
  return trimmed
}

function validType(type: string): MemoryType {
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new MemoryStoreError(
      'invalid_type',
      `type 必须是 ${MEMORY_TYPES.join(' / ')} 之一,已拒绝写入。`,
    )
  }
  return type as MemoryType
}

// ---- Row mapping ----

interface MemoryRow {
  id: string
  workspace_name: string
  subject: string | null
  type: string
  title: string
  content: string
  status: string
  source_session_id: string
  created_at: number
  updated_at: number
  superseded_by: string | null
}

const SELECT_COLS = `id, workspace_name, subject, type, title, content, status,
                     source_session_id, created_at, updated_at, superseded_by`

function toMemory(r: MemoryRow): WorkspaceMemory {
  return {
    id: r.id,
    workspaceName: r.workspace_name,
    subject: r.subject,
    type: r.type as MemoryType,
    title: r.title,
    content: r.content,
    status: r.status as MemoryStatus,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    supersededBy: r.superseded_by,
  }
}

// ---- Reads ----

/** Every active memory in one workspace, newest first. Empty when the db is down. */
export function listActiveMemories(workspaceName: string): WorkspaceMemory[] {
  const d = db()
  if (!d) return []
  return d
    .all<MemoryRow>(
      `SELECT ${SELECT_COLS} FROM workspace_memories
        WHERE workspace_name = ? AND status = 'active'
        ORDER BY updated_at DESC, id ASC`,
      workspaceName,
    )
    .map(toMemory)
}

/** Escape the LIKE metacharacters so a query is matched as literal text. */
function likeLiteral(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Literal, case-insensitive substring match over title, subject and content,
 * within one workspace's active memories. A query that matches nothing returns
 * nothing — the search never widens to another workspace or to inactive rows.
 */
export function searchMemories(workspaceName: string, query: string): WorkspaceMemory[] {
  const d = db()
  if (!d) return []
  const pattern = likeLiteral(query)
  return d
    .all<MemoryRow>(
      `SELECT ${SELECT_COLS} FROM workspace_memories
        WHERE workspace_name = ? AND status = 'active'
          AND (title LIKE ? ESCAPE '\\'
               OR content LIKE ? ESCAPE '\\'
               OR COALESCE(subject,'') LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC, id ASC`,
      workspaceName,
      pattern,
      pattern,
      pattern,
    )
    .map(toMemory)
}

/** One memory by id, scoped to its workspace. `null` when absent or foreign. */
export function getMemory(workspaceName: string, id: string): WorkspaceMemory | null {
  const d = db()
  if (!d) return null
  const row = d.get<MemoryRow>(
    `SELECT ${SELECT_COLS} FROM workspace_memories WHERE id = ? AND workspace_name = ?`,
    id,
    workspaceName,
  )
  return row ? toMemory(row) : null
}

function countRows(d: Db, workspaceName: string): number {
  return (
    d.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM workspace_memories WHERE workspace_name = ?',
      workspaceName,
    )?.n ?? 0
  )
}

/** Physical row count for one workspace, across every status (the capacity figure). */
export function countMemoryRows(workspaceName: string): number {
  const d = db()
  return d ? countRows(d, workspaceName) : 0
}

// ---- Writes ----

/** What a create supplies. Status, timestamps and identity are server-derived. */
export interface MemoryCreateInput {
  workspaceName: string
  sourceSessionId: string
  type: string
  title: string
  content: string
  subject?: string | null
}

/** Find the row a same-title write should land on: anything not already superseded. */
function findUpsertTarget(d: Db, workspaceName: string, titleKey: string): MemoryRow | undefined {
  return d.get<MemoryRow>(
    `SELECT ${SELECT_COLS} FROM workspace_memories
      WHERE workspace_name = ? AND title_key = ? AND status <> 'superseded'
      ORDER BY updated_at DESC, id ASC LIMIT 1`,
    workspaceName,
    titleKey,
  )
}

/**
 * Save one memory. A title that normalizes onto an existing non-superseded row
 * replaces that row in place — keeping its id and `created_at`, refreshing its
 * content, source session and `updated_at`, and reactivating it if it had been
 * soft-deleted. Otherwise a new row is inserted, subject to the workspace
 * capacity limit.
 *
 * The count check and the insert share one transaction, so two concurrent writes
 * in this process cannot both pass the limit.
 */
export function createMemory(input: MemoryCreateInput, now: number = Date.now()): WorkspaceMemory {
  const type = validType(input.type)
  const title = validTitle(input.title)
  const content = validContent(input.content)
  const subject = validSubject(input.subject)
  const titleKey = normalizeTitle(title)
  const d = requireDb()

  return tx(d, () => {
    const existing = findUpsertTarget(d, input.workspaceName, titleKey)
    if (existing) {
      d.run(
        `UPDATE workspace_memories
            SET subject = ?, type = ?, title = ?, title_key = ?, content = ?,
                status = 'active', source_session_id = ?, updated_at = ?, superseded_by = NULL
          WHERE id = ?`,
        subject,
        type,
        title,
        titleKey,
        content,
        input.sourceSessionId,
        now,
        existing.id,
      )
      return readRow(d, existing.id)
    }
    assertCapacity(d, input.workspaceName)
    const id = randomUUID()
    d.run(
      `INSERT INTO workspace_memories
         (id, workspace_name, subject, type, title, title_key, content, status,
          source_session_id, created_at, updated_at, superseded_by)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?,NULL)`,
      id,
      input.workspaceName,
      subject,
      type,
      title,
      titleKey,
      content,
      input.sourceSessionId,
      now,
      now,
    )
    return readRow(d, id)
  })
}

function assertCapacity(d: Db, workspaceName: string): void {
  // Counted on the transaction's own handle so the check and the insert cannot be
  // split by another write in this process.
  if (countRows(d, workspaceName) >= MEMORY_MAX_ROWS_PER_WORKSPACE) {
    throw new MemoryStoreError(
      'capacity',
      `本工作区记忆已达 ${MEMORY_MAX_ROWS_PER_WORKSPACE} 条上限,新条目未写入。` +
        '请先删除或合并不再需要的记忆(删除后 30 天回收期内仍占用容量),不会自动淘汰任何一条。',
    )
  }
}

function readRow(d: Db, id: string): WorkspaceMemory {
  const row = d.get<MemoryRow>(`SELECT ${SELECT_COLS} FROM workspace_memories WHERE id = ?`, id)
  if (!row) throw new MemoryStoreError('not_found', '记忆写入后未能读回,本次写入未生效。')
  return toMemory(row)
}

/** What an update may change. Every absent field keeps its stored value. */
export interface MemoryUpdateInput {
  workspaceName: string
  id: string
  sourceSessionId: string
  type?: string
  title?: string
  content?: string
  subject?: string | null
}

/**
 * Edit one memory in the bound workspace. The target must exist and be `active`
 * or `deleted`; a superseded row is not an editable object. Changing the title
 * re-applies the same normalized-title uniqueness rule, so an edit can never
 * create a second active row under one identity.
 */
export function updateMemory(input: MemoryUpdateInput, now: number = Date.now()): WorkspaceMemory {
  const touchesSomething =
    input.type !== undefined ||
    input.title !== undefined ||
    input.content !== undefined ||
    input.subject !== undefined
  if (!touchesSomething) {
    throw new MemoryStoreError(
      'no_change',
      'update 至少要给出 type / title / content / subject 之一。',
    )
  }
  const type = input.type === undefined ? undefined : validType(input.type)
  const title = input.title === undefined ? undefined : validTitle(input.title)
  const content = input.content === undefined ? undefined : validContent(input.content)
  const subject = input.subject === undefined ? undefined : validSubject(input.subject)
  const d = requireDb()

  return tx(d, () => {
    const current = d.get<MemoryRow>(
      `SELECT ${SELECT_COLS} FROM workspace_memories WHERE id = ? AND workspace_name = ?`,
      input.id,
      input.workspaceName,
    )
    if (!current || current.status === 'superseded') {
      throw new MemoryStoreError('not_found', '目标记忆不存在或不属于本工作区,未做任何修改。')
    }
    const nextTitle = title ?? current.title
    const nextKey = normalizeTitle(nextTitle)
    // A retitle onto another live row would produce two active rows under one
    // identity. Refuse rather than merge: the caller decides which survives.
    const clash = findUpsertTarget(d, input.workspaceName, nextKey)
    if (clash && clash.id !== current.id) {
      throw new MemoryStoreError(
        'invalid_title',
        '同名记忆已存在(title 归一化后相同),未做任何修改。请改用该条目的 id,或换一个 title。',
      )
    }
    d.run(
      `UPDATE workspace_memories
          SET subject = ?, type = ?, title = ?, title_key = ?, content = ?,
              status = 'active', source_session_id = ?, updated_at = ?, superseded_by = NULL
        WHERE id = ?`,
      subject === undefined ? current.subject : subject,
      type ?? current.type,
      nextTitle,
      nextKey,
      content ?? current.content,
      input.sourceSessionId,
      now,
      current.id,
    )
    return readRow(d, current.id)
  })
}

/**
 * Soft-delete one memory in the bound workspace. Repeating it is idempotent and
 * still reports the stored title, so the caller always learns what it removed.
 * The row keeps its slot until the janitor's recovery window closes — shortening
 * recoverability to free capacity is not a trade the store makes on its own.
 */
export function deleteMemory(
  workspaceName: string,
  id: string,
  now: number = Date.now(),
): WorkspaceMemory {
  const d = requireDb()
  return tx(d, () => {
    const current = d.get<MemoryRow>(
      `SELECT ${SELECT_COLS} FROM workspace_memories WHERE id = ? AND workspace_name = ?`,
      id,
      workspaceName,
    )
    if (!current || current.status === 'superseded') {
      throw new MemoryStoreError('not_found', '目标记忆不存在或不属于本工作区,未做任何修改。')
    }
    if (current.status === 'deleted') return toMemory(current)
    d.run("UPDATE workspace_memories SET status = 'deleted', updated_at = ? WHERE id = ?", now, id)
    return readRow(d, id)
  })
}
