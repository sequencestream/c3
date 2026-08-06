import { describe, expect, it } from 'vitest'
import type { IntentPr, IntentPrStatus } from './protocol.js'
import { activeIntentPrs, deriveIntentPrAggregate, pickPrimaryIntentPr } from './intent-pr-model.js'

function pr(status: IntentPrStatus, over: Partial<IntentPr> = {}): IntentPr {
  return {
    id: over.number ? `pr-${over.number}` : `pr-${status}`,
    intentId: 'intent-1',
    deliveryId: null,
    forge: 'github',
    repo: 'o/r',
    number: over.number ?? '1',
    url: null,
    status,
    headBranch: null,
    baseBranch: 'main',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

describe('deriveIntentPrAggregate', () => {
  // The ladder in full: undecided beats terminal, and a merge beats a plain close.
  it.each([
    ['no PR at all', [], null],
    ['a single reviewing PR', [pr('reviewing')], 'reviewing'],
    ['a single failed PR', [pr('failed')], 'failed'],
    ['a single rejected PR', [pr('rejected')], 'rejected'],
    ['a single merged PR', [pr('merged')], 'merged'],
    ['a single closed PR', [pr('closed')], 'closed'],
  ] as const)('reduces %s to %s', (_name, prs, expected) => {
    expect(deriveIntentPrAggregate(prs)).toBe(expected)
  })

  it('lets an unsettled PR outrank every terminal one', () => {
    expect(deriveIntentPrAggregate([pr('merged'), pr('reviewing')])).toBe('reviewing')
    expect(deriveIntentPrAggregate([pr('closed'), pr('reviewing')])).toBe('reviewing')
    // failed outranks rejected, and both outrank the terminal states.
    expect(deriveIntentPrAggregate([pr('merged'), pr('rejected'), pr('failed')])).toBe('failed')
    expect(deriveIntentPrAggregate([pr('closed'), pr('rejected')])).toBe('rejected')
  })

  it('prefers a merge over a plain close when everything is terminal', () => {
    expect(deriveIntentPrAggregate([pr('closed'), pr('merged')])).toBe('merged')
    expect(deriveIntentPrAggregate([pr('closed'), pr('closed')])).toBe('closed')
  })
})

describe('activeIntentPrs', () => {
  it('drops merged and closed, keeps input order for the rest', () => {
    const prs = [
      pr('merged', { number: '1' }),
      pr('reviewing', { number: '2' }),
      pr('closed', { number: '3' }),
      pr('failed', { number: '4' }),
    ]
    expect(activeIntentPrs(prs).map((p) => p.number)).toEqual(['2', '4'])
  })
})

describe('pickPrimaryIntentPr', () => {
  it('returns null when there is no PR', () => {
    expect(pickPrimaryIntentPr([])).toBeNull()
  })

  it('prefers the first still-active PR over an older terminal one', () => {
    const older = pr('merged', { number: '1', createdAt: 1 })
    const newer = pr('reviewing', { number: '2', createdAt: 2 })
    expect(pickPrimaryIntentPr([newer, older])?.number).toBe('2')
  })

  it('falls back to the oldest PR when every one is finished', () => {
    const older = pr('closed', { number: '1', createdAt: 1 })
    const newer = pr('merged', { number: '2', createdAt: 2 })
    expect(pickPrimaryIntentPr([newer, older])?.number).toBe('1')
  })

  it('breaks a createdAt tie by number so the choice is deterministic', () => {
    const a = pr('merged', { number: '10', createdAt: 5 })
    const b = pr('merged', { number: '2', createdAt: 5 })
    expect(pickPrimaryIntentPr([a, b])?.number).toBe('10') // '10' < '2' as strings
    expect(pickPrimaryIntentPr([b, a])?.number).toBe('10') // order-independent
  })
})
