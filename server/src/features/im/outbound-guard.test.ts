/**
 * The last check before an answer leaves the machine. Two things matter: a
 * credential shape is never delivered and the refusal never quotes it, and an
 * ordinary technical answer — code fences included — still goes out.
 */
import { describe, expect, it } from 'vitest'
import { screenOutbound } from './outbound-guard.js'

const MAX = 4000

describe('screenOutbound — refuses credential shapes', () => {
  it('refuses well-known token formats', () => {
    for (const text of [
      'the key is ghp_abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'use sk-ant-abcdefghijklmnopqrstuvwx',
      'AKIAIOSFODNN7EXAMPLE is the id',
      '-----BEGIN RSA PRIVATE KEY-----',
      'api_key = 9f8e7d6c5b4a3f2e1d0c',
    ]) {
      expect(screenOutbound(text, MAX)).toEqual({ ok: false, reason: 'credential' })
    }
  })

  it('never echoes what it matched', () => {
    const verdict = screenOutbound('token: 9f8e7d6c5b4a3f2e1d0c', MAX)
    expect(JSON.stringify(verdict)).not.toContain('9f8e7d6c5b4a3f2e1d0c')
  })
})

describe('screenOutbound — lets real answers through', () => {
  it('delivers an answer containing a code block', () => {
    // The memory guard refuses code fences; the outbound guard must not, or a
    // robot could never answer a question about code.
    const text = 'Use this:\n```ts\nconst x = 1\n```'
    expect(screenOutbound(text, MAX)).toEqual({ ok: true, text })
  })

  it('delivers prose that merely names a credential', () => {
    const text = 'The token is injected from the environment; it is not in the repo.'
    expect(screenOutbound(text, MAX).ok).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    expect(screenOutbound('  answer  ', MAX)).toEqual({ ok: true, text: 'answer' })
  })
})

describe('screenOutbound — truncation is visible', () => {
  it('keeps a long answer within the platform limit', () => {
    const verdict = screenOutbound('x'.repeat(500), 100)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.text.length).toBeLessThanOrEqual(100)
  })

  it('tells the reader the answer was cut, rather than just stopping', () => {
    const verdict = screenOutbound('x'.repeat(500), 100)
    expect(verdict.ok && verdict.text).toContain('截断')
  })

  it('leaves an answer at exactly the limit untouched', () => {
    const text = 'y'.repeat(100)
    expect(screenOutbound(text, 100)).toEqual({ ok: true, text })
  })
})
