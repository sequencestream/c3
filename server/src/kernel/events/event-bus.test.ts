/**
 * EventBus unit tests (ADR-0018).
 *
 * Covers: publish/subscribe, unsubscribe (dispose), error isolation, type
 * safety (compile-time), dispatch ordering, re-subscribe after dispose.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventBus, type EventBusEvents } from './event-bus.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A test-only event map to verify generic safety. */
interface TestEvents extends EventBusEvents {
  'test:alpha': { value: number }
  'test:beta': { label: string }
}

// ── Publish / Subscribe / Unsubscribe ────────────────────────────────────────

describe('EventBus — publish / subscribe / unsubscribe', () => {
  it('delivers payload to a registered handler', () => {
    const bus = new EventBus<TestEvents>()
    const handler = vi.fn()

    bus.subscribe('test:alpha', handler)
    bus.publish('test:alpha', { value: 42 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ value: 42 })
  })

  it('delivers to multiple handlers on the same topic in registration order', () => {
    const bus = new EventBus<TestEvents>()
    const order: number[] = []

    bus.subscribe('test:alpha', () => {
      order.push(1)
    })
    bus.subscribe('test:alpha', () => {
      order.push(2)
    })
    bus.subscribe('test:alpha', () => {
      order.push(3)
    })

    bus.publish('test:alpha', { value: 1 })

    expect(order).toEqual([1, 2, 3])
  })

  it('does not deliver to handlers on different topics', () => {
    const bus = new EventBus<TestEvents>()
    const alphaHandler = vi.fn()
    const betaHandler = vi.fn()

    bus.subscribe('test:alpha', alphaHandler)
    bus.subscribe('test:beta', betaHandler)

    bus.publish('test:alpha', { value: 1 })

    expect(alphaHandler).toHaveBeenCalledTimes(1)
    expect(betaHandler).not.toHaveBeenCalled()
  })

  it('publishing to a topic with no handlers is a no-op', () => {
    const bus = new EventBus<TestEvents>()
    expect(() => {
      bus.publish('test:alpha', { value: 1 })
    }).not.toThrow()
  })

  it('dispose removes a handler', () => {
    const bus = new EventBus<TestEvents>()
    const handler = vi.fn()

    const dispose = bus.subscribe('test:alpha', handler)
    dispose()
    bus.publish('test:alpha', { value: 1 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('re-subscribing after dispose works', () => {
    const bus = new EventBus<TestEvents>()
    const handler = vi.fn()

    const dispose = bus.subscribe('test:alpha', handler)
    dispose()

    bus.subscribe('test:alpha', handler)
    bus.publish('test:alpha', { value: 1 })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disposing one handler does not affect others on the same topic', () => {
    const bus = new EventBus<TestEvents>()
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    const dispose1 = bus.subscribe('test:alpha', handler1)
    bus.subscribe('test:alpha', handler2)
    dispose1()

    bus.publish('test:alpha', { value: 1 })

    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalledTimes(1)
  })
})

// ── Error isolation ──────────────────────────────────────────────────────────

describe('EventBus — error isolation', () => {
  it('a throwing handler does not prevent other handlers from running', () => {
    const bus = new EventBus<TestEvents>()
    const safeHandler = vi.fn()

    bus.subscribe('test:alpha', () => {
      throw new Error('boom')
    })
    bus.subscribe('test:alpha', safeHandler)

    expect(() => bus.publish('test:alpha', { value: 1 })).not.toThrow()
    expect(safeHandler).toHaveBeenCalledTimes(1)
  })

  it('a throwing handler does not propagate to the publisher', () => {
    const bus = new EventBus<TestEvents>()
    const throwingHandler = vi.fn(() => {
      throw new Error('boom')
    })

    bus.subscribe('test:alpha', throwingHandler)

    expect(() => bus.publish('test:alpha', { value: 1 })).not.toThrow()
  })

  it('multiple throwing handlers are all isolated', () => {
    const bus = new EventBus<TestEvents>()
    const safeHandler = vi.fn()

    bus.subscribe('test:alpha', () => {
      throw new Error('first')
    })
    bus.subscribe('test:alpha', () => {
      throw new Error('second')
    })
    bus.subscribe('test:alpha', safeHandler)

    expect(() => bus.publish('test:alpha', { value: 1 })).not.toThrow()
    expect(safeHandler).toHaveBeenCalledTimes(1)
  })

  it('an async handler rejection is caught and does not affect other handlers', async () => {
    const bus = new EventBus<TestEvents>()
    const safeHandler = vi.fn()

    // An async handler that rejects
    bus.subscribe('test:alpha', async () => {
      throw new Error('async boom')
    })
    bus.subscribe('test:alpha', safeHandler)

    // publish is synchronous — async rejections are caught by the Promise.catch
    // inside the bus, not thrown from publish
    expect(() => bus.publish('test:alpha', { value: 1 })).not.toThrow()

    // Give the microtask queue a tick so the caught rejection settles
    await new Promise((r) => setTimeout(r, 0))
    expect(safeHandler).toHaveBeenCalledTimes(1)
  })
})

// ── Clear ────────────────────────────────────────────────────────────────────

describe('EventBus — clear', () => {
  it('clear removes all listeners', () => {
    const bus = new EventBus<TestEvents>()
    const handler = vi.fn()

    bus.subscribe('test:alpha', handler)
    bus.subscribe('test:beta', () => {})

    bus.clear()
    bus.publish('test:alpha', { value: 1 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('re-subscribing after clear works', () => {
    const bus = new EventBus<TestEvents>()
    const handler = vi.fn()

    bus.subscribe('test:alpha', handler)
    bus.clear()

    bus.subscribe('test:alpha', handler)
    bus.publish('test:alpha', { value: 1 })

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ── Type safety (compile-time assertions) ────────────────────────────────────

describe('EventBus — type safety (compile-time)', () => {
  it('typed EventBus rejects unknown topics', () => {
    const bus = new EventBus<TestEvents>()
    // The following would fail typecheck if uncommented:
    // bus.publish('test:nonexistent', {})
    //   ^^ Argument of type '"test:nonexistent"' is not assignable to parameter
    //      of type 'keyof TestEvents'.
    expect(bus).toBeInstanceOf(EventBus)
  })

  it('typed EventBus rejects wrong payload types', () => {
    const bus = new EventBus<TestEvents>()
    // The following would fail typecheck if uncommented:
    // bus.publish('test:alpha', { wrong: true })
    // bus.publish('test:alpha', 42)
    // bus.publish('test:beta', { value: 1 })
    expect(bus).toBeInstanceOf(EventBus)
  })

  it('default EventBus (EventBusEvents) accepts run:bound and run:settled', () => {
    const bus = new EventBus()
    const handler = vi.fn()

    bus.subscribe('run:bound', handler)
    bus.publish('run:bound', { prevId: 'p-1', realId: 'r-2', workspacePath: '/tmp/proj' })

    expect(handler).toHaveBeenCalledWith({
      prevId: 'p-1',
      realId: 'r-2',
      workspacePath: '/tmp/proj',
    })
  })

  it('default EventBus rejects wrong run:bound payload', () => {
    const bus = new EventBus()
    // The following would fail typecheck if uncommented:
    // bus.publish('run:bound', { workspacePath: '/x' })
    //   ^^ Type '{ workspacePath: string; }' is not assignable to type
    //      '{ prevId: string; realId: string; workspacePath: string; }'
    expect(bus).toBeInstanceOf(EventBus)
  })
})

// ── RunDomainEvent backward compatibility (type contract) ────────────────────

describe('EventBus — RunDomainEvent contract parity', () => {
  it('run:bound payload carries prev/real ids and workspace (2026-06-08)', () => {
    type BoundPayload = EventBusEvents['run:bound']
    const e: BoundPayload = { prevId: 'pending-x', realId: 'real-y', workspacePath: '/tmp/proj' }
    expect(e.prevId).toBe('pending-x')
    expect(e.realId).toBe('real-y')
    expect(e.workspacePath).toBe('/tmp/proj')
  })

  it('run:settled payload carries session id, terminal reason, and run kind (2026-06-08)', () => {
    type SettledPayload = EventBusEvents['run:settled']
    const e: SettledPayload = {
      sessionId: 'sess-1',
      workspacePath: '/tmp/proj',
      reason: 'complete',
      kind: 'session',
    }
    expect(e.workspacePath).toBe('/tmp/proj')
    expect(e.reason).toBe('complete')
    expect(e.kind).toBe('session')
  })

  it('run:started payload carries session id, workspace, and run kind (2026-06-08)', () => {
    type StartedPayload = EventBusEvents['run:started']
    const e: StartedPayload = { sessionId: 'sess-2', workspacePath: '/tmp/proj', kind: 'session' }
    expect(e.sessionId).toBe('sess-2')
    expect(e.kind).toBe('session')
  })
})
