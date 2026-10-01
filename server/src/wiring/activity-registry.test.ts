import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type EventBusEvents } from '../kernel/events/event-bus.js'
import { activityRegistry, resetActivityRegistryForTests } from '../kernel/activity/index.js'
import { registerActivityRegistry } from './activity-registry.js'

let bus: EventBus<EventBusEvents>

beforeEach(() => {
  bus = new EventBus()
  resetActivityRegistryForTests()
  registerActivityRegistry(bus)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  resetActivityRegistryForTests()
  vi.restoreAllMocks()
})

describe('registerActivityRegistry', () => {
  it('starts, binds, and settles an ordinary session without duplicating', () => {
    bus.publish('run:started', {
      sessionId: 'pending:abc',
      workspacePath: '/w/proj',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(activityRegistry.snapshotRunning()).toHaveLength(1)
    bus.publish('run:started', {
      sessionId: 'pending:abc',
      workspacePath: '/w/proj',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(activityRegistry.snapshotRunning()).toHaveLength(1)

    bus.publish('run:bound', {
      prevId: 'pending:abc',
      realId: 'real-1',
      workspacePath: '/w/proj',
    })
    expect(activityRegistry.snapshotRunning()).toHaveLength(1)
    expect(activityRegistry.getBySessionId('real-1')?.sessionId).toBe('real-1')
    expect(activityRegistry.getBySessionId('pending:abc')?.sessionId).toBe('real-1')

    bus.publish('run:settled', {
      sessionId: 'real-1',
      workspacePath: '/w/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(activityRegistry.snapshot()).toHaveLength(0)
  })

  it('ignores a late bound after settle', () => {
    bus.publish('run:started', {
      sessionId: 'pending:late',
      workspacePath: '/w/proj',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    bus.publish('run:settled', {
      sessionId: 'pending:late',
      workspacePath: '/w/proj',
      reason: 'error',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    bus.publish('run:bound', {
      prevId: 'pending:late',
      realId: 'real-late',
      workspacePath: '/w/proj',
    })
    expect(activityRegistry.snapshot()).toHaveLength(0)
  })

  it('does not count automation execution-log ids as sessions', () => {
    bus.publish('run:started', {
      sessionId: 'log-id',
      workspacePath: '/w/proj',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    bus.publish('run:bound', {
      prevId: 'log-id',
      realId: 'log-id',
      workspacePath: '/w/proj',
    })
    bus.publish('run:settled', {
      sessionId: 'log-id',
      workspacePath: '/w/proj',
      reason: 'complete',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(activityRegistry.snapshot()).toHaveLength(0)
  })
})
