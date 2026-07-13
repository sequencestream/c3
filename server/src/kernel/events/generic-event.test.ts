/**
 * Unit tests for the kernel `type → normalizer` registry (AC: unregistered type
 * rejected). Covers successful registration + dispatch, duplicate registration,
 * unknown type, and a normalizer that fails validation or throws. Every failure
 * must resolve to `{ ok: false }` WITHOUT surfacing raw sensitive values, and the
 * caller must never treat a failure as publishable.
 */
import { describe, expect, it } from 'vitest'
import type { GenericEvent } from '@ccc/shared/protocol'
import { EventNormalizerRegistry } from './generic-event.js'

describe('EventNormalizerRegistry — registration', () => {
  it('dispatches to the registered normalizer and returns the normalized event', () => {
    const registry = new EventNormalizerRegistry()
    registry.register('demo', (core) => ({
      type: core.type,
      status: 'ok',
      metadata: { seen: 'yes' },
    }))
    const res = registry.normalize({ type: 'demo', data: { a: 1 } })
    expect(res).toEqual({
      ok: true,
      event: { type: 'demo', status: 'ok', metadata: { seen: 'yes' } },
    })
  })

  it('throws on a duplicate type registration (startup config error)', () => {
    const registry = new EventNormalizerRegistry()
    registry.register('demo', (c) => c)
    expect(() => registry.register('demo', (c) => c)).toThrow(/duplicate/i)
  })

  it('throws on an empty type registration', () => {
    const registry = new EventNormalizerRegistry()
    expect(() => registry.register('   ', (c) => c)).toThrow()
  })

  it('reports registration via has()', () => {
    const registry = new EventNormalizerRegistry()
    expect(registry.has('demo')).toBe(false)
    registry.register('demo', (c) => c)
    expect(registry.has('demo')).toBe(true)
  })
})

describe('EventNormalizerRegistry.normalize — rejection (publishes nothing)', () => {
  it('rejects an unknown type', () => {
    const registry = new EventNormalizerRegistry()
    const res = registry.normalize({ type: 'never-registered' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/no normalizer/i)
  })

  it('rejects a structurally invalid core (empty type) before any lookup', () => {
    const registry = new EventNormalizerRegistry()
    const res = registry.normalize({ type: '' } as GenericEvent)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/invalid event/i)
  })

  it('rejects when the normalizer throws, without echoing the thrown message', () => {
    const registry = new EventNormalizerRegistry()
    registry.register('demo', () => {
      throw new Error('secret token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked')
    })
    const res = registry.normalize({ type: 'demo' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(res.reason).toMatch(/rejected the event/i)
  })

  it('rejects when the normalizer produces an invalid event', () => {
    const registry = new EventNormalizerRegistry()
    registry.register('demo', () => ({ type: '' }) as unknown as GenericEvent)
    const res = registry.normalize({ type: 'demo' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/invalid event/i)
  })

  it('rejects when the normalizer changes the event type', () => {
    const registry = new EventNormalizerRegistry()
    registry.register('demo', () => ({ type: 'other' }))
    const res = registry.normalize({ type: 'demo' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/must not change the event type/i)
  })
})
