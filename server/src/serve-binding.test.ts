import { describe, expect, it } from 'vitest'
import { LOOPBACK_HOST, normalizeHostOption, resolveServeBinding } from './serve-binding.js'

describe('normalizeHostOption', () => {
  it('keeps an explicit address', () => {
    expect(normalizeHostOption('127.0.0.1')).toBe('127.0.0.1')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHostOption('  ::1  ')).toBe('::1')
  })

  it('treats undefined / empty / blank as "not provided"', () => {
    expect(normalizeHostOption(undefined)).toBeUndefined()
    expect(normalizeHostOption('')).toBeUndefined()
    expect(normalizeHostOption('   ')).toBeUndefined()
  })
})

describe('resolveServeBinding', () => {
  it('omits hostname entirely when no host was given', () => {
    const b = resolveServeBinding({ port: 3000 })
    expect(b).toEqual({ port: 3000 })
    // The absence of the key is the contract: `serve()` must fall back to its own
    // default binding, not to a value c3 invented.
    expect('hostname' in b).toBe(false)
  })

  it('passes an explicit host through as serve()’s hostname', () => {
    expect(resolveServeBinding({ port: 4321, host: LOOPBACK_HOST })).toEqual({
      port: 4321,
      hostname: '127.0.0.1',
    })
  })

  it('does not turn a blank host into a bind address', () => {
    expect(resolveServeBinding({ port: 3000, host: '  ' })).toEqual({ port: 3000 })
  })
})
