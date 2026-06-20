import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The store maps `workspace_path` <-> opaque `workspaceId` through the registry;
// in isolation these synthetic paths are unregistered, so stub resolve/pathToId
// as identity — fixtures use the path itself as the id and round-trip cleanly.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import {
  appendExecutionLog,
  createSchedule,
  getEventSchedules,
  getSchedule,
  listExecutionLogs,
  resetStoreForTests,
} from './store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-mig-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Regression: the schedule store must NOT gate its column migrations on the
 * shared global `PRAGMA user_version`. A sibling store (intents, v5) stamps
 * user_version to 5; if the schedule store trusted that counter it would skip the
 * v3→v4 `session_id` ALTER and leave old tables without the column, crashing
 * appendExecutionLog with "no column named session_id".
 */
function seedOldDb(d: Db): void {
  // An old `schedule_execution_logs` table predating the session_id column.
  d.exec(`
    CREATE TABLE schedule_execution_logs (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      exit_code     INTEGER,
      output        TEXT NOT NULL DEFAULT '',
      error         TEXT,
      status        TEXT NOT NULL DEFAULT 'running'
    );
  `)
  // Mimic a sibling store (intents, SCHEMA_VERSION=5) having clobbered the
  // shared version counter past the schedule store's own version (4).
  d.exec('PRAGMA user_version=5;')
}

describe('schedule store schema migration', () => {
  it('backfills session_id on an old db even when user_version is already past 4', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedOldDb(raw!)
    // schemaReady is false → the next store call triggers SCHEMA + runMigrations
    // on this existing connection.
    resetStoreForTests()

    const log = appendExecutionLog({
      scheduleId: 's1',
      startedAt: 1,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      sessionId: 'sess-abc',
    })
    expect(log.sessionId).toBe('sess-abc')

    // The column now exists and the value round-trips.
    const cols = raw!.all<{ name: string }>('PRAGMA table_info(schedule_execution_logs)')
    expect(cols.some((c) => c.name === 'session_id')).toBe(true)
    const [loaded] = listExecutionLogs('s1')
    expect(loaded.sessionId).toBe('sess-abc')
  })
})

/**
 * v5 (2026-06-08): event-trigger columns. An old `schedules` table predating
 * trigger_type / event_topic / event_reason_filter must be backfilled so legacy
 * cron rows keep working (trigger_type defaults to 'cron') and event schedules
 * can be created afterwards — even though user_version is already past 5.
 */
function seedOldSchedulesTable(d: Db): void {
  d.exec(`
    CREATE TABLE schedules (
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
  `)
  d.run(
    `INSERT INTO schedules
       (id, type, config, workspace_path, cron_expression, next_run_at, status, mcp_mode, tool_allowlist, tool_denylist, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'legacy-cron',
    'command',
    JSON.stringify({ command: 'echo hi', name: 'Legacy', timeout: 120_000 }),
    '/abs/ws',
    '0 8 * * *',
    null,
    'active',
    'sandboxed',
    '[]',
    '[]',
    1,
    1,
  )
  d.exec('PRAGMA user_version=5;')
}

describe('schedule store v5 (event-trigger) migration', () => {
  it('backfills trigger columns and keeps legacy cron rows working', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedOldSchedulesTable(raw!)
    resetStoreForTests()

    // Reading the legacy row triggers the migration on this connection.
    const legacy = getSchedule('legacy-cron')
    expect(legacy).not.toBeNull()
    // A row written before the column existed defaults to a cron trigger.
    expect(legacy!.triggerType).toBe('cron')
    expect(legacy!.eventTopic).toBeNull()
    expect(legacy!.eventReasonFilter).toBeNull()
    expect(legacy!.cronExpression).toBe('0 8 * * *')
    expect(legacy!.maxWallClockMs).toBe(120_000)

    const cols = raw!.all<{ name: string }>('PRAGMA table_info(schedules)')
    const names = cols.map((c) => c.name)
    expect(names).toContain('trigger_type')
    expect(names).toContain('event_topic')
    expect(names).toContain('event_reason_filter')
    expect(names).toContain('max_wall_clock_ms')

    // The legacy cron row is NOT picked up by the event-schedule query.
    expect(getEventSchedules('run:settled')).toHaveLength(0)

    // And a fresh event schedule can be created on the migrated table.
    const ev = createSchedule({
      type: 'command',
      config: { command: 'echo done' },
      workspaceId: '/abs/ws',
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventReasonFilter: ['error'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(ev.triggerType).toBe('event')
    expect(getEventSchedules('run:settled').map((s) => s.id)).toContain(ev.id)
  })
})
