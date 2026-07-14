/**
 * Trigger-context plumbing: the event-dispatch path hands the matched normalized
 * event to the execution engine as an immutable, single-execution input, while
 * the cron tick and manual run-now pass none. The dispatcher is mocked so no
 * real agent runs — we assert only WHICH event reaches `execute`, that two
 * consecutive events each carry their own event, and that the saved config is
 * never mutated with event data.
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
  resetStoreForTests,
} from './store.js'
import {
  cancelInFlight,
  hasInFlight,
  setExecutionStore,
  triggerRunNow,
  type ExecutionStore,
} from './engine.js'
import { dispatchEventTriggers } from '../triggers/index.js'

const proj = '/abs/ws-event-ctx'
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
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-evtctx-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  vi.mocked(execute).mockReset()
  vi.mocked(execute).mockResolvedValue(undefined)
  setExecutionStore(store)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function makeEventLlm() {
  return createAutomation({
    type: 'llm',
    config: { prompt: 'Investigate.', embedEventContext: true },
    workspaceId: proj,
    triggerType: 'event',
    cronExpression: '',
    eventFilters: [{ type: 'run:settled' }],
    eventSessionKindFilter: ['automation'],
    mode: 'read-only',
    vendor: 'claude',
    agentId: 'agent-x',
  })
}

describe('trigger context plumbing', () => {
  it('passes the matched event to execute as the 4th argument', async () => {
    const a = makeEventLlm()
    dispatchEventTriggers({
      workspacePath: proj,
      sessionKind: 'automation',
      event: { type: 'run:settled', status: 'error', metadata: { pipeline: 'deploy' } },
    })
    await vi.waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      expect.objectContaining({ id: a.id }),
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ type: 'run:settled', status: 'error' }),
    )
    cancelInFlight(a.id)
  })

  it('two consecutive events each carry their own event, saved config untouched', async () => {
    const a = makeEventLlm()

    dispatchEventTriggers({
      workspacePath: proj,
      sessionKind: 'automation',
      event: { type: 'run:settled', status: 'error', metadata: { run: '1' } },
    })
    await vi.waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalledTimes(1))
    // Let the in-flight guard clear before the second event (serial per automation).
    await vi.waitFor(() => expect(hasInFlight(a.id)).toBe(false))

    dispatchEventTriggers({
      workspacePath: proj,
      sessionKind: 'automation',
      event: { type: 'run:settled', status: 'complete', metadata: { run: '2' } },
    })
    await vi.waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalledTimes(2))

    const first = vi.mocked(execute).mock.calls[0][3]
    const second = vi.mocked(execute).mock.calls[1][3]
    expect(first).toMatchObject({ status: 'error', metadata: { run: '1' } })
    expect(second).toMatchObject({ status: 'complete', metadata: { run: '2' } })

    // The stored config keeps only the flag + prompt — no event data leaked in.
    const saved = getAutomation(a.id)!.config as Record<string, unknown>
    expect(saved.embedEventContext).toBe(true)
    expect(saved.prompt).toBe('Investigate.')
    expect('metadata' in saved).toBe(false)
    expect('status' in saved).toBe(false)
    cancelInFlight(a.id)
  })

  it('manual run-now passes no event (cron / immediate never embed history)', async () => {
    const a = createAutomation({
      type: 'llm',
      config: { prompt: 'Nightly.' },
      workspaceId: proj,
      cronExpression: '0 8 * * *',
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'agent-x',
    })
    await triggerRunNow(a.id)
    await vi.waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(execute).mock.calls[0][3]).toBeUndefined()
    cancelInFlight(a.id)
  })
})
