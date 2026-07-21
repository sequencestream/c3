import { describe, it, expect } from 'vitest'
import { isJsonValue, validateGenericEvent } from './generic-event-validate.js'

describe('generic event contract — validateGenericEvent / isJsonValue', () => {
  it('accepts a flat metadata + multi-level JSON data core', () => {
    const res = validateGenericEvent({
      type: 'pr:operation',
      status: 'success',
      description: 'ok',
      metadata: { operation: 'create', actor: 'model' },
      data: { pr: { number: 7, nested: { deep: [1, 2, { k: 'v' }] } } },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.metadata).toEqual({ operation: 'create', actor: 'model' })
    expect(res.value.data).toEqual({ pr: { number: 7, nested: { deep: [1, 2, { k: 'v' }] } } })
  })

  it('rejects an empty / missing type', () => {
    expect(validateGenericEvent({ type: '' }).ok).toBe(false)
    expect(validateGenericEvent({ type: '   ' }).ok).toBe(false)
    expect(validateGenericEvent({}).ok).toBe(false)
    expect(validateGenericEvent(null).ok).toBe(false)
  })

  it('rejects nested (non-string) metadata values', () => {
    const res = validateGenericEvent({ type: 't', metadata: { nested: { a: 'b' } } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/metadata/)
  })

  it('rejects non-JSON data values (undefined, non-finite, function)', () => {
    expect(validateGenericEvent({ type: 't', data: { a: undefined } }).ok).toBe(false)
    expect(validateGenericEvent({ type: 't', data: { a: Number.POSITIVE_INFINITY } }).ok).toBe(
      false,
    )
    expect(validateGenericEvent({ type: 't', data: { a: () => 1 } }).ok).toBe(false)
  })

  it('rejects a data that is an array or primitive (must be an object)', () => {
    expect(validateGenericEvent({ type: 't', data: [1, 2] as unknown as object }).ok).toBe(false)
    expect(validateGenericEvent({ type: 't', data: 5 as unknown as object }).ok).toBe(false)
  })

  it('drops unknown top-level keys from the validated copy', () => {
    const res = validateGenericEvent({ type: 't', extra: 'x', workspacePath: 'evil' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).toEqual({ type: 't' })
  })

  it('isJsonValue detects cycles and class instances', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue({ a: 1, b: [true, null, 'x'] })).toBe(true)
  })
})
