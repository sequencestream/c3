/**
 * `updateScheduleHandler` manual-title path: the update handler (unlike create)
 * accepts a client-supplied `config.name`. A non-empty title is stored sticky
 * (`nameSource='user'`); an empty title reverts to a freshly auto-derived name.
 * `generateScheduleName` is mocked so the "revert" path is deterministic and
 * never spawns an LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { createSchedule, getSchedule, resetStoreForTests } from './store.js'

vi.mock('./naming.js', async (orig) => {
  const actual = await orig<typeof import('./naming.js')>()
  return { ...actual, generateScheduleName: vi.fn(async () => 'Regenerated Auto') }
})

import { updateScheduleHandler } from './index.js'

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
      workspacePath: proj,
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
})
