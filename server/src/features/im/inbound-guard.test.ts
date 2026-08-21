/**
 * Inbound persistence guards: credential shapes and the Unicode code-point ceiling.
 */
import { describe, expect, it } from 'vitest'
import { ROBOT_CONTEXT_MAX_CODEPOINTS } from '@ccc/shared/protocol'
import { codePointCount, screenInbound, truncateCodePoints } from './inbound-guard.js'

describe('screenInbound', () => {
  it('allows ordinary text and code fences', () => {
    expect(screenInbound('status?')).toEqual({ ok: true })
    expect(screenInbound('use ```ts\nconst x = 1\n```')).toEqual({ ok: true })
  })

  it('refuses a known credential shape without echoing it', () => {
    const hit = screenInbound('token ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(hit.ok).toBe(false)
    if (hit.ok) return
    expect(hit.reason).toBe('credential')
    expect(hit.notice).not.toContain('ghp_')
  })

  it('accepts exactly 4000 code points and refuses 4001', () => {
    const ok = 'a'.repeat(ROBOT_CONTEXT_MAX_CODEPOINTS)
    const over = 'a'.repeat(ROBOT_CONTEXT_MAX_CODEPOINTS + 1)
    expect(screenInbound(ok)).toEqual({ ok: true })
    const refused = screenInbound(over)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('too_long')
  })

  it('counts Unicode code points, not UTF-16 units', () => {
    // U+1F600 is one code point, two UTF-16 code units.
    const emoji = '😀'
    expect(codePointCount(emoji)).toBe(1)
    expect(emoji.length).toBe(2)
    const almost = emoji.repeat(ROBOT_CONTEXT_MAX_CODEPOINTS)
    expect(screenInbound(almost)).toEqual({ ok: true })
    expect(screenInbound(almost + emoji).ok).toBe(false)
  })
})

describe('truncateCodePoints', () => {
  it('cuts to the code-point ceiling', () => {
    expect(truncateCodePoints('abcdef', 3)).toBe('abc')
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀')
  })
})
