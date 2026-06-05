import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { appendExecutionLog, listExecutionLogs, resetStoreForTests } from './store.js'

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
 * shared global `PRAGMA user_version`. A sibling store (requirements, v5) stamps
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
  // Mimic a sibling store (requirements, SCHEMA_VERSION=5) having clobbered the
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
