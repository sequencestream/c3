/**
 * `updateScheduleHandler` manual-title path: the update handler (unlike create)
 * accepts a client-supplied `config.name`. A non-empty title is stored sticky
 * (`nameSource='user'`); an empty title reverts to a freshly auto-derived name.
 * `generateScheduleName` is mocked so the "revert" path is deterministic and
 * never spawns an LLM.
 */
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
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  appendExecutionLog,
  createSchedule,
  getSchedule,
  listExecutionLogs,
  resetStoreForTests,
} from './store.js'

vi.mock('./naming.js', async (orig) => {
  const actual = await orig<typeof import('./naming.js')>()
  return { ...actual, generateScheduleName: vi.fn(async () => 'Regenerated Auto') }
})

// Stub the scheduler so the delete handler's in-flight cancellation is observable
// without standing up the real tick loop / event-bus wiring.
vi.mock('./scheduler.js', () => ({
  triggerRunNow: vi.fn(),
  cancelInFlight: vi.fn(),
}))

import { deleteScheduleHandler, updateScheduleHandler } from './index.js'
import { cancelInFlight } from './scheduler.js'

const proj = '/abs/ws-handler'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-handler-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

// Minimal ctx/conn doubles — the handler only touches broadcastSchedules / send.
function fakeCtx() {
  return { broadcastSchedules: vi.fn() } as never
}
function fakeConn() {
  return { send: vi.fn() } as never
}

function makeSchedule() {
  return createSchedule(
    {
      type: 'command',
      config: { command: 'echo hi' },
      workspaceId: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    },
    'Auto Name',
  )
}

function updateMsg(scheduleId: string, name: string) {
  return {
    type: 'update_schedule',
    scheduleId,
    input: { config: { command: 'echo hi', name } },
  } as never
}

describe('updateScheduleHandler — manual title', () => {
  it('persists a non-empty (trimmed) config.name as a sticky user name', async () => {
    const sch = makeSchedule()
    const ctx = fakeCtx()
    await updateScheduleHandler(ctx, fakeConn(), updateMsg(sch.id, '  My Title  '))

    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
    expect(
      (ctx as unknown as { broadcastSchedules: ReturnType<typeof vi.fn> }).broadcastSchedules,
    ).toHaveBeenCalled()
  })

  it('reverts to an auto-derived name when config.name is cleared', async () => {
    const sch = makeSchedule()
    // First set a manual title…
    await updateScheduleHandler(fakeCtx(), fakeConn(), updateMsg(sch.id, 'Manual'))
    // …then clear it — the handler re-derives via generateScheduleName (mocked).
    await updateScheduleHandler(fakeCtx(), fakeConn(), updateMsg(sch.id, ''))

    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('Regenerated Auto')
    expect(cfg.nameSource).toBeUndefined()
  })

  it('rejects an out-of-range maxWallClockMs without changing the schedule', async () => {
    const sch = makeSchedule()
    const conn = fakeConn()
    await updateScheduleHandler(fakeCtx(), conn, {
      type: 'update_schedule',
      scheduleId: sch.id,
      input: { maxWallClockMs: 999 },
    } as never)

    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'schedule.invalidMaxWallClockMs' },
    })
    expect(getSchedule(sch.id)!.maxWallClockMs).toBeNull()
  })
})

function deleteMsg(scheduleId: string) {
  return { type: 'delete_schedule', scheduleId } as never
}

describe('deleteScheduleHandler', () => {
  beforeEach(() => {
    vi.mocked(cancelInFlight).mockClear()
  })

  it('hard-deletes the schedule, cascades its logs, cancels in-flight, broadcasts', () => {
    const sch = makeSchedule()
    appendExecutionLog({
      scheduleId: sch.id,
      startedAt: 1_000,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
    })
    expect(listExecutionLogs(sch.id)).toHaveLength(1)

    const ctx = fakeCtx()
    deleteScheduleHandler(ctx, fakeConn(), deleteMsg(sch.id))

    // Running execution is stopped before the row vanishes (SCH-R7 / SCH-R14).
    expect(cancelInFlight).toHaveBeenCalledWith(sch.id)
    // Schedule + its execution history are gone (hard delete, cascade).
    expect(getSchedule(sch.id)).toBeNull()
    expect(listExecutionLogs(sch.id)).toEqual([])
    // List refresh broadcast fires.
    expect(
      (ctx as unknown as { broadcastSchedules: ReturnType<typeof vi.fn> }).broadcastSchedules,
    ).toHaveBeenCalled()
  })

  it('replies schedule.notFound for an unknown id — no cancel, no broadcast', () => {
    const ctx = fakeCtx()
    const conn = fakeConn()
    deleteScheduleHandler(ctx, conn, deleteMsg('nope'))

    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'schedule.notFound' },
    })
    expect(cancelInFlight).not.toHaveBeenCalled()
    expect(
      (ctx as unknown as { broadcastSchedules: ReturnType<typeof vi.fn> }).broadcastSchedules,
    ).not.toHaveBeenCalled()
  })
})
