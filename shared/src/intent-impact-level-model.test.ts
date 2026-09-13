/**
 * `isIntentImpactLevel` — the persisted-value guard.
 * `canEditIntentImpactLevel` — the one "may this grade still be changed" criterion.
 */
import { describe, expect, it } from 'vitest'
import type { IntentStatus } from './protocol.js'
import {
  canEditIntentImpactLevel,
  isIntentImpactLevel,
  needsReview,
} from './intent-impact-level-model.js'

describe('isIntentImpactLevel', () => {
  it.each(['L1', 'L2', 'L3', 'L4', 'L5'])('accepts %s', (v) => {
    expect(isIntentImpactLevel(v)).toBe(true)
  })

  it.each([['L0'], ['L6'], ['l1'], [''], [null], [undefined], [1], [{}]])(
    'rejects %s — an uninterpretable value is not a grade',
    (v) => {
      expect(isIntentImpactLevel(v)).toBe(false)
    },
  )
})

describe('canEditIntentImpactLevel', () => {
  it.each(['draft', 'todo', 'cancelled', 'blocked', 'failed'] as const)(
    'allows editing while %s',
    (status) => {
      expect(canEditIntentImpactLevel({ status })).toBe(true)
    },
  )

  it.each(['in_progress', 'done'] as const)('locks while %s', (status: IntentStatus) => {
    expect(canEditIntentImpactLevel({ status })).toBe(false)
  })
})

describe('needsReview', () => {
  it.each(['L1', 'L2', 'L3', 'L4'] as const)('requires review for %s', (level) => {
    expect(needsReview(level)).toBe(true)
  })

  it('does not require review for L5 (wording / cosmetic)', () => {
    expect(needsReview('L5')).toBe(false)
  })

  it('requires review for an ungraded intent (fail-safe: when in doubt, review)', () => {
    expect(needsReview(null)).toBe(true)
  })

  it('a narrowed-to-null unrecognised grade still requires review (never slips through)', () => {
    // The store narrows an uninterpretable persisted value to `null` before this
    // function runs; here we assert the narrow-then-review contract directly.
    expect(needsReview(null)).toBe(true)
  })
})
