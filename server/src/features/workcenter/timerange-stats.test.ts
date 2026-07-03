/**
 * WorkCenter TimeRange rollup — store count helpers + the aggregation handler.
 *
 * Two layers under test:
 *  1. The per-store count functions (intents/discussions/automations/work-session)
 *     against a real temp db — empty, partial, time-filtered, and db-unavailable.
 *  2. `getTimeRangeStatsHandler` stitching those counts (plus the live runtime
 *     registry) into one `timerange_stats` per workspace, with `state.js`
 *     (`listWorkspaces`) mocked to a fixed project set.
 *
 * Rows are seeded with explicit SQL so `status` / `updated_at` / `last_modified`
 * are fully deterministic (the stores stamp `Date.now()` internally and offer no
 * injection hook for these tables).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import * as intentsStore from '../intents/store.js'
import * as discussionsStore from '../discussions/store.js'
import * as automationsStore from '../automations/store.js'
import * as wsStore from '../works/work-session-store.js'
import {
  ensureRuntime,
  setStatus,
  removeRuntimesForWorkspace,
  runningCountForWorkspace,
} from '../../runs.js'

// `state.js` is mocked so the handler walks exactly the workspaces we set here.
// `resolveWorkspaceRoot`/`pathToId` are identity stubs: the test uses the path as
// the opaque id, so the handler resolves each id straight back to the same path.
const hoisted = vi.hoisted(() => ({
  workspaces: [] as { id: string; name: string; lastAccessed: number }[],
}))
vi.mock('../../state.js', () => ({
  listWorkspaces: () => hoisted.workspaces,
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

import { getTimeRangeStatsHandler } from './index.js'

const A = '/abs/proj-a'
const B = '/abs/proj-b'
let dir: string

// A reference instant; ranges are built relative to it so filter boundaries are exact.
const T = 1_700_000_000_000

function resetAllStores(): void {
  intentsStore.resetStoreForTests()
  discussionsStore.resetStoreForTests()
  automationsStore.resetStoreForTests()
  wsStore.resetStoreForTests()
}

/** Touch every store once so all four tables (+ migrations) exist on this db. */
function warmSchema(): void {
  intentsStore.countByStatusInRange('/warm')
  discussionsStore.countByStatusInRange('/warm')
  automationsStore.countAutomationsInRange('/warm')
  wsStore.countRealInRange('/warm')
}

function d(): Db {
  const db = getDb()
  if (!db) throw new Error('db unavailable in test')
  return db
}

function seedIntent(proj: string, status: string, updatedAt: number): void {
  d().run(
    `INSERT INTO intents (id, workspace_path, title, content, priority, status, module, last_work_session_id, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    't',
    '',
    'medium',
    status,
    '',
    null,
    updatedAt,
    updatedAt,
    null,
  )
}

function seedDiscussion(proj: string, status: string, updatedAt: number): void {
  d().run(
    `INSERT INTO discussions (id, workspace_path, title, type, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    't',
    'brainstorm',
    status,
    updatedAt,
    updatedAt,
  )
}

function seedAutomation(proj: string, status: string, updatedAt: number): string {
  const id = randomUUID()
  d().run(
    `INSERT INTO automations (id, type, workspace_path, cron_expression, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    'command',
    proj,
    '*/5 * * * *',
    status,
    updatedAt,
    updatedAt,
  )
  return id
}

function seedExecLog(automationId: string, status: string): void {
  d().run(
    `INSERT INTO automation_execution_logs (id, automation_id, started_at, status) VALUES (?,?,?,?)`,
    randomUUID(),
    automationId,
    T,
    status,
  )
}

function seedSession(proj: string, lastModified: number | null): void {
  d().run(
    `INSERT INTO session_metadata (
       c3_id, workspace_path, vendor, agent_id, title, last_modified, state, state_updated_at,
       kind, session_kind, owner_kind, owner_id, bound
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    'claude',
    'a',
    't',
    lastModified,
    'alive',
    lastModified ?? 0,
    'real',
    'work',
    null,
    null,
    1,
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-tr-stats-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetAllStores()
  hoisted.workspaces = []
})

afterEach(() => {
  removeRuntimesForWorkspace(A)
  removeRuntimesForWorkspace(B)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('intents countByStatusInRange', () => {
  it('returns an empty map for a project with no intents', () => {
    warmSchema()
    expect(intentsStore.countByStatusInRange(A)).toEqual({})
  })

  it('groups by status, omitting statuses with no rows (partial result)', () => {
    warmSchema()
    seedIntent(A, 'todo', T)
    seedIntent(A, 'todo', T)
    seedIntent(A, 'in_progress', T)
    seedIntent(A, 'done', T)
    seedIntent(B, 'todo', T) // other project — must not leak
    expect(intentsStore.countByStatusInRange(A)).toEqual({ todo: 2, in_progress: 1, done: 1 })
  })

  it('filters by updated_at when a range is given', () => {
    warmSchema()
    seedIntent(A, 'todo', T - 1000)
    seedIntent(A, 'todo', T)
    seedIntent(A, 'todo', T + 1000)
    // Inclusive window [T-1, T+1] catches only the middle row.
    expect(intentsStore.countByStatusInRange(A, T - 1, T + 1)).toEqual({ todo: 1 })
    // Open-ended lower bound catches the two at/after T.
    expect(intentsStore.countByStatusInRange(A, T)).toEqual({ todo: 2 })
    // Open-ended upper bound catches the two at/before T.
    expect(intentsStore.countByStatusInRange(A, undefined, T)).toEqual({ todo: 2 })
  })

  it('returns an empty map when the db is unavailable', () => {
    resetDbForTests()
    resetAllStores()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    expect(intentsStore.countByStatusInRange(A)).toEqual({})
  })
})

describe('discussions countByStatusInRange', () => {
  it('groups by status within the workspace', () => {
    warmSchema()
    seedDiscussion(A, 'in_progress', T)
    seedDiscussion(A, 'completed', T)
    seedDiscussion(A, 'completed', T)
    seedDiscussion(B, 'completed', T)
    expect(discussionsStore.countByStatusInRange(A)).toEqual({ in_progress: 1, completed: 2 })
  })

  it('honours the updated_at range', () => {
    warmSchema()
    seedDiscussion(A, 'completed', T - 5000)
    seedDiscussion(A, 'completed', T + 5000)
    expect(discussionsStore.countByStatusInRange(A, T, undefined)).toEqual({ completed: 1 })
  })

  it('returns an empty map when the db is unavailable', () => {
    resetDbForTests()
    resetAllStores()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    expect(discussionsStore.countByStatusInRange(A)).toEqual({})
  })
})

describe('automations counts', () => {
  it('counts total + active rows and honours the range', () => {
    warmSchema()
    seedAutomation(A, 'active', T)
    seedAutomation(A, 'active', T)
    seedAutomation(A, 'paused', T)
    seedAutomation(A, 'active', T + 10_000) // outside the window below
    seedAutomation(B, 'active', T) // other project
    expect(automationsStore.countAutomationsInRange(A)).toEqual({ total: 4, active: 3 })
    expect(automationsStore.countAutomationsInRange(A, T - 1, T + 1)).toEqual({
      total: 3,
      active: 2,
    })
  })

  it('counts automations with a running execution log (distinct, range-independent)', () => {
    warmSchema()
    const s1 = seedAutomation(A, 'active', T)
    const s2 = seedAutomation(A, 'active', T)
    seedAutomation(A, 'active', T) // no logs
    seedExecLog(s1, 'running')
    seedExecLog(s1, 'running') // two running logs on one automation → still counts once
    seedExecLog(s2, 'success') // not running
    expect(automationsStore.countRunningAutomations(A)).toBe(1)
    seedExecLog(s2, 'running')
    expect(automationsStore.countRunningAutomations(A)).toBe(2)
  })

  it('degrades to zeros when the db is unavailable', () => {
    resetDbForTests()
    resetAllStores()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    expect(automationsStore.countAutomationsInRange(A)).toEqual({ total: 0, active: 0 })
    expect(automationsStore.countRunningAutomations(A)).toBe(0)
  })
})

describe('work-session countRealInRange', () => {
  it('counts real rows and honours the last_modified range', () => {
    warmSchema()
    seedSession(A, T - 1000)
    seedSession(A, T + 1000)
    seedSession(A, null) // null last_modified
    seedSession(B, T) // other project
    // No bounds: every real row counts, including the null one.
    expect(wsStore.countRealInRange(A)).toBe(3)
    // A bound excludes null last_modified and out-of-range rows.
    expect(wsStore.countRealInRange(A, T, undefined)).toBe(1)
    expect(wsStore.countRealInRange(A, undefined, T)).toBe(1)
  })

  it('returns 0 when the db is unavailable', () => {
    resetDbForTests()
    resetAllStores()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    expect(wsStore.countRealInRange(A)).toBe(0)
  })
})

describe('runningCountForWorkspace (runtime registry)', () => {
  it('counts only non-idle runtimes scoped to the workspace', () => {
    ensureRuntime('s-run', A, 'default', [])
    setStatus('s-run', 'running')
    ensureRuntime('s-idle', A, 'default', []) // stays idle
    ensureRuntime('s-other', B, 'default', [])
    setStatus('s-other', 'running')
    expect(runningCountForWorkspace(A)).toBe(1)
    expect(runningCountForWorkspace(B)).toBe(1)
    expect(runningCountForWorkspace('/abs/proj-none')).toBe(0)
  })
})

describe('getTimeRangeStatsHandler', () => {
  function fakeCtx() {
    return {} as never
  }
  function fakeConn() {
    return { send: vi.fn() } as never
  }
  function sentStats(conn: { send: ReturnType<typeof vi.fn> }) {
    expect(conn.send).toHaveBeenCalledTimes(1)
    const msg = conn.send.mock.calls[0][0]
    expect(msg.type).toBe('timerange_stats')
    return msg.stats as import('@ccc/shared/protocol').TimeRangeProjectStats[]
  }

  it('aggregates every workspace into one entry each', () => {
    warmSchema()
    // Project A: a full spread.
    seedIntent(A, 'todo', T)
    seedIntent(A, 'in_progress', T)
    seedIntent(A, 'done', T)
    seedIntent(A, 'cancelled', T) // not surfaced in the three buckets
    seedDiscussion(A, 'in_progress', T)
    seedDiscussion(A, 'completed', T)
    const sa = seedAutomation(A, 'active', T)
    seedAutomation(A, 'paused', T)
    seedExecLog(sa, 'running')
    seedSession(A, T)
    seedSession(A, T)
    // A live + an idle runtime in A.
    ensureRuntime('s-a', A, 'default', [])
    setStatus('s-a', 'running')
    ensureRuntime('s-a-idle', A, 'default', [])
    // Project B: empty.
    hoisted.workspaces = [
      { id: A, name: 'proj-a', lastAccessed: 2 },
      { id: B, name: 'proj-b', lastAccessed: 1 },
    ]

    const conn = fakeConn()
    getTimeRangeStatsHandler(fakeCtx(), conn, { type: 'get_timerange_stats' })
    const stats = sentStats(conn as never)

    expect(stats).toHaveLength(2)
    const a = stats.find((s) => s.workspaceId === A)!
    expect(a).toMatchObject({
      projectName: 'proj-a',
      workSessions: { total: 2, running: 1 },
      intents: { in_progress: 1, todo: 1, done: 1 },
      discussions: { in_progress: 1, completed: 1 },
      automations: { total: 2, active: 1, running: 1 },
    })
    const b = stats.find((s) => s.workspaceId === B)!
    expect(b).toMatchObject({
      projectName: 'proj-b',
      workSessions: { total: 0, running: 0 },
      intents: { in_progress: 0, todo: 0, done: 0 },
      discussions: { in_progress: 0, completed: 0 },
      automations: { total: 0, active: 0, running: 0 },
    })
  })

  it('passes the time range through to every surface', () => {
    warmSchema()
    seedIntent(A, 'todo', T - 10_000) // out of window
    seedIntent(A, 'todo', T) // in window
    seedDiscussion(A, 'completed', T)
    seedAutomation(A, 'active', T)
    seedSession(A, T)
    seedSession(A, T - 10_000) // out of window
    hoisted.workspaces = [{ id: A, name: 'proj-a', lastAccessed: 1 }]

    const conn = fakeConn()
    getTimeRangeStatsHandler(fakeCtx(), conn, {
      type: 'get_timerange_stats',
      startTime: T - 1,
      endTime: T + 1,
    })
    const a = sentStats(conn as never)[0]
    expect(a.intents.todo).toBe(1)
    expect(a.workSessions.total).toBe(1)
    expect(a.discussions.completed).toBe(1)
    expect(a.automations.total).toBe(1)
  })

  it('still returns one entry per workspace with zeroed counts when the db is unavailable', () => {
    resetDbForTests()
    resetAllStores()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    // A live runtime still counts even with no db.
    ensureRuntime('s-a', A, 'default', [])
    setStatus('s-a', 'running')
    hoisted.workspaces = [{ id: A, name: 'proj-a', lastAccessed: 1 }]

    const conn = fakeConn()
    getTimeRangeStatsHandler(fakeCtx(), conn, { type: 'get_timerange_stats' })
    const a = sentStats(conn as never)[0]
    expect(a).toMatchObject({
      workSessions: { total: 0, running: 1 },
      intents: { in_progress: 0, todo: 0, done: 0 },
      discussions: { in_progress: 0, completed: 0 },
      automations: { total: 0, active: 0, running: 0 },
    })
  })
})
