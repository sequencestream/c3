import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startSchedulerWiring } from './scheduler-startup.js'
import { EventBus, type EventBusEvents } from '../kernel/events/event-bus.js'

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
import { dispatchEventTriggers } from '../features/triggers/index.js'

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

/**
 * The `discussion:lifecycle` bridge: the phase becomes the action of the
 * `<category>:<action>` type, `end` maps its terminal reason to `status`, and the
 * discussion identity + the caller's business metadata land in a flat
 * `event.metadata`. Driven through a REAL bus so the subscription itself is
 * covered, with `dispatchEventTriggers` mocked to capture the projected view.
 */
describe('startSchedulerWiring — discussion lifecycle bridge', () => {
  let eventBus: EventBus<EventBusEvents>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isStoreAvailable).mockReturnValue(true)
    vi.mocked(reconcileStuckRunningExecutions).mockReturnValue(0)
    eventBus = new EventBus<EventBusEvents>()
    startSchedulerWiring({ broadcasts: { broadcastAutomations: vi.fn() }, eventBus })
  })

  it('start → type=discussion:start, no status, identity + business metadata', () => {
    eventBus.publish('discussion:lifecycle', {
      workspacePath: '/proj',
      phase: 'start',
      discussionId: 'd1',
      title: 'Cache TTL',
      discussionType: 'design',
      metadata: { team: 'infra' },
    })
    expect(dispatchEventTriggers).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dispatchEventTriggers).mock.calls[0]![0]).toEqual({
      workspacePath: '/proj',
      event: {
        type: 'discussion:start',
        metadata: {
          team: 'infra',
          discussionId: 'd1',
          title: 'Cache TTL',
          discussionType: 'design',
        },
      },
    })
  })

  it('end → type=discussion:end with the terminal reason as status', () => {
    eventBus.publish('discussion:lifecycle', {
      workspacePath: '/proj',
      phase: 'end',
      discussionId: 'd1',
      title: 'Cache TTL',
      discussionType: 'design',
      metadata: {},
      reason: 'error',
    })
    expect(vi.mocked(dispatchEventTriggers).mock.calls[0]![0]).toEqual({
      workspacePath: '/proj',
      event: {
        type: 'discussion:end',
        status: 'error',
        metadata: { discussionId: 'd1', title: 'Cache TTL', discussionType: 'design' },
      },
    })
  })

  it('caller metadata can NOT forge the reserved identity keys', () => {
    eventBus.publish('discussion:lifecycle', {
      workspacePath: '/proj',
      phase: 'start',
      discussionId: 'real',
      title: 'Real title',
      discussionType: 'design',
      metadata: { discussionId: 'forged', title: 'Forged', discussionType: 'forged' },
    })
    const view = vi.mocked(dispatchEventTriggers).mock.calls[0]![0]
    expect(view.event.metadata).toEqual({
      discussionId: 'real',
      title: 'Real title',
      discussionType: 'design',
    })
  })

  it('carries no sessionKind — the sessionKind boundary is run-lifecycle only', () => {
    eventBus.publish('discussion:lifecycle', {
      workspacePath: '/proj',
      phase: 'start',
      discussionId: 'd1',
      title: 'T',
      discussionType: 'design',
      metadata: {},
    })
    expect(vi.mocked(dispatchEventTriggers).mock.calls[0]![0].sessionKind).toBeUndefined()
  })
})
