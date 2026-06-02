/**
 * Schedule domain store over the shared {@link Db} (c3.db).
 *
 * Owns the schedule schema (created lazily, versioned via `PRAGMA user_version`)
 * and all schedule / execution-log operations. Sibling to requirement and
 * discussion stores: all ride the one `~/.c3/c3.db` connection, each owning its
 * own tables and a private `schemaReady` flag. Every `workspacePath` arg is
 * `resolve()`d so it matches the workspace registry key.
 *
 * Degradation: when the db is unavailable, reads return empty/null and writes
 * throw (callers surface an error or skip), so c3 keeps running without the
 * schedule feature.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  CreateScheduleInput,
  McpMode,
  Schedule,
  ScheduleExecutionLog,
  ScheduleStatus,
  ScheduleType,
  UpdateScheduleInput,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../db.js'

const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  config          TEXT NOT NULL DEFAULT '{}',
  workspace_path  TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  next_run_at     INTEGER,
  status          TEXT NOT NULL,
  mcp_mode        TEXT NOT NULL,
  tool_allowlist  TEXT NOT NULL DEFAULT '[]',
  tool_denylist   TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sch_workspace ON schedules(workspace_path);

CREATE TABLE IF NOT EXISTS schedule_execution_logs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  exit_code     INTEGER,
  output        TEXT NOT NULL DEFAULT '',
  error         TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_sch_exec_schedule ON schedule_execution_logs(schedule_id);
`

// Migration functions — run after the base schema to evolve the database across versions.
function runMigrations(d: Db, currentVersion: number): void {
  // v1 → v2: add status column to schedule_execution_logs
  if (currentVersion < 2) {
    d.exec(`ALTER TABLE schedule_execution_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'running'`)
  }
}

let schemaReady = false

/** Return the db with the schedule schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    const current = d.get<{ user_version: number }>('PRAGMA user_version')?.['user_version'] ?? 0
    runMigrations(d, current)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('定时任务库不可用 (c3.db unavailable)')
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

// ---- Row shapes ----

interface ScheduleRow {
  id: string
  type: string
  config: string
  workspace_path: string
  cron_expression: string
  next_run_at: number | null
  status: string
  mcp_mode: string
  tool_allowlist: string
  tool_denylist: string
  created_at: number
  updated_at: number
}

interface ExecutionLogRow {
  id: string
  schedule_id: string
  started_at: number
  finished_at: number | null
  exit_code: number | null
  output: string
  error: string | null
  status: string | null
}

/** Parse a JSON-array column to a string list; tolerate null/blank/corrupt → `[]`. */
function parseStringList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toSchedule(r: ScheduleRow): Schedule {
  let config: unknown = {}
  try {
    config = JSON.parse(r.config)
  } catch {
    /* ignore corrupt config */
  }
  return {
    id: r.id,
    type: r.type as ScheduleType,
    config,
    workspacePath: r.workspace_path,
    cronExpression: r.cron_expression,
    nextRunAt: r.next_run_at,
    status: r.status as ScheduleStatus,
    mcpMode: r.mcp_mode as McpMode,
    toolAllowlist: parseStringList(r.tool_allowlist),
    toolDenylist: parseStringList(r.tool_denylist),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toExecutionLog(r: ExecutionLogRow): ScheduleExecutionLog {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    output: r.output,
    error: r.error,
    status: r.status,
  }
}

// ---- Schedules CRUD ----

/** All schedules in a workspace, most-recently-updated first. */
export function listSchedules(workspacePath: string): Schedule[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  return d
    .all<ScheduleRow>(
      'SELECT * FROM schedules WHERE workspace_path=? ORDER BY updated_at DESC',
      proj,
    )
    .map(toSchedule)
}

export function getSchedule(id: string): Schedule | null {
  const d = db()
  if (!d) return null
  const row = d.get<ScheduleRow>('SELECT * FROM schedules WHERE id=?', id)
  return row ? toSchedule(row) : null
}

/** Insert a schedule with status `active` and return the hydrated row. */
export function createSchedule(input: CreateScheduleInput): Schedule {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const allowlist = input.toolAllowlist ?? []
  const denylist = input.toolDenylist ?? []
  d.run(
    `INSERT INTO schedules
       (id, type, config, workspace_path, cron_expression, next_run_at, status, mcp_mode, tool_allowlist, tool_denylist, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.type,
    JSON.stringify(input.config ?? {}),
    resolve(input.workspacePath),
    input.cronExpression,
    null, // next_run_at — set by the cron engine
    'active',
    input.mcpMode,
    JSON.stringify(allowlist),
    JSON.stringify(denylist),
    now,
    now,
  )
  return getSchedule(id)!
}

/** Partial update of a schedule. Only provided fields are changed. */
export function updateSchedule(id: string, patch: UpdateScheduleInput): void {
  const d = requireDb()
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.type !== undefined) {
    sets.push('type=?')
    params.push(patch.type)
  }
  if (patch.config !== undefined) {
    sets.push('config=?')
    params.push(JSON.stringify(patch.config))
  }
  if (patch.cronExpression !== undefined) {
    sets.push('cron_expression=?')
    params.push(patch.cronExpression)
  }
  if (patch.mcpMode !== undefined) {
    sets.push('mcp_mode=?')
    params.push(patch.mcpMode)
  }
  if (patch.toolAllowlist !== undefined) {
    sets.push('tool_allowlist=?')
    params.push(JSON.stringify(patch.toolAllowlist))
  }
  if (patch.toolDenylist !== undefined) {
    sets.push('tool_denylist=?')
    params.push(JSON.stringify(patch.toolDenylist))
  }
  if (patch.status !== undefined) {
    sets.push('status=?')
    params.push(patch.status)
  }

  if (sets.length > 0) {
    sets.push('updated_at=?')
    params.push(Date.now())
    params.push(id)
    d.run(`UPDATE schedules SET ${sets.join(', ')} WHERE id=?`, ...params)
  }
}

/** Delete a schedule and its execution logs. */
export function deleteSchedule(id: string): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM schedule_execution_logs WHERE schedule_id=?', id)
    d.run('DELETE FROM schedules WHERE id=?', id)
  })
}

/** Get a schedule plus its execution logs. */
export function getScheduleDetail(id: string): {
  schedule: Schedule | null
  logs: ScheduleExecutionLog[]
} {
  const d = db()
  if (!d) return { schedule: null, logs: [] }
  const schedule = getSchedule(id)
  const logs = listExecutionLogs(id)
  return { schedule, logs }
}

// ---- Scheduler queries ----

/** Query all active schedules whose next_run_at is due (<= now). */
export function getDueSchedules(now: number): Schedule[] {
  const d = db()
  if (!d) return []
  return d
    .all<ScheduleRow>(
      'SELECT * FROM schedules WHERE status = ? AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC',
      'active',
      now,
    )
    .map(toSchedule)
}

/** Update a schedule's next_run_at after a successful execution. */
export function updateNextRunAt(id: string, nextRunAt: number | null): void {
  const d = requireDb()
  d.run('UPDATE schedules SET next_run_at=?, updated_at=? WHERE id=?', nextRunAt, Date.now(), id)
}

/**
 * Pause all schedules under a given workspace path.
 * Used by archiver.ts when a workspace is removed.
 */
export function pauseAllForWorkspace(workspacePath: string): void {
  const d = requireDb()
  const abs = resolve(workspacePath)
  d.run(
    'UPDATE schedules SET status=?, updated_at=? WHERE workspace_path=? AND status=?',
    'paused',
    Date.now(),
    abs,
    'active',
  )
}

/**
 * Update an execution log's fields (status, output, error, exit_code, finished_at).
 * Only provided fields are changed.
 */
export function updateExecutionLog(
  id: string,
  patch: {
    status?: string
    output?: string
    error?: string | null
    exitCode?: number | null
    finishedAt?: number | null
  },
): void {
  const d = requireDb()
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.status !== undefined) {
    sets.push('status=?')
    params.push(patch.status)
  }
  if (patch.output !== undefined) {
    sets.push('output=?')
    params.push(patch.output)
  }
  if (patch.error !== undefined) {
    sets.push('error=?')
    params.push(patch.error)
  }
  if (patch.exitCode !== undefined) {
    sets.push('exit_code=?')
    params.push(patch.exitCode)
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at=?')
    params.push(patch.finishedAt)
  }

  if (sets.length === 0) return
  params.push(id)
  d.run(`UPDATE schedule_execution_logs SET ${sets.join(', ')} WHERE id=?`, ...params)
}

// ---- Execution logs ----

/** Append an execution log entry for a schedule with `running` status. */
export function appendExecutionLog(input: Omit<ScheduleExecutionLog, 'id'>): ScheduleExecutionLog {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  d.run(
    `INSERT INTO schedule_execution_logs
       (id, schedule_id, started_at, finished_at, exit_code, output, error, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.scheduleId,
    input.startedAt,
    input.finishedAt ?? null,
    input.exitCode ?? null,
    input.output ?? '',
    input.error ?? null,
    input.status ?? 'running',
  )
  // Refresh the parent schedule's updated_at so list ordering reflects activity.
  d.run('UPDATE schedules SET updated_at=? WHERE id=?', now, input.scheduleId)
  return { id, ...input, status: input.status ?? 'running' }
}

/** All execution logs for a schedule, most-recently-started first. */
export function listExecutionLogs(scheduleId: string): ScheduleExecutionLog[] {
  const d = db()
  if (!d) return []
  return d
    .all<ExecutionLogRow>(
      'SELECT * FROM schedule_execution_logs WHERE schedule_id=? ORDER BY started_at DESC',
      scheduleId,
    )
    .map(toExecutionLog)
}
