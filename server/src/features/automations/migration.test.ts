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
  createAutomation,
  getEventAutomations,
  getAutomation,
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
 * Regression: the automation store must NOT gate its column migrations on the
 * shared global `PRAGMA user_version`. A sibling store (intents, v5) stamps
 * user_version to 5; if the automation store trusted that counter it would skip the
 * v3→v4 `session_id` ALTER and leave old tables without the column, crashing
 * appendExecutionLog with "no column named session_id".
 */
function seedOldDb(d: Db): void {
  // An old `automation_execution_logs` table predating the session_id column.
  d.exec(`
    CREATE TABLE automation_execution_logs (
      id            TEXT PRIMARY KEY,
      automation_id   TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      exit_code     INTEGER,
      output        TEXT NOT NULL DEFAULT '',
      error         TEXT,
      status        TEXT NOT NULL DEFAULT 'running'
    );
  `)
  // Mimic a sibling store (intents, SCHEMA_VERSION=5) having clobbered the
  // shared version counter past the automation store's own version (4).
  d.exec('PRAGMA user_version=5;')
}

describe('automation store schema migration', () => {
  it('backfills session_id on an old db even when user_version is already past 4', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedOldDb(raw!)
    // schemaReady is false → the next store call triggers SCHEMA + runMigrations
    // on this existing connection.
    resetStoreForTests()

    const log = appendExecutionLog({
      automationId: 's1',
      startedAt: 1,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      sessionId: 'sess-abc',
    })
    expect(log.sessionId).toBe('sess-abc')

    // The column now exists and the value round-trips.
    const cols = raw!.all<{ name: string }>('PRAGMA table_info(automation_execution_logs)')
    expect(cols.some((c) => c.name === 'session_id')).toBe(true)
    const [loaded] = listExecutionLogs('s1')
    expect(loaded.sessionId).toBe('sess-abc')
  })
})

/**
 * v5 (2026-06-08): event-trigger columns. An old `automations` table predating
 * trigger_type / event_topic / event_reason_filter must be backfilled so legacy
 * cron rows keep working (trigger_type defaults to 'cron') and event automations
 * can be created afterwards — even though user_version is already past 5.
 */
function seedOldAutomationsTable(d: Db): void {
  d.exec(`
    CREATE TABLE automations (
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
    `INSERT INTO automations
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

describe('automation store v5 (event-trigger) migration', () => {
  it('backfills trigger columns and keeps legacy cron rows working', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedOldAutomationsTable(raw!)
    resetStoreForTests()

    // Reading the legacy row triggers the migration on this connection.
    const legacy = getAutomation('legacy-cron')
    expect(legacy).not.toBeNull()
    // A row written before the column existed defaults to a cron trigger with no
    // generic event filter (cron rows never carry one).
    expect(legacy!.triggerType).toBe('cron')
    expect(legacy!.eventFilter).toBeNull()
    expect(legacy!.cronExpression).toBe('0 8 * * *')
    expect(legacy!.maxWallClockMs).toBe(120_000)

    const cols = raw!.all<{ name: string }>('PRAGMA table_info(automations)')
    const names = cols.map((c) => c.name)
    expect(names).toContain('trigger_type')
    expect(names).toContain('event_topic')
    expect(names).toContain('event_reason_filter')
    expect(names).toContain('event_pr_filter')
    expect(names).toContain('max_wall_clock_ms')

    // The legacy cron row is NOT picked up by the event-automation query.
    expect(getEventAutomations('run:settled')).toHaveLength(0)

    // And a fresh event automation can be created on the migrated table.
    const ev = createAutomation({
      type: 'command',
      config: { command: 'echo done' },
      workspaceId: '/abs/ws',
      triggerType: 'event',
      cronExpression: '',
      eventFilter: { type: 'run:settled', statuses: ['error'] },
      eventSessionKindFilter: ['work'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(ev.triggerType).toBe('event')
    expect(getEventAutomations('run:settled').map((s) => s.id)).toContain(ev.id)

    // And a pr:operation automation with a PR filter can also be created + queried.
    const pr = createAutomation({
      type: 'command',
      config: { command: 'echo pr' },
      workspaceId: '/abs/ws',
      triggerType: 'event',
      cronExpression: '',
      eventFilter: {
        type: 'pr:operation',
        statuses: ['success'],
        metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
      },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(pr.eventFilter).toEqual({
      type: 'pr:operation',
      statuses: ['success'],
      metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
    })
    expect(getEventAutomations('pr:operation').map((s) => s.id)).toContain(pr.id)
  })
})

/**
 * v11 (2026-07-04): metadata + sessionKind / metadata event-trigger filters. An
 * old table (v10 era: has trigger_type + event_topic but no session-kind / metadata
 * columns) with a run-lifecycle event automation must backfill its
 * event_session_kind_filter to an explicit ['work'] — the persisted equivalent of
 * the removed hardcoded whitelist — so its behaviour is not widened.
 */
function seedV10AutomationsTable(d: Db): void {
  d.exec(`
    CREATE TABLE automations (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL,
      config              TEXT NOT NULL DEFAULT '{}',
      max_wall_clock_ms   INTEGER,
      workspace_path      TEXT NOT NULL,
      trigger_type        TEXT NOT NULL DEFAULT 'cron',
      cron_expression     TEXT NOT NULL,
      next_run_at         INTEGER,
      event_topic         TEXT,
      event_reason_filter TEXT,
      event_pr_filter     TEXT,
      event_intent_filter TEXT,
      status              TEXT NOT NULL,
      mode                TEXT NOT NULL DEFAULT '',
      tool_allowlist      TEXT NOT NULL DEFAULT '[]',
      tool_denylist       TEXT NOT NULL DEFAULT '[]',
      vendor              TEXT NOT NULL DEFAULT 'claude',
      agent_id            TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
  `)
  // A legacy run-lifecycle event automation (pre-v11: no sessionKind filter column).
  d.run(
    `INSERT INTO automations
       (id, type, config, workspace_path, trigger_type, cron_expression, next_run_at, event_topic, status, mode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'legacy-evt',
    'command',
    JSON.stringify({ command: 'echo hi', name: 'Legacy evt' }),
    '/abs/ws',
    'event',
    '',
    null,
    'run:settled',
    'active',
    'sandboxed',
    1,
    1,
  )
  // A legacy cron row must NOT be backfilled with a sessionKind filter.
  d.run(
    `INSERT INTO automations
       (id, type, config, workspace_path, trigger_type, cron_expression, next_run_at, event_topic, status, mode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'legacy-cron2',
    'command',
    JSON.stringify({ command: 'echo hi', name: 'Legacy cron' }),
    '/abs/ws',
    'cron',
    '0 8 * * *',
    null,
    null,
    'active',
    'sandboxed',
    1,
    1,
  )
  d.exec('PRAGMA user_version=10;')
}

describe('automation store v11 (metadata + sessionKind/metadata filter) migration', () => {
  it('backfills run-lifecycle event automations to explicit ["work"] and leaves cron rows null', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV10AutomationsTable(raw!)
    resetStoreForTests()

    const evt = getAutomation('legacy-evt')
    expect(evt).not.toBeNull()
    // Behaviour-preserving backfill: exactly the removed hardcoded whitelist.
    expect(evt!.eventSessionKindFilter).toEqual(['work'])
    // No metadata for a legacy row; the v12 backfill projects the bare topic to a
    // generic filter carrying only the type (no statuses, no metadata).
    expect(evt!.metadata).toEqual({})
    expect(evt!.eventFilter).toEqual({ type: 'run:settled' })

    const cron = getAutomation('legacy-cron2')
    expect(cron!.eventSessionKindFilter).toBeNull()

    const cols = raw!.all<{ name: string }>('PRAGMA table_info(automations)')
    const names = cols.map((c) => c.name)
    expect(names).toContain('metadata')
    expect(names).toContain('event_session_kind_filter')
    expect(names).toContain('event_metadata_filter')
  })
})

/**
 * v12 (2026-07-13): converge the per-topic event-trigger columns (event_reason_filter
 * / event_pr_filter / event_intent_filter / event_metadata_filter) into a single
 * generic `event_filter`. Seed a v11-era table (all legacy filter columns present,
 * no `event_filter`) and let a store read trigger the backfill; the projected
 * GenericEventFilter must have the exact same hit set as the retired columns.
 */
function seedV11AutomationsTable(d: Db): void {
  d.exec(`
    CREATE TABLE automations (
      id                        TEXT PRIMARY KEY,
      type                      TEXT NOT NULL,
      config                    TEXT NOT NULL DEFAULT '{}',
      max_wall_clock_ms         INTEGER,
      workspace_path            TEXT NOT NULL,
      trigger_type              TEXT NOT NULL DEFAULT 'cron',
      cron_expression           TEXT NOT NULL,
      next_run_at               INTEGER,
      event_topic               TEXT,
      event_reason_filter       TEXT,
      event_pr_filter           TEXT,
      event_intent_filter       TEXT,
      event_session_kind_filter TEXT,
      event_metadata_filter     TEXT,
      metadata                  TEXT NOT NULL DEFAULT '{}',
      status                    TEXT NOT NULL,
      mode                      TEXT NOT NULL DEFAULT '',
      tool_allowlist            TEXT NOT NULL DEFAULT '[]',
      tool_denylist             TEXT NOT NULL DEFAULT '[]',
      vendor                    TEXT NOT NULL DEFAULT 'claude',
      agent_id                  TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL
    );
  `)
  const insert = (row: {
    id: string
    topic: string | null
    reason?: string | null
    pr?: string | null
    intent?: string | null
    meta?: string | null
    trigger?: string
  }): void => {
    d.run(
      `INSERT INTO automations
         (id, type, config, workspace_path, trigger_type, cron_expression, next_run_at,
          event_topic, event_reason_filter, event_pr_filter, event_intent_filter, event_metadata_filter,
          status, mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      'command',
      JSON.stringify({ command: 'echo hi', name: row.id }),
      '/abs/ws',
      row.trigger ?? 'event',
      '',
      null,
      row.topic,
      row.reason ?? null,
      row.pr ?? null,
      row.intent ?? null,
      row.meta ?? null,
      'active',
      'sandboxed',
      1,
      1,
    )
  }
  // run:settled — reason list → statuses; metadata filter → eventFilter.metadata.
  insert({
    id: 'mig-settled',
    topic: 'run:settled',
    reason: JSON.stringify(['error', 'aborted']),
    meta: JSON.stringify({ conditions: [{ key: 'stage', value: 'a' }], combinator: 'AND' }),
  })
  // run:started — carries no reason → type-only filter.
  insert({ id: 'mig-started', topic: 'run:started' })
  // pr:operation — results → statuses; operations → OR metadata conditions on `operation`.
  insert({
    id: 'mig-pr',
    topic: 'pr:operation',
    pr: JSON.stringify({ operations: ['merge', 'close'], results: ['success'] }),
  })
  // intent:lifecycle — phases → statuses.
  insert({
    id: 'mig-intent',
    topic: 'intent:lifecycle',
    intent: JSON.stringify({ phases: ['done'] }),
  })
  // Corrupt reason JSON must not throw and must NOT tighten (that dimension wildcards).
  insert({ id: 'mig-corrupt', topic: 'run:settled', reason: '{ not json' })
  d.exec('PRAGMA user_version=11;')
}

describe('automation store v12 (generic event_filter) migration', () => {
  it('projects each retired per-topic column to an equivalent GenericEventFilter', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    // Reading a row triggers schema init + the v12 backfill on this connection.
    expect(getAutomation('mig-settled')!.eventFilter).toEqual({
      type: 'run:settled',
      statuses: ['error', 'aborted'],
      metadata: { conditions: [{ key: 'stage', value: 'a' }], combinator: 'AND' },
    })
    expect(getAutomation('mig-started')!.eventFilter).toEqual({ type: 'run:started' })
    expect(getAutomation('mig-pr')!.eventFilter).toEqual({
      type: 'pr:operation',
      statuses: ['success'],
      metadata: {
        conditions: [
          { key: 'operation', value: 'merge' },
          { key: 'operation', value: 'close' },
        ],
        combinator: 'OR',
      },
    })
    expect(getAutomation('mig-intent')!.eventFilter).toEqual({
      type: 'intent:lifecycle',
      statuses: ['done'],
    })

    // The retired columns are still present as migration input.
    const names = raw!.all<{ name: string }>('PRAGMA table_info(automations)').map((c) => c.name)
    expect(names).toContain('event_filter')
    expect(names).toContain('event_topic')
    expect(names).toContain('event_reason_filter')
  })

  it('does not throw on corrupt legacy JSON and leaves that dimension wildcarded', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    // Corrupt event_reason_filter degrades to "any reason": the projected filter
    // keeps the type but carries no statuses (never tightened to an empty set).
    expect(() => getAutomation('mig-corrupt')).not.toThrow()
    expect(getAutomation('mig-corrupt')!.eventFilter).toEqual({ type: 'run:settled' })
  })

  it('is idempotent: re-running schema init never overwrites an existing event_filter', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    const first = getAutomation('mig-pr')!.eventFilter
    expect(first).not.toBeNull()

    // Mutate a retired column to a DIFFERENT hit set, then force a second schema
    // init: the backfill only fills rows whose event_filter IS NULL, so the value
    // written by the first migration is preserved (never re-projected / widened).
    raw!.run(
      `UPDATE automations SET event_pr_filter=? WHERE id=?`,
      JSON.stringify({ operations: ['create'], results: ['failure'] }),
      'mig-pr',
    )
    resetStoreForTests()

    expect(getAutomation('mig-pr')!.eventFilter).toEqual(first)
  })
})
