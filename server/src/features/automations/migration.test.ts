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
 * Oldest start point: a db still carrying the pre-rename `schedules` /
 * `schedule_execution_logs` table names and the `schedule_id` log column. The
 * rename MUST run before the base `CREATE TABLE IF NOT EXISTS automations` so the
 * old rows are carried into the new names rather than orphaned behind a fresh
 * empty table. Data rows must stay readable through the renamed tables afterwards.
 */
function seedLegacyNamedTables(d: Db): void {
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
    CREATE TABLE schedule_execution_logs (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      exit_code     INTEGER,
      output        TEXT NOT NULL DEFAULT '',
      error         TEXT
    );
  `)
  d.run(
    `INSERT INTO schedules
       (id, type, config, workspace_path, cron_expression, next_run_at, status, mcp_mode, tool_allowlist, tool_denylist, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'old-named',
    'command',
    JSON.stringify({ command: 'echo hi', name: 'Legacy Named' }),
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
  d.run(
    `INSERT INTO schedule_execution_logs
       (id, schedule_id, started_at, finished_at, exit_code, output, error)
     VALUES (?,?,?,?,?,?,?)`,
    'log-1',
    'old-named',
    10,
    20,
    0,
    'done',
    null,
  )
  d.exec('PRAGMA user_version=5;')
}

describe('automation store legacy table-name rename migration', () => {
  it('renames schedules / schedule_execution_logs (+ schedule_id column) and keeps rows readable', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedLegacyNamedTables(raw!)
    resetStoreForTests()

    // Reading the old-named row triggers the rename + migration on this connection.
    const legacy = getAutomation('old-named')
    expect(legacy).not.toBeNull()
    expect(legacy!.cronExpression).toBe('0 8 * * *')
    expect(legacy!.triggerType).toBe('cron')

    // The tables now carry the new names, and the old-named ones are gone.
    expect(raw!.all<{ name: string }>('PRAGMA table_info(automations)').length).toBeGreaterThan(0)
    expect(raw!.all<{ name: string }>('PRAGMA table_info(schedules)')).toHaveLength(0)
    const logCols = raw!.all<{ name: string }>('PRAGMA table_info(automation_execution_logs)')
    expect(logCols.some((c) => c.name === 'automation_id')).toBe(true)
    expect(logCols.some((c) => c.name === 'schedule_id')).toBe(false)

    // The pre-existing execution log row survived the rename and reads back through
    // the renamed automation_id column.
    const logs = listExecutionLogs('old-named')
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('log-1')
    expect(logs[0].output).toBe('done')
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
    // event subscription rows (cron rows never carry any).
    expect(legacy!.triggerType).toBe('cron')
    expect(legacy!.eventFilters).toBeNull()
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
      eventFilters: [{ type: 'run:settled', statuses: ['error'] }],
      eventSessionKindFilter: ['work'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(ev.triggerType).toBe('event')
    expect(getEventAutomations('run:settled').map((s) => s.id)).toContain(ev.id)

    // And a pr:<op> automation with per-operation rows can also be created + queried.
    const pr = createAutomation({
      type: 'command',
      config: { command: 'echo pr' },
      workspaceId: '/abs/ws',
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'pr:merge', statuses: ['success'] }],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(pr.eventFilters).toEqual([{ type: 'pr:merge', statuses: ['success'] }])
    expect(getEventAutomations('pr:merge').map((s) => s.id)).toContain(pr.id)
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
    // generic filter carrying only the type, and the v13 backfill wraps it into a
    // one-row subscription list (no statuses, no metadata).
    expect(evt!.metadata).toEqual({})
    expect(evt!.eventFilters).toEqual([{ type: 'run:settled' }])

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
  it('projects each retired per-topic column through v12+v13 to equivalent subscription rows', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    // Reading a row triggers schema init + the v12 AND v13 backfills on this
    // connection, so a v11-era row lands directly in `eventFilters` with the
    // renamed `<category>:<action>` types.
    expect(getAutomation('mig-settled')!.eventFilters).toEqual([
      {
        type: 'run:settled',
        statuses: ['error', 'aborted'],
        metadata: { conditions: [{ key: 'stage', value: 'a' }], combinator: 'AND' },
      },
    ])
    expect(getAutomation('mig-started')!.eventFilters).toEqual([{ type: 'run:started' }])
    // The v12 pure-operation OR filter splits into one pr:<op> row per operation.
    expect(getAutomation('mig-pr')!.eventFilters).toEqual([
      { type: 'pr:merge', statuses: ['success'] },
      { type: 'pr:close', statuses: ['success'] },
    ])
    // The intent phase moves from the status dimension into the type itself.
    expect(getAutomation('mig-intent')!.eventFilters).toEqual([{ type: 'intent:done' }])

    // The retired columns are still present as migration input.
    const names = raw!.all<{ name: string }>('PRAGMA table_info(automations)').map((c) => c.name)
    expect(names).toContain('event_filter')
    expect(names).toContain('event_filters')
    expect(names).toContain('event_topic')
    expect(names).toContain('event_reason_filter')
  })

  it('does not throw on corrupt legacy JSON and leaves that dimension wildcarded', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    // Corrupt event_reason_filter degrades to "any reason": the projected row
    // keeps the type but carries no statuses (never tightened to an empty set).
    expect(() => getAutomation('mig-corrupt')).not.toThrow()
    expect(getAutomation('mig-corrupt')!.eventFilters).toEqual([{ type: 'run:settled' }])
  })

  it('is idempotent: re-running schema init never overwrites the backfilled rows', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV11AutomationsTable(raw!)
    resetStoreForTests()

    const first = getAutomation('mig-pr')!.eventFilters
    expect(first).not.toBeNull()

    // Mutate a retired column to a DIFFERENT hit set, then force a second schema
    // init: the backfills only fill rows whose event_filter / event_filters are
    // still NULL, so the value written by the first migration is preserved
    // (never re-projected / widened).
    raw!.run(
      `UPDATE automations SET event_pr_filter=? WHERE id=?`,
      JSON.stringify({ operations: ['create'], results: ['failure'] }),
      'mig-pr',
    )
    resetStoreForTests()

    expect(getAutomation('mig-pr')!.eventFilters).toEqual(first)
  })
})

/**
 * v13 (2026-07-14): `<category>:<action>` event types + multi-row subscriptions.
 * Seed a v12-era table (single generic `event_filter` present and populated, no
 * `event_filters` yet) and let a store read trigger the backfill; each v12 filter
 * must project to subscription rows preserving its exact hit set under the
 * renamed types (pr:operation → pr:<op>/pr:*, intent:lifecycle → intent:<phase>/
 * intent:*, run + custom types pass through as one-row lists).
 */
function seedV12AutomationsTable(d: Db): void {
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
      event_filter              TEXT,
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
  const insert = (id: string, filter: unknown): void => {
    d.run(
      `INSERT INTO automations
         (id, type, config, workspace_path, trigger_type, cron_expression, next_run_at,
          event_filter, status, mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      'command',
      JSON.stringify({ command: 'echo hi', name: id }),
      '/abs/ws',
      'event',
      '',
      null,
      JSON.stringify(filter),
      'active',
      'sandboxed',
      1,
      1,
    )
  }
  // pr:operation with a pure `operation` OR → one pr:<op> row per operation.
  insert('v13-pr-or', {
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
  // pr:operation with a mixed/AND metadata shape → one pr:* row, filter verbatim.
  insert('v13-pr-mixed', {
    type: 'pr:operation',
    statuses: ['failure'],
    metadata: {
      conditions: [
        { key: 'operation', value: 'merge' },
        { key: 'author', value: 'bot' },
      ],
      combinator: 'AND',
    },
  })
  // pr:operation with no operation condition at all → one pr:* row, metadata kept.
  insert('v13-pr-nometaop', {
    type: 'pr:operation',
    metadata: { conditions: [{ key: 'author', value: 'bot' }], combinator: 'OR' },
  })
  // intent:lifecycle phases (statuses) → one intent:<phase> row each, metadata kept.
  insert('v13-intent-phases', {
    type: 'intent:lifecycle',
    statuses: ['done', 'failed'],
    metadata: { conditions: [{ key: 'module', value: 'web' }], combinator: 'AND' },
  })
  // intent:lifecycle with no phases = any phase → one intent:* row.
  insert('v13-intent-any', { type: 'intent:lifecycle' })
  // run-lifecycle and custom types pass through unchanged as one-row lists.
  insert('v13-run', { type: 'run:settled', statuses: ['error'] })
  insert('v13-custom', {
    type: 'custom:thing',
    statuses: ['ok'],
    metadata: { conditions: [{ key: 'k', value: 'v' }], combinator: 'AND' },
  })
  d.exec('PRAGMA user_version=12;')
}

describe('automation store v13 (event_filters subscription rows) migration', () => {
  it('splits a pure-operation OR pr:operation filter into per-operation rows', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV12AutomationsTable(raw!)
    resetStoreForTests()

    expect(getAutomation('v13-pr-or')!.eventFilters).toEqual([
      { type: 'pr:merge', statuses: ['success'] },
      { type: 'pr:close', statuses: ['success'] },
    ])
  })

  it('falls back to a single pr:* row for a mixed metadata shape, keeping the filter verbatim', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV12AutomationsTable(raw!)
    resetStoreForTests()

    // Semantics-preserving: the renamed PR events still carry metadata.operation,
    // so the untouched AND filter keeps its exact hit set under the wildcard type.
    expect(getAutomation('v13-pr-mixed')!.eventFilters).toEqual([
      {
        type: 'pr:*',
        statuses: ['failure'],
        metadata: {
          conditions: [
            { key: 'operation', value: 'merge' },
            { key: 'author', value: 'bot' },
          ],
          combinator: 'AND',
        },
      },
    ])
    expect(getAutomation('v13-pr-nometaop')!.eventFilters).toEqual([
      {
        type: 'pr:*',
        metadata: { conditions: [{ key: 'author', value: 'bot' }], combinator: 'OR' },
      },
    ])
  })

  it('moves intent phases into intent:<phase> rows and no phases into intent:*', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV12AutomationsTable(raw!)
    resetStoreForTests()

    expect(getAutomation('v13-intent-phases')!.eventFilters).toEqual([
      {
        type: 'intent:done',
        metadata: { conditions: [{ key: 'module', value: 'web' }], combinator: 'AND' },
      },
      {
        type: 'intent:failed',
        metadata: { conditions: [{ key: 'module', value: 'web' }], combinator: 'AND' },
      },
    ])
    expect(getAutomation('v13-intent-any')!.eventFilters).toEqual([{ type: 'intent:*' }])
  })

  it('passes run-lifecycle and custom filters through as one-row lists', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV12AutomationsTable(raw!)
    resetStoreForTests()

    expect(getAutomation('v13-run')!.eventFilters).toEqual([
      { type: 'run:settled', statuses: ['error'] },
    ])
    expect(getAutomation('v13-custom')!.eventFilters).toEqual([
      {
        type: 'custom:thing',
        statuses: ['ok'],
        metadata: { conditions: [{ key: 'k', value: 'v' }], combinator: 'AND' },
      },
    ])
  })

  it('is idempotent: a second schema init never overwrites existing event_filters', () => {
    const raw = getDb()
    expect(raw).not.toBeNull()
    seedV12AutomationsTable(raw!)
    resetStoreForTests()

    const first = getAutomation('v13-pr-or')!.eventFilters
    expect(first).not.toBeNull()

    // Mutate the v12 input to a DIFFERENT hit set, then force a second schema
    // init: the backfill only fills rows whose event_filters IS NULL, so the
    // rows written by the first migration are preserved.
    raw!.run(
      `UPDATE automations SET event_filter=? WHERE id=?`,
      JSON.stringify({ type: 'pr:operation', statuses: ['error'] }),
      'v13-pr-or',
    )
    resetStoreForTests()

    expect(getAutomation('v13-pr-or')!.eventFilters).toEqual(first)
  })
})
