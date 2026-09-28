/**
 * The declarative run-profile registry (2026-09-28). These tests pin the two
 * properties the guard's correctness rests on: every known profile is registered
 * with the conservative flags, and an UNKNOWN kind degrades safely instead of
 * silently inheriting a native policy.
 */
import { describe, it, expect } from 'vitest'
import {
  RUN_PROFILE_RULES,
  UNKNOWN_PROFILE_RULE,
  WORK_RUN_RULE,
  profilePayload,
  profileRule,
  type ProfileKind,
} from './run-profiles.js'

describe('RUN_PROFILE_RULES', () => {
  it('registers every known profile with the locked-gate flags', () => {
    const kinds: ProfileKind[] = ['intent', 'spec', 'spec-review', 'robot']
    for (const kind of kinds) {
      const rule = RUN_PROFILE_RULES[kind]
      expect(rule, `missing rule for ${kind}`).toBeDefined()
      expect(rule.overridesMode).toBe(true)
      expect(rule.bypassesNativePolicy).toBe(true)
    }
    expect(Object.keys(RUN_PROFILE_RULES).sort()).toEqual([...kinds].sort())
  })
})

describe('profileRule', () => {
  it('an ABSENT profile is a work run: no override, and the policy may ride along', () => {
    expect(profileRule(undefined)).toBe(WORK_RUN_RULE)
    expect(WORK_RUN_RULE.overridesMode).toBe(false)
    expect(WORK_RUN_RULE.bypassesNativePolicy).toBe(false)
  })

  it('an UNREGISTERED kind degrades conservatively (no override, no native policy)', () => {
    expect(profileRule('future-profile' as ProfileKind)).toBe(UNKNOWN_PROFILE_RULE)
    expect(UNKNOWN_PROFILE_RULE.overridesMode).toBe(false)
    expect(UNKNOWN_PROFILE_RULE.bypassesNativePolicy).toBe(true)
  })
})

describe('profilePayload', () => {
  it('reads only the payload matching the kind', () => {
    const spec = {
      appendSystemPrompt: 'S',
      disallowedTools: [],
      gate: 'spec' as const,
      bindMcp: () => ({ servers: {}, dispose: () => {} }),
    }
    expect(profilePayload({ kind: 'spec', spec })).toEqual({ spec })
    expect(profilePayload(undefined)).toEqual({})
  })

  it('an unregistered kind yields an empty set rather than undefined', () => {
    expect(profilePayload({ kind: 'future' } as never)).toEqual({})
  })
})
