/**
 * Workspace automation gate (`WorkspaceSetting.automationEnabled`): the cron tick
 * loop and the event-trigger dispatcher must not auto-dispatch when the owning
 * workspace has the gate closed, while a second workspace with the gate open keeps
 * dispatching (isolation). Manual `triggerRunNow` ignores the gate entirely.
 *
 * The dispatcher is mocked so no real command/LLM runs; the gate value is driven
 * through a mocked `getAutomationEnabled`, keyed by workspace path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Identity workspace resolution: fixtures use the path itself as the id.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

// Drive the gate per-workspace; default open (true) mirrors normalize semantics.
const gate = vi.hoisted(() => ({ map: new Map<string, boolean>() }))
vi.mock('../../kernel/config/index.js', () => ({
  getTimezone: () => 'UTC',
  getAutomationEnabled: (ws: string) => gate.map.get(ws) ?? true,
}))

// Mock the dispatcher so dispatchAndTrack never spawns / queries an LLM.
vi.mock('./dispatcher.js', () => ({ execute: vi.fn(async () => {}) }))

import type { Automation } from '@ccc/shared/protocol'
import { eventTypeMatches } from '@ccc/shared/protocol'
import { execute } from './dispatcher.js'
import {
  cancelInFlight,
  hasInFlight,
  setExecutionStore,
  triggerRunNow,
  type ExecutionStore,
} from './engine.js'
import { startScheduler, stopScheduler } from '../schedules/index.js'
import { dispatchEventTriggers } from '../triggers/index.js'

const WS_CLOSED = '/abs/ws-closed'
const WS_OPEN = '/abs/ws-open'

function cronAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'cron-1',
    type: 'command',
    config: { command: 'echo hi', name: 'x' },
    maxWallClockMs: null,
    workspaceId: WS_CLOSED,
    triggerType: 'cron',
    cronExpression: '0 * * * *',
    nextRunAt: Date.now() - 60_000,
    eventFilters: null,
    status: 'active',
    mode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function eventAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'evt-1',
    type: 'command',
    config: { command: 'echo hi', name: 'x' },
    maxWallClockMs: null,
    workspaceId: WS_CLOSED,
    triggerType: 'event',
    cronExpression: '',
    nextRunAt: null,
    eventFilters: [{ type: 'run:settled' }],
    eventSessionKindFilter: ['work'],
    metadata: {},
    status: 'active',
    mode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// cron tick gate
// ---------------------------------------------------------------------------
describe('automation gate — cron tick', () => {
  let appendLog: ReturnType<typeof vi.fn>
  let updateNextRunAt: ReturnType<typeof vi.fn>
  let updateAutomation: ReturnType<typeof vi.fn>

  function install(automations: Automation[]): void {
    const store: ExecutionStore = {
      getDueAutomations: () => automations,
      getEventAutomations: () => [],
      getAutomation: (id) => automations.find((s) => s.id === id) ?? null,
      updateNextRunAt,
      updateAutomation,
      deleteAutomation: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
      broadcast: vi.fn(),
    }
    setExecutionStore(store)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:30:00.000Z'))
    gate.map.clear()
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'log1' }))
    updateNextRunAt = vi.fn()
    updateAutomation = vi.fn()
  })

  afterEach(async () => {
    await stopScheduler()
    cancelInFlight('cron-1')
    vi.useRealTimers()
  })

  it('closed workspace: a due cron does not dispatch, logs no missed window, re-arms nextRunAt to the future', async () => {
    gate.map.set(WS_CLOSED, false)
    // A stale nextRunAt (past the grace window) proves the gate short-circuits
    // BEFORE the missed-window path: no missed_trigger_window log is written.
    install([cronAutomation({ nextRunAt: Date.now() - 60 * 60 * 1000 })])

    startScheduler(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(execute).not.toHaveBeenCalled()
    expect(appendLog).not.toHaveBeenCalled()
    expect(updateAutomation).not.toHaveBeenCalled()
    expect(updateNextRunAt).toHaveBeenCalledWith('cron-1', expect.any(Number))
    expect(updateNextRunAt.mock.calls[0]![1]).toBeGreaterThan(Date.now())
  })

  it('open workspace: a due cron dispatches as normal', async () => {
    gate.map.set(WS_OPEN, true)
    install([
      cronAutomation({ id: 'cron-open', workspaceId: WS_OPEN, nextRunAt: Date.now() - 1000 }),
    ])

    startScheduler(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(appendLog).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    cancelInFlight('cron-open')
  })

  it('isolation: closing one workspace does not affect a due cron in another', async () => {
    gate.map.set(WS_CLOSED, false)
    gate.map.set(WS_OPEN, true)
    install([
      cronAutomation({ id: 'c-closed', workspaceId: WS_CLOSED, nextRunAt: Date.now() - 1000 }),
      cronAutomation({ id: 'c-open', workspaceId: WS_OPEN, nextRunAt: Date.now() - 1000 }),
    ])

    startScheduler(1)
    await vi.advanceTimersByTimeAsync(1)

    // Only the open workspace's automation dispatched (one running log).
    expect(appendLog).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-open' }),
      expect.anything(),
      expect.any(Function),
      undefined, // cron dispatch carries no trigger event
    )
    cancelInFlight('c-open')
  })
})

// ---------------------------------------------------------------------------
// event dispatch gate
// ---------------------------------------------------------------------------
describe('automation gate — event dispatch', () => {
  let appendLog: ReturnType<typeof vi.fn>

  function install(automations: Automation[]): void {
    const store: ExecutionStore = {
      getDueAutomations: () => [],
      getEventAutomations: (type) =>
        automations.filter(
          (s) =>
            s.status === 'active' &&
            s.triggerType === 'event' &&
            s.eventFilters?.some((f) => eventTypeMatches(f.type, type)),
        ),
      getAutomation: (id) => automations.find((s) => s.id === id) ?? null,
      updateNextRunAt: vi.fn(),
      updateAutomation: vi.fn(),
      deleteAutomation: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
      broadcast: vi.fn(),
    }
    setExecutionStore(store)
  }

  beforeEach(() => {
    gate.map.clear()
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'log1' }))
  })

  it('closed workspace: a matching event does not dispatch and writes no log', () => {
    gate.map.set(WS_CLOSED, false)
    install([eventAutomation({ id: 'e-closed', workspaceId: WS_CLOSED })])
    dispatchEventTriggers({
      workspacePath: WS_CLOSED,
      sessionKind: 'work',
      event: { type: 'run:settled', status: 'complete' },
    })
    expect(appendLog).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('open workspace: the same event dispatches (re-open restores handling of new events)', () => {
    gate.map.set(WS_OPEN, true)
    install([eventAutomation({ id: 'e-open', workspaceId: WS_OPEN })])
    dispatchEventTriggers({
      workspacePath: WS_OPEN,
      sessionKind: 'work',
      event: { type: 'run:settled', status: 'complete' },
    })
    expect(appendLog).toHaveBeenCalledTimes(1)
    cancelInFlight('e-open')
  })

  it('pr:<op> events are gated the same way', () => {
    gate.map.set(WS_CLOSED, false)
    install([
      eventAutomation({
        id: 'e-pr',
        workspaceId: WS_CLOSED,
        eventFilters: [{ type: 'pr:merge' }],
        eventSessionKindFilter: null,
      }),
    ])
    dispatchEventTriggers({
      workspacePath: WS_CLOSED,
      event: { type: 'pr:merge', status: 'success', metadata: { operation: 'merge' } },
    })
    expect(appendLog).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// manual run-now ignores the gate
// ---------------------------------------------------------------------------
describe('automation gate — triggerRunNow is unaffected', () => {
  let appendLog: ReturnType<typeof vi.fn>
  let updateNextRunAt: ReturnType<typeof vi.fn>

  function install(automations: Automation[]): void {
    setExecutionStore({
      getDueAutomations: () => [],
      getEventAutomations: () => [],
      getAutomation: (id) => automations.find((s) => s.id === id) ?? null,
      updateNextRunAt,
      updateAutomation: vi.fn(),
      deleteAutomation: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
    })
  }

  beforeEach(() => {
    gate.map.clear()
    gate.map.set(WS_CLOSED, false) // gate closed for the whole workspace
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'manual-log' }))
    updateNextRunAt = vi.fn()
  })

  afterEach(() => {
    cancelInFlight('run-active')
    cancelInFlight('run-paused')
  })

  it('runs an active automation once despite the closed gate, without changing its status', async () => {
    const active = cronAutomation({
      id: 'run-active',
      workspaceId: WS_CLOSED,
      status: 'active',
      nextRunAt: 1_800_000_000_000,
    })
    install([active])

    await triggerRunNow('run-active')

    expect(appendLog).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(active, 'manual-log', expect.any(Function), undefined)
    await vi.waitFor(() => expect(hasInFlight('run-active')).toBe(false))
    // The gate never mutates the automation's own status: an active one stays active.
    expect(active.status).toBe('active')
    // NOTE: after a run the engine re-arms an *active* cron's nextRunAt from now —
    // this is the manual-run engine's own post-run behavior, identical with or
    // without the gate, so it is not part of the gate contract (paused automations,
    // which have no such re-arm, prove the gate keeps nextRunAt untouched below).
  })

  it('runs a paused automation once despite the closed gate', async () => {
    const paused = cronAutomation({
      id: 'run-paused',
      workspaceId: WS_CLOSED,
      status: 'paused',
      nextRunAt: 1_800_000_000_000,
    })
    install([paused])

    await triggerRunNow('run-paused')

    expect(appendLog).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(hasInFlight('run-paused')).toBe(false))
    expect(paused.status).toBe('paused')
    expect(paused.nextRunAt).toBe(1_800_000_000_000)
    expect(updateNextRunAt).not.toHaveBeenCalled()
  })
})
