import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startSchedulerWiring } from './scheduler-startup.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'

// Records the relative order of the two lifecycle-critical calls so the tests can
// assert startup reconciliation always precedes scheduler start.
const order: string[] = []

vi.mock('../features/automations/store.js', () => ({
  appendExecutionLog: vi.fn(),
  deleteAutomation: vi.fn(),
  getDueAutomations: vi.fn(),
  getEventAutomations: vi.fn(),
  getAutomation: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
  reconcileStuckRunningExecutions: vi.fn(() => {
    order.push('reconcile')
    return 0
  }),
  updateNextRunAt: vi.fn(),
  updateAutomation: vi.fn(),
  updateExecutionLog: vi.fn(),
}))

vi.mock('../features/automations/engine.js', () => ({
  setExecutionStore: vi.fn(),
  setEventBus: vi.fn(),
}))

vi.mock('../features/schedules/index.js', () => ({
  startScheduler: vi.fn(() => {
    order.push('startScheduler')
  }),
  stopScheduler: vi.fn(),
}))

vi.mock('../features/triggers/index.js', () => ({
  dispatchEventTriggers: vi.fn(),
}))

vi.mock('../features/agent-quota-recovery.js', () => ({
  registerAgentQuotaRecovery: vi.fn(),
}))

import { isStoreAvailable, reconcileStuckRunningExecutions } from '../features/automations/store.js'
import { startScheduler } from '../features/schedules/index.js'

function makeDeps() {
  const eventBus = { subscribe: vi.fn() } as unknown as EventBus<EventBusEvents>
  const broadcasts = { broadcastAutomations: vi.fn() }
  return { broadcasts, eventBus }
}

describe('startSchedulerWiring startup order', () => {
  beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    vi.mocked(isStoreAvailable).mockReturnValue(true)
    vi.mocked(reconcileStuckRunningExecutions).mockImplementation(() => {
      order.push('reconcile')
      return 0
    })
    vi.mocked(startScheduler).mockImplementation(() => {
      order.push('startScheduler')
    })
  })

  it('reconciles stuck running executions before starting the scheduler', () => {
    startSchedulerWiring(makeDeps())
    expect(reconcileStuckRunningExecutions).toHaveBeenCalledTimes(1)
    expect(startScheduler).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['reconcile', 'startScheduler'])
  })

  it('does NOT start the scheduler when startup reconciliation fails', () => {
    vi.mocked(reconcileStuckRunningExecutions).mockImplementation(() => {
      throw new Error('db write failed')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    startSchedulerWiring(makeDeps())
    expect(reconcileStuckRunningExecutions).toHaveBeenCalledTimes(1)
    expect(startScheduler).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('skips reconciliation entirely when the automation store is unavailable', () => {
    vi.mocked(isStoreAvailable).mockReturnValue(false)
    startSchedulerWiring(makeDeps())
    expect(reconcileStuckRunningExecutions).not.toHaveBeenCalled()
    expect(startScheduler).not.toHaveBeenCalled()
  })
})
