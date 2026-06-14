/**
 * Wait-user-involve event store over the shared {@link Db} (c3.db).
 *
 * Owns the `wait_user_involve_events` table (created lazily, migrated via
 * `PRAGMA table_info` idempotency) and all CRUD operations for events that
 * gate tool calls behind human decisions. Sibling to the discussion / intent /
 * schedule stores: all ride the one `~/.c3/c3.db` connection, each owning its
 * own tables and a private `schemaReady` flag.
 *
 * Degradation: when the db is unavailable, reads return empty/null and writes
 * throw (callers surface an error or skip).
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  WaitUserInvolveEvent,
  WaitUserInvolveSource,
  WaitUserInvolveStatus,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

/**
 * Schema version — informational only, see discussion store comment.
 * Migrations key off `PRAGMA table_info`, never off the version number.
 */
const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wait_user_involve_events (
  id            TEXT PRIMARY KEY,
  project_path  TEXT NOT NULL,
  source        TEXT NOT NULL,
  source_id     TEXT,
  title         TEXT,
  request_id    TEXT,
  tool_name     TEXT,
  tool_input    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wui_project_status ON wait_user_involve_events(project_path, status);
CREATE INDEX IF NOT EXISTS idx_wui_source_status ON wait_user_involve_events(source_id, status);
`

let schemaReady = false

/**
 * Idempotently add a column to an existing table when it's missing.
 */
function ensureColumn(d: Db, table: string, col: string, decl: string): void {
  const cols = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
}

/** Return the db with the events schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    // Idempotent backfill for columns that may be missing on upgraded builds.
    ensureColumn(d, 'wait_user_involve_events', 'tool_input', "TEXT NOT NULL DEFAULT ''")
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('待处理事件库不可用 (c3.db unavailable)')
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

function _tx<T>(d: Db, fn: () => T): T {
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

// ---- Row mapping ----

interface EventRow {
  id: string
  project_path: string
  source: string
  source_id: string | null
  title: string | null
  request_id: string | null
  tool_name: string | null
  tool_input: string | null
  status: string
  created_at: number
  updated_at: number
}

function toEvent(r: EventRow): WaitUserInvolveEvent {
  let toolInput: unknown = null
  if (r.tool_input) {
    try {
      toolInput = JSON.parse(r.tool_input)
    } catch {
      toolInput = r.tool_input
    }
  }
  return {
    id: r.id,
    workspacePath: r.project_path,
    source: r.source as WaitUserInvolveSource,
    sourceId: r.source_id,
    title: r.title,
    requestId: r.request_id,
    toolName: r.tool_name,
    toolInput,
    status: r.status as WaitUserInvolveStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Fields a caller supplies when creating a wait-user-involve event. */
export interface CreateEventInput {
  workspacePath: string
  source: WaitUserInvolveSource
  sourceId?: string | null
  title?: string | null
  requestId?: string | null
  toolName?: string | null
  toolInput?: unknown
  status?: WaitUserInvolveStatus
}

// ---- CRUD ----

/** Insert a wait-user-involve event (default status `todo`) and return the hydrated row. */
export function createEvent(input: CreateEventInput): WaitUserInvolveEvent {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const status: WaitUserInvolveStatus = input.status ?? 'todo'
  const toolInput = input.toolInput !== undefined ? JSON.stringify(input.toolInput) : ''
  d.run(
    `INSERT INTO wait_user_involve_events
       (id, project_path, source, source_id, title, request_id, tool_name, tool_input, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    resolve(input.workspacePath),
    input.source,
    input.sourceId ?? null,
    input.title ?? null,
    input.requestId ?? null,
    input.toolName ?? null,
    toolInput,
    status,
    now,
    now,
  )
  return getEvent(id)!
}

/** Get one event by id, or null. */
export function getEvent(id: string): WaitUserInvolveEvent | null {
  const d = db()
  if (!d) return null
  const row = d.get<EventRow>('SELECT * FROM wait_user_involve_events WHERE id=?', id)
  return row ? toEvent(row) : null
}

/**
 * List events for a project, optionally filtered by status. Most-recently-created
 * first (descending `created_at` — events are insert-only, so no `updated_at` sort).
 */
export function listEvents(
  workspacePath: string,
  status?: WaitUserInvolveStatus,
): WaitUserInvolveEvent[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  const rows = status
    ? d.all<EventRow>(
        'SELECT * FROM wait_user_involve_events WHERE project_path=? AND status=? ORDER BY created_at DESC',
        proj,
        status,
      )
    : d.all<EventRow>(
        'SELECT * FROM wait_user_involve_events WHERE project_path=? ORDER BY created_at DESC',
        proj,
      )
  return rows.map(toEvent)
}

/**
 * Look up one event by `request_id`. Useful for the permission-response handler
 * when only the `requestId` is known. Returns null when no event matches.
 */
export function getEventByRequestId(requestId: string): WaitUserInvolveEvent | null {
  const d = db()
  if (!d) return null
  const row = d.get<EventRow>(
    'SELECT * FROM wait_user_involve_events WHERE request_id=?',
    requestId,
  )
  return row ? toEvent(row) : null
}

/** Update a single event's status (and `updated_at`). */
export function updateStatus(id: string, status: WaitUserInvolveStatus): void {
  const d = requireDb()
  d.run(
    'UPDATE wait_user_involve_events SET status=?, updated_at=? WHERE id=?',
    status,
    Date.now(),
    id,
  )
}

/**
 * Cancel all 'todo' events for a given `sourceId` (e.g. when a session ends).
 */
export function cancelBySourceId(sourceId: string): void {
  const d = requireDb()
  d.run(
    "UPDATE wait_user_involve_events SET status='canceled', updated_at=? WHERE source_id=? AND status='todo'",
    Date.now(),
    sourceId,
  )
}
