/**
 * End-to-end automation chaining (2026-07-04): automation A finishes and its own
 * run:settled carries A's metadata; automation B — subscribed to run:settled,
 * scoped to `sessionKind='automation'`, and filtering on that metadata — is
 * triggered through the real engine → event bus → trigger dispatch path (no
 * mocked matcher). This is the geiger for "one automation triggers another".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('./dispatcher.js', () => ({ execute: vi.fn(async () => {}) }))
import { execute } from './dispatcher.js'
import { EventBus, type EventBusEvents } from '../../kernel/events/event-bus.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  createAutomation,
  getAutomation,
  getDueAutomations,
  getEventAutomations,
  updateNextRunAt,
  deleteAutomation,
  appendExecutionLog,
  updateExecutionLog,
  listExecutionLogs,
  resetStoreForTests,
} from './store.js'
import {
  dispatchAndTrack,
  setEventBus,
  setExecutionStore,
  cancelInFlight,
  type ExecutionStore,
} from './engine.js'
import { dispatchEventTriggers } from '../triggers/index.js'

const proj = '/abs/ws-chain'
let dir: string

const store: ExecutionStore = {
  getDueAutomations,
  getEventAutomations,
  getAutomation,
  updateNextRunAt,
  updateAutomation: vi.fn(),
  deleteAutomation,
  appendExecutionLog: (input) => appendExecutionLog(input),
  updateExecutionLog: (id, patch) => updateExecutionLog(id, patch),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-chain-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  vi.mocked(execute).mockReset()
  vi.mocked(execute).mockResolvedValue(undefined)
  setExecutionStore(store)
  // Wire the kernel bus exactly as scheduler-startup does for run-lifecycle.
  const bus = new EventBus<EventBusEvents>()
  bus.subscribe('run:settled', (e) =>
    dispatchEventTriggers({
      workspacePath: e.workspacePath,
      sessionKind: e.sessionKind,
      event: { type: 'run:settled', status: e.reason, metadata: e.metadata ?? undefined },
    }),
  )
  setEventBus(bus)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('automation chain: A (metadata) → B (sessionKind=automation + metadata)', () => {
  it('B fires when A finishes and A metadata satisfies B filter', async () => {
    const a = createAutomation({
      type: 'command',
      config: { command: 'echo a' },
      workspaceId: proj,
      cronExpression: '0 8 * * *',
      metadata: { pipeline: 'deploy', stage: '1' },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    const b = createAutomation({
      type: 'command',
      config: { command: 'echo b' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilter: {
        type: 'run:settled',
        metadata: {
          conditions: [{ key: 'pipeline', value: 'deploy' }],
          combinator: 'AND',
        },
      },
      eventSessionKindFilter: ['automation'],
      mode: 'sandboxed',
      vendor: 'claude',
    })

    // Run A through the real engine: its run:settled publishes A's metadata, which
    // the wired subscription routes to dispatchEventTriggers → B.
    dispatchAndTrack(a)
    await vi.waitFor(() => expect(listExecutionLogs(b.id).length).toBe(1))

    // B actually executed (real dispatch path, same matcher as production).
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      expect.objectContaining({ id: b.id }),
      expect.any(String),
      expect.any(Function),
    )
    cancelInFlight(a.id)
    cancelInFlight(b.id)
  })

  it('B does NOT fire when A metadata misses B filter', async () => {
    const a = createAutomation({
      type: 'command',
      config: { command: 'echo a' },
      workspaceId: proj,
      cronExpression: '0 8 * * *',
      metadata: { pipeline: 'other' },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    const b = createAutomation({
      type: 'command',
      config: { command: 'echo b' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilter: {
        type: 'run:settled',
        metadata: {
          conditions: [{ key: 'pipeline', value: 'deploy' }],
          combinator: 'AND',
        },
      },
      eventSessionKindFilter: ['automation'],
      mode: 'sandboxed',
      vendor: 'claude',
    })

    dispatchAndTrack(a)
    // Let A's settle propagate synchronously through the bus.
    await vi.waitFor(() => expect(getAutomation(a.id)).not.toBeNull())
    expect(listExecutionLogs(b.id)).toEqual([])
    cancelInFlight(a.id)
  })
})
