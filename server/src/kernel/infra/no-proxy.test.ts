/**
 * Unit coverage for the loopback proxy-bypass helper — the ONE computation every
 * vendor spawn site uses so a c3-served loopback endpoint is never routed through a
 * host proxy. Two properties matter: the loopback hosts are always present (or the
 * MCP routes silently lose all their tools), and a bypass list the user already set
 * is never narrowed.
 */
import { describe, expect, it } from 'vitest'
import { withLoopbackNoProxy } from './no-proxy.js'

describe('withLoopbackNoProxy', () => {
  it('adds all three loopback hosts when NO_PROXY is unset or empty', () => {
    expect(withLoopbackNoProxy()).toBe('127.0.0.1,localhost,::1')
    expect(withLoopbackNoProxy('')).toBe('127.0.0.1,localhost,::1')
    expect(withLoopbackNoProxy('  ,  ')).toBe('127.0.0.1,localhost,::1')
  })

  it('preserves host-configured entries and appends only what is missing', () => {
    expect(withLoopbackNoProxy('example.com,.internal')).toBe(
      'example.com,.internal,127.0.0.1,localhost,::1',
    )
    expect(withLoopbackNoProxy('localhost')).toBe('localhost,127.0.0.1,::1')
  })

  it('is idempotent — a value it already produced is unchanged', () => {
    const once = withLoopbackNoProxy('example.com')
    expect(withLoopbackNoProxy(once)).toBe(once)
  })

  it('trims surrounding whitespace on inherited entries', () => {
    expect(withLoopbackNoProxy(' example.com , 127.0.0.1 ')).toBe(
      'example.com,127.0.0.1,localhost,::1',
    )
  })
})
