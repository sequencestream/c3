/**
 * `isIntentImpactLevel` — the persisted-value guard.
 * `canEditIntentImpactLevel` — the one "may this grade still be changed" criterion.
 */
import { describe, expect, it } from 'vitest'
import type { IntentStatus } from './protocol.js'
import { canEditIntentImpactLevel, isIntentImpactLevel } from './intent-impact-level-model.js'

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
