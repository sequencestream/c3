/**
 * Unit tests for the framing-free `publish_event` core (AC1): the generic handler
 * validates + normalizes through the injected registry and publishes ONLY on
 * success. A legal event publishes exactly once (the normalized event); an unknown
 * type, an illegal flat metadata / non-JSON data core, a normalizer rejection, and
 * a normalizer that throws all return `isError` and publish NOTHING.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenericEvent } from '@ccc/shared'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { runPublishEvent } from './tool-defs.js'

/** A registry with a permissive `demo` normalizer + a `boom` normalizer that throws. */
function makeNormalize(): (core: GenericEvent) => ReturnType<EventNormalizerRegistry['normalize']> {
  const registry = new EventNormalizerRegistry()
  // Echoes the core back (dropping empty strings) — a minimal, valid normalizer.
  registry.register('demo', (core) => ({ type: core.type, status: core.status }))
  registry.register('boom', () => {
    throw new Error('normalizer exploded')
  })
  return (core) => registry.normalize(core)
}

describe('runPublishEvent — framing-free generic core', () => {
  const normalize = makeNormalize()

  it('publishes exactly once with the normalized event on a legal core', () => {
    const published: GenericEvent[] = []
    const r = runPublishEvent({ type: 'demo', status: 'ok' }, normalize, (e) => published.push(e))
    expect(r.isError).toBeUndefined()
    expect(published).toEqual([{ type: 'demo', status: 'ok' }])
  })

  it('rejects an unknown (unregistered) type and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishEvent({ type: 'never-registered' }, normalize, publish)
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects a nested (non-flat) metadata core and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishEvent(
      { type: 'demo', metadata: { nested: { x: '1' } } as unknown as Record<string, string> },
      normalize,
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON data core and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishEvent(
      { type: 'demo', data: { fn: () => 1 } as unknown as GenericEvent['data'] },
      normalize,
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects (publishes nothing) when the normalizer throws', () => {
    const publish = vi.fn()
    const r = runPublishEvent({ type: 'boom' }, normalize, publish)
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })
})
