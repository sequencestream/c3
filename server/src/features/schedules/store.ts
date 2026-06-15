/**
 * Schedule domain store over the shared {@link Db} (c3.db).
 *
 * Owns the schedule schema (created lazily, versioned via `PRAGMA user_version`)
 * and all schedule / execution-log operations. Sibling to intent and
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
  CodexPolicy,
  CreateScheduleInput,
  ModeToken,
  RunEndReason,
  RunLifecycleTopic,
  Schedule,
  ScheduleExecutionLog,
  ScheduleStatus,
  ScheduleTriggerType,
  ScheduleType,
  UpdateScheduleInput,
  VendorId,
  WorkspaceMcpConfig,
} from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron } from '@ccc/shared/cron'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { getTimezone } from '../../kernel/config/index.js'
import { fallbackName } from './naming.js'

/**
 * Strip server-owned / dropped keys from a client-supplied config before
 * persisting. `name` and `nameSource` are server-owned (the caller decides the
 * final name via the `nameOverride` / preserve logic in {@link updateSchedule},
 * or the generated name in {@link createSchedule}); `description` is removed
 * entirely (legacy field). Returns a fresh object.
 */
function sanitizeConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {}
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  delete out.name
  delete out.nameSource
  delete out.description
  return out
}

/** Resolved display name + provenance the update path writes into config. */
export interface ScheduleNameOverride {
  name: string
  /** `'user'` marks a manually-set name as sticky (auto-naming never overrides it). */
  source: 'user' | 'auto'
}

const AGENT_RECOVERY_ACTION = 'agent_quota_recovery'
const SCHEMA_VERSION = 5

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL,
  config              TEXT NOT NULL DEFAULT '{}',
  workspace_path      TEXT NOT NULL,
  trigger_type        TEXT NOT NULL DEFAULT 'cron',
  cron_expression     TEXT NOT NULL,
  next_run_at         INTEGER,
  event_topic         TEXT,
  event_reason_filter TEXT,
  status              TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT '',
  tool_allowlist      TEXT NOT NULL DEFAULT '[]',
  tool_denylist       TEXT NOT NULL DEFAULT '[]',
  vendor              TEXT NOT NULL DEFAULT 'claude',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
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
  status        TEXT NOT NULL DEFAULT 'running',
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sch_exec_schedule ON schedule_execution_logs(schedule_id);

CREATE TABLE IF NOT EXISTS workspace_mcp_configs (
  workspace_path TEXT PRIMARY KEY,
  config_json    TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL
);
`

/** Whether a column already exists on a table (so an ALTER ADD is idempotent). */
function columnExists(d: Db, table: string, column: string): boolean {
  const rows = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return rows.some((r) => r.name === column)
}

// Migration functions — run after the base schema to evolve the database across versions.
//
// IMPORTANT: `PRAGMA user_version` is database-global and shared with the sibling
// intent/discussion stores, which set it to THEIR own SCHEMA_VERSION. So this
// store can never trust `user_version` to gate its migrations: intents (v5)
// may have stamped it to 5 before we run, making any `currentVersion < N` check
// wrongly skip our ALTERs (the bug that left old `schedule_execution_logs` tables
// without `session_id`). Mirror the intent/discussion stores: drive every
// migration off `PRAGMA table_info` / `IF NOT EXISTS` so each step is idempotent
// regardless of the shared version counter — a fresh db already has the latest
// SCHEMA, an old db gets backfilled here, and re-runs are no-ops.
function runMigrations(d: Db): void {
  // add status column to schedule_execution_logs (historic rows default 'running').
  if (!columnExists(d, 'schedule_execution_logs', 'status')) {
    d.exec(`ALTER TABLE schedule_execution_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'running'`)
  }
  // add workspace_mcp_configs for db files opened before the base SCHEMA carried
  // this table (IF NOT EXISTS makes this a no-op otherwise).
  d.exec(`
    CREATE TABLE IF NOT EXISTS workspace_mcp_configs (
      workspace_path TEXT PRIMARY KEY,
      config_json    TEXT NOT NULL DEFAULT '{}',
      updated_at     INTEGER NOT NULL
    );
  `)
  // add session_id column to schedule_execution_logs (llm-type runs record their
  // agent session id so the transcript can be loaded on demand).
  if (!columnExists(d, 'schedule_execution_logs', 'session_id')) {
    d.exec(`ALTER TABLE schedule_execution_logs ADD COLUMN session_id TEXT`)
  }
  // v5 (2026-06-08): event-triggered schedules. trigger_type defaults old rows to
  // 'cron' so their cron behaviour is unchanged; event_topic / event_reason_filter
  // stay NULL for cron rows. Each ALTER is gated on table_info so re-runs no-op.
  if (!columnExists(d, 'schedules', 'trigger_type')) {
    d.exec(`ALTER TABLE schedules ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'`)
  }
  if (!columnExists(d, 'schedules', 'event_topic')) {
    d.exec(`ALTER TABLE schedules ADD COLUMN event_topic TEXT`)
  }
  if (!columnExists(d, 'schedules', 'event_reason_filter')) {
    d.exec(`ALTER TABLE schedules ADD COLUMN event_reason_filter TEXT`)
  }
  // v6 (2026-06-08): vendor column. Old schedules default to 'claude' so their
  // execution behaviour is unchanged — they keep running under the default vendor.
  if (!columnExists(d, 'schedules', 'vendor')) {
    d.exec(`ALTER TABLE schedules ADD COLUMN vendor TEXT NOT NULL DEFAULT 'claude'`)
  }
  // v7 (2026-06-09): replace mcp_mode with mode. Add the new column, backfill
  // from the old one for legacy rows, then drop the old column so new INSERTs
  // that write to `mode` don't hit the NOT NULL constraint on `mcp_mode`.
  // DROP COLUMN requires SQLite ≥ 3.35.0 (2021); Node.js ≥ 18 ships it.
  if (!columnExists(d, 'schedules', 'mode')) {
    d.exec(`ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT ''`)
    d.exec(`UPDATE schedules SET mode = mcp_mode`)
  }
  if (columnExists(d, 'schedules', 'mcp_mode')) {
    d.exec(`ALTER TABLE schedules DROP COLUMN mcp_mode`)
  }
}

let schemaReady = false

/** Return the db with the schedule schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    runMigrations(d)
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
  trigger_type: string | null
  cron_expression: string
  next_run_at: number | null
  event_topic: string | null
  event_reason_filter: string | null
  status: string
  mode: string
  tool_allowlist: string
  tool_denylist: string
  vendor: string
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
  session_id: string | null
}

/**
 * Parse the `mode` column: try JSON-object first (CodexPolicy), fall back to
 * plain string (ModeToken for claude, or legacy McpMode for migrated rows).
 */
function parseMode(raw: string | null): ModeToken | CodexPolicy {
  if (!raw) return 'sandboxed' // default for empty/missing
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'sandboxMode' in parsed) {
      return parsed as CodexPolicy
    }
  } catch {
    /* not JSON → treat as plain string */
  }
  return raw
}

/** Serialize mode for DB storage: CodexPolicy → JSON, string → as-is. */
function serializeMode(mode: ModeToken | CodexPolicy): string {
  if (typeof mode === 'object') return JSON.stringify(mode)
  return mode
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

/** Parse the event_reason_filter column to a reason list; null/blank/[] → null (= any reason). */
function parseReasonFilter(raw: string | null): RunEndReason[] | null {
  const list = parseStringList(raw).filter(
    (x): x is RunEndReason => x === 'complete' || x === 'error' || x === 'aborted',
  )
  return list.length ? list : null
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
    triggerType: (r.trigger_type as ScheduleTriggerType | null) ?? 'cron',
    cronExpression: r.cron_expression,
    nextRunAt: r.next_run_at,
    eventTopic: (r.event_topic as RunLifecycleTopic | null) ?? null,
    eventReasonFilter: parseReasonFilter(r.event_reason_filter),
    status: r.status as ScheduleStatus,
    mode: parseMode(r.mode),
    toolAllowlist: parseStringList(r.tool_allowlist),
    toolDenylist: parseStringList(r.tool_denylist),
    vendor: r.vendor as VendorId,
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
    sessionId: r.session_id,
  }
}

export interface AgentQuotaRecoveryConfig {
  internalAction: typeof AGENT_RECOVERY_ACTION
  agentId: string
  resetAt: number
}

export function isAgentQuotaRecoveryConfig(config: unknown): config is AgentQuotaRecoveryConfig {
  if (!config || typeof config !== 'object') return false
  const record = config as Record<string, unknown>
  return (
    record.internalAction === AGENT_RECOVERY_ACTION &&
    typeof record.agentId === 'string' &&
    typeof record.resetAt === 'number' &&
    Number.isFinite(record.resetAt)
  )
}

export function isAgentQuotaRecoverySchedule(schedule: Schedule): boolean {
  return schedule.type === 'command' && isAgentQuotaRecoveryConfig(schedule.config)
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

/**
 * Count a workspace's schedules — `total` rows and the `active` subset — optionally
 * restricted to rows whose `updated_at` falls in `[startTime, endTime]` (ms epoch;
 * either bound may be omitted). Returns zeros when the db is unavailable.
 */
export function countSchedulesInRange(
  workspacePath: string,
  startTime?: number,
  endTime?: number,
): { total: number; active: number } {
  const d = db()
  if (!d) return { total: 0, active: 0 }
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
  const row = d.get<{ total: number; active: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active
       FROM schedules WHERE ${where.join(' AND ')}`,
    ...params,
  )
  return { total: row?.total ?? 0, active: row?.active ?? 0 }
}

/**
 * Number of a workspace's schedules that currently have a live (`status='running'`)
 * execution log. A live-"now" notion — independent of any time range. Zero when
 * the db is unavailable.
 */
export function countRunningSchedules(workspacePath: string): number {
  const d = db()
  if (!d) return 0
  const row = d.get<{ count: number }>(
    `SELECT COUNT(DISTINCT s.id) AS count
       FROM schedules s
       JOIN schedule_execution_logs l ON l.schedule_id = s.id
      WHERE s.workspace_path=? AND l.status='running'`,
    resolve(workspacePath),
  )
  return row?.count ?? 0
}

/**
 * Insert a schedule with status `active` and return the hydrated row.
 *
 * `generatedName` is the server-derived display name written to `config.name`;
 * the client never supplies a name. When omitted, a deterministic fallback is
 * derived from the task content so `config.name` is always non-empty.
 */
export function createSchedule(input: CreateScheduleInput, generatedName?: string): Schedule {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const allowlist = input.toolAllowlist ?? []
  const denylist = input.toolDenylist ?? []
  const vendor = input.vendor ?? 'claude'
  const config = sanitizeConfig(input.config)
  config.name = (generatedName ?? '').trim() || fallbackName(input.type, input.config)
  // Event-triggered schedules carry no cron and never have a planned next_run_at:
  // they fire from the run lifecycle bus, not the tick loop. Cron schedules keep
  // the existing backfill (getDueSchedules filters `next_run_at IS NULL`, so the
  // first run would never fire without it). Invalid crons stay null (never due)
  // rather than throwing and rejecting the create.
  const triggerType: ScheduleTriggerType = input.triggerType ?? 'cron'
  const isEvent = triggerType === 'event'
  const cronExpression = isEvent ? '' : input.cronExpression
  const nextRunAt =
    !isEvent && isValidCron(cronExpression)
      ? computeNextRunAt(cronExpression, now, getTimezone())
      : null
  const eventTopic = isEvent ? (input.eventTopic ?? null) : null
  const eventReasonFilter =
    isEvent && input.eventReasonFilter && input.eventReasonFilter.length
      ? JSON.stringify(input.eventReasonFilter)
      : null
  d.run(
    `INSERT INTO schedules
       (id, type, config, workspace_path, trigger_type, cron_expression, next_run_at, event_topic, event_reason_filter, status, mode, tool_allowlist, tool_denylist, vendor, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.type,
    JSON.stringify(config),
    resolve(input.workspacePath),
    triggerType,
    cronExpression,
    nextRunAt,
    eventTopic,
    eventReasonFilter,
    'active',
    serializeMode(input.mode),
    JSON.stringify(allowlist),
    JSON.stringify(denylist),
    vendor,
    now,
    now,
  )
  return getSchedule(id)!
}

export function createAgentQuotaRecoverySchedule(input: {
  workspacePath: string
  agentId: string
  resetAt: number
}): Schedule {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimezone(),
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(input.resetAt))
  const byType: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') byType[part.type] = Number.parseInt(part.value, 10)
  }
  const schedule = createSchedule(
    {
      type: 'command',
      config: {
        internalAction: AGENT_RECOVERY_ACTION,
        agentId: input.agentId,
        resetAt: input.resetAt,
      } satisfies AgentQuotaRecoveryConfig,
      workspacePath: input.workspacePath,
      cronExpression: `${byType.minute} ${byType.hour} ${byType.day} ${byType.month} *`,
      mode: 'read-only',
      vendor: 'claude',
      toolAllowlist: [],
      toolDenylist: [],
    },
    `Restore agent ${input.agentId}`,
  )
  updateNextRunAt(schedule.id, input.resetAt)
  return getSchedule(schedule.id) ?? schedule
}

/**
 * Partial update of a schedule. Only provided fields are changed.
 *
 * `nameOverride` resolves `config.name` on this update (the handler derives it
 * from the client-supplied `config.name`: a non-empty title → `source:'user'`
 * sticky name; a cleared title → a freshly-derived `source:'auto'` name). When
 * omitted, the existing name AND its `nameSource` are preserved — so a body-only
 * update never re-derives, and a manually-set name stays sticky.
 */
export function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
  nameOverride?: ScheduleNameOverride,
): void {
  const d = requireDb()
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.type !== undefined) {
    sets.push('type=?')
    params.push(patch.type)
  }
  if (patch.config !== undefined) {
    // `name`/`nameSource` are server-owned (sanitizeConfig strips any client
    // copy). Resolve them from nameOverride, else preserve the existing values.
    const existing = getSchedule(id)
    const prev =
      existing && existing.config && typeof existing.config === 'object'
        ? (existing.config as Record<string, unknown>)
        : undefined
    const next = sanitizeConfig(patch.config)
    if (nameOverride) {
      next.name = nameOverride.name
      // Only the 'user' marker is persisted; absence means auto (the default).
      if (nameOverride.source === 'user') next.nameSource = 'user'
    } else {
      if (typeof prev?.name === 'string' && prev.name.trim()) next.name = prev.name
      if (prev?.nameSource === 'user') next.nameSource = 'user'
    }
    sets.push('config=?')
    params.push(JSON.stringify(next))
  }
  // Trigger-type switch: clear the fields that don't belong to the new type so a
  // schedule never carries stale cron AND event state. Switching to 'event' drops
  // cron + next_run_at; switching to 'cron' drops the event subscription fields.
  // The form only sends the fields matching the chosen type, so no column is set twice.
  if (patch.triggerType !== undefined) {
    sets.push('trigger_type=?')
    params.push(patch.triggerType)
    if (patch.triggerType === 'event') {
      sets.push('cron_expression=?')
      params.push('')
      sets.push('next_run_at=?')
      params.push(null)
    } else {
      sets.push('event_topic=?')
      params.push(null)
      sets.push('event_reason_filter=?')
      params.push(null)
    }
  }
  if (patch.cronExpression !== undefined) {
    sets.push('cron_expression=?')
    params.push(patch.cronExpression)
    // Recompute next_run_at so the new cron takes effect on the next tick rather
    // than firing against the previous expression's stale timestamp.
    sets.push('next_run_at=?')
    params.push(
      isValidCron(patch.cronExpression)
        ? computeNextRunAt(patch.cronExpression, Date.now(), getTimezone())
        : null,
    )
  }
  if (patch.eventTopic !== undefined) {
    sets.push('event_topic=?')
    params.push(patch.eventTopic)
  }
  if (patch.eventReasonFilter !== undefined) {
    sets.push('event_reason_filter=?')
    params.push(
      patch.eventReasonFilter && patch.eventReasonFilter.length
        ? JSON.stringify(patch.eventReasonFilter)
        : null,
    )
  }
  if (patch.mode !== undefined) {
    sets.push('mode=?')
    params.push(serializeMode(patch.mode))
  }
  if (patch.vendor !== undefined) {
    sets.push('vendor=?')
    params.push(patch.vendor)
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

/**
 * All active event-triggered schedules subscribed to a given run lifecycle topic.
 * Used by the scheduler's event dispatch path (2026-06-08); cron schedules are
 * excluded by the `trigger_type='event'` filter.
 */
export function getEventSchedules(topic: RunLifecycleTopic): Schedule[] {
  const d = db()
  if (!d) return []
  return d
    .all<ScheduleRow>(
      "SELECT * FROM schedules WHERE status='active' AND trigger_type='event' AND event_topic=?",
      topic,
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
    sessionId?: string | null
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
  if (patch.sessionId !== undefined) {
    sets.push('session_id=?')
    params.push(patch.sessionId)
  }

  if (sets.length === 0) return
  params.push(id)
  d.run(`UPDATE schedule_execution_logs SET ${sets.join(', ')} WHERE id=?`, ...params)
}

// ---- Execution logs ----

/** Append an execution log entry for a schedule with `running` status. */
export function appendExecutionLog(
  input: Omit<ScheduleExecutionLog, 'id' | 'status' | 'sessionId'> & {
    status?: string | null
    sessionId?: string | null
  },
): ScheduleExecutionLog {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  d.run(
    `INSERT INTO schedule_execution_logs
       (id, schedule_id, started_at, finished_at, exit_code, output, error, status, session_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.scheduleId,
    input.startedAt,
    input.finishedAt ?? null,
    input.exitCode ?? null,
    input.output ?? '',
    input.error ?? null,
    input.status ?? 'running',
    input.sessionId ?? null,
  )
  // Refresh the parent schedule's updated_at so list ordering reflects activity.
  d.run('UPDATE schedules SET updated_at=? WHERE id=?', now, input.scheduleId)
  return { id, ...input, status: input.status ?? 'running', sessionId: input.sessionId ?? null }
}

/** Get a single execution log by id (null if absent or db unavailable). */
export function getExecutionLog(id: string): ScheduleExecutionLog | null {
  const d = db()
  if (!d) return null
  const row = d.get<ExecutionLogRow>('SELECT * FROM schedule_execution_logs WHERE id=?', id)
  return row ? toExecutionLog(row) : null
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

// ---- Workspace MCP configs ----

interface WorkspaceMcpConfigRow {
  workspace_path: string
  config_json: string
  updated_at: number
}

function toWorkspaceMcpConfig(r: WorkspaceMcpConfigRow): WorkspaceMcpConfig {
  let config: WorkspaceMcpConfig = { mcpServers: {}, denylist: [] }
  try {
    const parsed = JSON.parse(r.config_json)
    if (parsed && typeof parsed === 'object') {
      config = {
        mcpServers: parsed.mcpServers ?? {},
        denylist: Array.isArray(parsed.denylist)
          ? parsed.denylist.filter((x: unknown): x is string => typeof x === 'string')
          : [],
      }
    }
  } catch {
    /* ignore corrupt config */
  }
  return config
}

/** Get workspace-level MCP configuration (empty default if not set). */
export function getWorkspaceMcpConfig(workspacePath: string): WorkspaceMcpConfig {
  const d = db()
  if (!d) return { mcpServers: {}, denylist: [] }
  const abs = resolve(workspacePath)
  const row = d.get<WorkspaceMcpConfigRow>(
    'SELECT * FROM workspace_mcp_configs WHERE workspace_path=?',
    abs,
  )
  if (!row) return { mcpServers: {}, denylist: [] }
  return toWorkspaceMcpConfig(row)
}

/** Save workspace-level MCP configuration (upsert). */
export function saveWorkspaceMcpConfig(workspacePath: string, config: WorkspaceMcpConfig): void {
  const d = requireDb()
  const abs = resolve(workspacePath)
  const now = Date.now()
  const json = JSON.stringify({
    mcpServers: config.mcpServers ?? {},
    denylist: config.denylist ?? [],
  })
  d.run(
    `INSERT INTO workspace_mcp_configs (workspace_path, config_json, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(workspace_path) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`,
    abs,
    json,
    now,
  )
}
