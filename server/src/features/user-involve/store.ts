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
  AnyConsensusOutcome,
  WaitUserInvolveEvent,
  WaitUserInvolveSource,
  WaitUserInvolveStatus,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { pathToId } from '../../state.js'

/**
 * Schema version — informational only, see discussion store comment.
 * Migrations key off `PRAGMA table_info`, never off the version number.
 */
const SCHEMA_VERSION = 3

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wait_user_involve_events (
  id            TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  source        TEXT NOT NULL,
  source_id     TEXT,
  title         TEXT,
  request_id    TEXT,
  tool_name     TEXT,
  tool_input    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  outcome       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wui_workspace_status ON wait_user_involve_events(workspace_path, status);
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
 * v1 → v2: rename the workspace-key column `project_path` → `workspace_path` IN PLACE
 * on `wait_user_involve_events`, mirroring the intent store's v10→v11. MUST run BEFORE
 * `exec(SCHEMA)` (SCHEMA's `idx_wui_workspace_status` references the new column).
 * Idempotent + never drops a table; the composite index is dropped and rebuilt under
 * the new name by SCHEMA. Deliberately diverges from the back-compat `projectConfigs`
 * settings.json key — see the 012 migration record.
 */
function migrateProjectPathToWorkspacePath(d: Db): void {
  if (
    tableExists(d, 'wait_user_involve_events') &&
    columnExists(d, 'wait_user_involve_events', 'project_path') &&
    !columnExists(d, 'wait_user_involve_events', 'workspace_path')
  ) {
    d.exec('ALTER TABLE wait_user_involve_events RENAME COLUMN project_path TO workspace_path')
  }
  if (indexExists(d, 'idx_wui_project_status')) {
    d.exec('DROP INDEX idx_wui_project_status')
  }
}

/** Return the db with the events schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    // v1 → v2 project_path → workspace_path; MUST precede SCHEMA (see docstring).
    migrateProjectPathToWorkspacePath(d)
    d.exec(SCHEMA)
    // Idempotent backfill for columns that may be missing on upgraded builds.
    ensureColumn(d, 'wait_user_involve_events', 'tool_input', "TEXT NOT NULL DEFAULT ''")
    // v2 → v3: consensus outcome JSON for `status: 'auto'` audit records (nullable).
    ensureColumn(d, 'wait_user_involve_events', 'outcome', 'TEXT')
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
  workspace_path: string
  source: string
  source_id: string | null
  title: string | null
  request_id: string | null
  tool_name: string | null
  tool_input: string | null
  status: string
  outcome: string | null
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
  let outcome: AnyConsensusOutcome | null = null
  if (r.outcome) {
    try {
      outcome = JSON.parse(r.outcome) as AnyConsensusOutcome
    } catch {
      outcome = null
    }
  }
  return {
    id: r.id,
    workspaceId: pathToId(r.workspace_path)!,
    source: r.source as WaitUserInvolveSource,
    sourceId: r.source_id,
    title: r.title,
    requestId: r.request_id,
    toolName: r.tool_name,
    toolInput,
    status: r.status as WaitUserInvolveStatus,
    outcome,
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
  /** Consensus outcome JSON for `status: 'auto'` audit records (else null). */
  outcome?: AnyConsensusOutcome | null
}

// ---- CRUD ----

/** Insert a wait-user-involve event (default status `todo`) and return the hydrated row. */
export function createEvent(input: CreateEventInput): WaitUserInvolveEvent {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const status: WaitUserInvolveStatus = input.status ?? 'todo'
  const toolInput = input.toolInput !== undefined ? JSON.stringify(input.toolInput) : ''
  const outcome = input.outcome != null ? JSON.stringify(input.outcome) : null
  d.run(
    `INSERT INTO wait_user_involve_events
       (id, workspace_path, source, source_id, title, request_id, tool_name, tool_input, status, outcome, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    resolve(input.workspacePath),
    input.source,
    input.sourceId ?? null,
    input.title ?? null,
    input.requestId ?? null,
    input.toolName ?? null,
    toolInput,
    status,
    outcome,
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
        'SELECT * FROM wait_user_involve_events WHERE workspace_path=? AND status=? ORDER BY created_at DESC',
        proj,
        status,
      )
    : d.all<EventRow>(
        'SELECT * FROM wait_user_involve_events WHERE workspace_path=? ORDER BY created_at DESC',
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
