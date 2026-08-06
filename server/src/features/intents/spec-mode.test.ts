/**
 * Tests for the per-intent spec-mode resolution — the ONE place the effective
 * mode is derived from the persisted value plus the workspace SDD switch. The
 * rule must hold everywhere: an explicit `sdd`/`fast` always wins, and an unset
 * value inherits the workspace (`sdd` when SDD on, `fast` when off).
 */
import { describe, expect, it } from 'vitest'
import { isIntentSpecMode, resolveEffectiveSpecMode } from './spec-mode.js'

describe('resolveEffectiveSpecMode', () => {
  it('inherits `sdd` when unset and the workspace has SDD on', () => {
    expect(resolveEffectiveSpecMode(null, true)).toBe('sdd')
    expect(resolveEffectiveSpecMode(undefined, true)).toBe('sdd')
  })

  it('inherits `fast` when unset and the workspace has SDD off', () => {
    expect(resolveEffectiveSpecMode(null, false)).toBe('fast')
    expect(resolveEffectiveSpecMode(undefined, false)).toBe('fast')
  })

  it('an explicit value always wins over the workspace switch', () => {
    expect(resolveEffectiveSpecMode('fast', true)).toBe('fast')
    expect(resolveEffectiveSpecMode('sdd', false)).toBe('sdd')
  })
})

describe('isIntentSpecMode — persisted-value guard', () => {
  it('accepts only the two known mode constants', () => {
    expect(isIntentSpecMode('fast')).toBe(true)
    expect(isIntentSpecMode('sdd')).toBe(true)
  })

  it('rejects unknown / non-string values so persistence fail-closes to unset', () => {
    expect(isIntentSpecMode('nope')).toBe(false)
    expect(isIntentSpecMode('')).toBe(false)
    expect(isIntentSpecMode(null)).toBe(false)
    expect(isIntentSpecMode(undefined)).toBe(false)
    expect(isIntentSpecMode(42)).toBe(false)
  })
})
