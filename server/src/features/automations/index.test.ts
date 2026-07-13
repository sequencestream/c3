/**
 * `updateAutomationHandler` manual-title path: the update handler (unlike create)
 * accepts a client-supplied `config.name`. A non-empty title is stored sticky
 * (`nameSource='user'`); an empty title reverts to a freshly auto-derived name.
 * `generateAutomationName` is mocked so the "revert" path is deterministic and
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
  createAutomation,
  getAutomation,
  listExecutionLogs,
  resetStoreForTests,
} from './store.js'

vi.mock('./naming.js', async (orig) => {
  const actual = await orig<typeof import('./naming.js')>()
  return { ...actual, generateAutomationName: vi.fn(async () => 'Regenerated Auto') }
})

// Stub the scheduler so the delete handler's in-flight cancellation is observable
// without standing up the real tick loop / event-bus wiring.
vi.mock('./engine.js', () => ({
  triggerRunNow: vi.fn(),
  cancelInFlight: vi.fn(),
}))

import {
  createAutomationHandler,
  deleteAutomationHandler,
  updateAutomationHandler,
} from './index.js'
import { cancelInFlight } from './engine.js'

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

// Minimal ctx/conn doubles — the handler only touches broadcastAutomations / send.
function fakeCtx() {
  return { broadcastAutomations: vi.fn() } as never
}
function fakeConn() {
  return { send: vi.fn() } as never
}

function makeAutomation() {
  return createAutomation(
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

function updateMsg(automationId: string, name: string) {
  return {
    type: 'update_automation',
    automationId,
    input: { config: { command: 'echo hi', name } },
  } as never
}

describe('updateAutomationHandler — manual title', () => {
  it('persists a non-empty (trimmed) config.name as a sticky user name', async () => {
    const sch = makeAutomation()
    const ctx = fakeCtx()
    await updateAutomationHandler(ctx, fakeConn(), updateMsg(sch.id, '  My Title  '))

    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
    expect(
      (ctx as unknown as { broadcastAutomations: ReturnType<typeof vi.fn> }).broadcastAutomations,
    ).toHaveBeenCalled()
  })

  it('reverts to an auto-derived name when config.name is cleared', async () => {
    const sch = makeAutomation()
    // First set a manual title…
    await updateAutomationHandler(fakeCtx(), fakeConn(), updateMsg(sch.id, 'Manual'))
    // …then clear it — the handler re-derives via generateAutomationName (mocked).
    await updateAutomationHandler(fakeCtx(), fakeConn(), updateMsg(sch.id, ''))

    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('Regenerated Auto')
    expect(cfg.nameSource).toBeUndefined()
  })

  it('rejects an out-of-range maxWallClockMs without changing the automation', async () => {
    const sch = makeAutomation()
    const conn = fakeConn()
    await updateAutomationHandler(fakeCtx(), conn, {
      type: 'update_automation',
      automationId: sch.id,
      input: { maxWallClockMs: 999 },
    } as never)

    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'automation.invalidMaxWallClockMs' },
    })
    expect(getAutomation(sch.id)!.maxWallClockMs).toBeNull()
  })
})

describe('run-lifecycle event trigger — sessionKind filter is mandatory', () => {
  it('rejects a create with a run-lifecycle topic and no sessionKind filter', async () => {
    const conn = fakeConn()
    await createAutomationHandler(fakeCtx(), conn, {
      type: 'create_automation',
      workspaceId: proj,
      input: {
        type: 'command',
        config: { command: 'echo hi' },
        workspaceId: proj,
        vendor: 'claude',
        triggerType: 'event',
        cronExpression: '',
        eventFilter: { type: 'run:settled' },
        mode: 'sandboxed',
      },
    } as never)
    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'automation.missingSessionKindFilter' },
    })
  })

  it('rejects an update that clears the sessionKind filter on a run-lifecycle automation', async () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilter: { type: 'run:settled' },
      eventSessionKindFilter: ['work'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    const conn = fakeConn()
    await updateAutomationHandler(fakeCtx(), conn, {
      type: 'update_automation',
      automationId: sch.id,
      input: { eventSessionKindFilter: [] },
    } as never)
    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'automation.missingSessionKindFilter' },
    })
    // Unchanged: the filter is still ['work'].
    expect(getAutomation(sch.id)!.eventSessionKindFilter).toEqual(['work'])
  })
})

function deleteMsg(automationId: string) {
  return { type: 'delete_automation', automationId } as never
}

describe('deleteAutomationHandler', () => {
  beforeEach(() => {
    vi.mocked(cancelInFlight).mockClear()
  })

  it('hard-deletes the automation, cascades its logs, cancels in-flight, broadcasts', () => {
    const sch = makeAutomation()
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 1_000,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
    })
    expect(listExecutionLogs(sch.id)).toHaveLength(1)

    const ctx = fakeCtx()
    deleteAutomationHandler(ctx, fakeConn(), deleteMsg(sch.id))

    // Running execution is stopped before the row vanishes (SCH-R7 / SCH-R14).
    expect(cancelInFlight).toHaveBeenCalledWith(sch.id)
    // Automation + its execution history are gone (hard delete, cascade).
    expect(getAutomation(sch.id)).toBeNull()
    expect(listExecutionLogs(sch.id)).toEqual([])
    // List refresh broadcast fires.
    expect(
      (ctx as unknown as { broadcastAutomations: ReturnType<typeof vi.fn> }).broadcastAutomations,
    ).toHaveBeenCalled()
  })

  it('replies automation.notFound for an unknown id — no cancel, no broadcast', () => {
    const ctx = fakeCtx()
    const conn = fakeConn()
    deleteAutomationHandler(ctx, conn, deleteMsg('nope'))

    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'automation.notFound' },
    })
    expect(cancelInFlight).not.toHaveBeenCalled()
    expect(
      (ctx as unknown as { broadcastAutomations: ReturnType<typeof vi.fn> }).broadcastAutomations,
    ).not.toHaveBeenCalled()
  })
})

describe('createAutomationHandler — import path (initialStatus / initialName)', () => {
  function createMsg(input: Record<string, unknown>) {
    return { type: 'create_automation', workspaceId: proj, input } as never
  }
  // The naming mock is module-scoped and accumulates across the file, so assert on
  // call-count deltas rather than absolute called/not-called.
  const namingCalls = async () =>
    vi.mocked((await import('./naming.js')).generateAutomationName).mock.calls.length

  it('skips auto-naming when an initialName is supplied', async () => {
    const before = await namingCalls()
    const ctx = fakeCtx()
    await createAutomationHandler(
      ctx,
      fakeConn(),
      createMsg({
        type: 'command',
        config: { command: 'echo hi' },
        workspaceId: proj,
        vendor: 'claude',
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        initialStatus: 'paused',
        initialName: 'Imported Task',
      }),
    )
    expect(
      (ctx as unknown as { broadcastAutomations: ReturnType<typeof vi.fn> }).broadcastAutomations,
    ).toHaveBeenCalled()
    // The imported name wins — auto-naming is skipped entirely.
    expect(await namingCalls()).toBe(before)
  })

  it('persists the imported automation paused with the exported sticky name', async () => {
    const ctx = fakeCtx()
    await createAutomationHandler(
      ctx,
      fakeConn(),
      createMsg({
        type: 'command',
        config: { command: 'echo hi', name: 'ignored-config-name' },
        workspaceId: proj,
        vendor: 'claude',
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        initialStatus: 'paused',
        initialName: 'Imported Task',
      }),
    )
    // Find the paused import by scanning the workspace's automations.
    const { listAutomations } = await import('./store.js')
    const imported = listAutomations(proj).find(
      (a) => (a.config as Record<string, unknown>).name === 'Imported Task',
    )
    expect(imported).toBeDefined()
    expect(imported!.status).toBe('paused')
    expect((imported!.config as Record<string, unknown>).nameSource).toBe('user')
  })

  it('rejects a non-paused explicit initial status and writes nothing', async () => {
    const conn = fakeConn()
    const ctx = fakeCtx()
    await createAutomationHandler(
      ctx,
      conn,
      createMsg({
        type: 'command',
        config: { command: 'echo hi' },
        workspaceId: proj,
        vendor: 'claude',
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        initialStatus: 'active',
      }),
    )
    expect((conn as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'automation.invalidInitialStatus' },
    })
    expect(
      (ctx as unknown as { broadcastAutomations: ReturnType<typeof vi.fn> }).broadcastAutomations,
    ).not.toHaveBeenCalled()
  })

  it('creates a normal automation active and auto-named when no import fields are present', async () => {
    const before = await namingCalls()
    const ctx = fakeCtx()
    await createAutomationHandler(
      ctx,
      fakeConn(),
      createMsg({
        type: 'command',
        config: { command: 'echo hi' },
        workspaceId: proj,
        vendor: 'claude',
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
      }),
    )
    expect(await namingCalls()).toBe(before + 1)
  })
})
