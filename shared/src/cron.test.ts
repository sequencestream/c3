import { describe, it, expect } from 'vitest'
import { computeNextRunAt, isValidCron, describeCron, parseCron } from './cron.js'

// A fixed reference instant: 2026-06-03T12:30:00Z (Wednesday).
const REF = Date.UTC(2026, 5, 3, 12, 30, 0)

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('parseCron / isValidCron', () => {
  it('accepts standard 5-field expressions', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true)
    expect(isValidCron('0 8 * * 1-5')).toBe(true)
    expect(isValidCron('0 3 * * 1')).toBe(true)
  })

  it('rejects malformed expressions', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('* * * * * *')).toBe(false)
    expect(() => parseCron('foo')).toThrow()
  })
})

describe('computeNextRunAt', () => {
  it('every 30 minutes — rounds to the next half-hour boundary', () => {
    // 12:30:00 -> next match is 13:00 (12:30 itself is excluded: strictly after)
    expect(iso(computeNextRunAt('*/30 * * * *', REF))).toBe('2026-06-03T13:00:00.000Z')
    // From 12:45 -> 13:00
    expect(iso(computeNextRunAt('*/30 * * * *', Date.UTC(2026, 5, 3, 12, 45)))).toBe(
      '2026-06-03T13:00:00.000Z',
    )
  })

  it('weekdays at 08:00 — skips ahead to the next weekday morning', () => {
    // REF is Wed 12:30 -> already past 08:00 today, next is Thu 08:00.
    expect(iso(computeNextRunAt('0 8 * * 1-5', REF))).toBe('2026-06-04T08:00:00.000Z')
    // From Fri 2026-06-05 12:00 -> next weekday is Mon 2026-06-08 08:00.
    expect(iso(computeNextRunAt('0 8 * * 1-5', Date.UTC(2026, 5, 5, 12, 0)))).toBe(
      '2026-06-08T08:00:00.000Z',
    )
  })

  it('every Monday at 03:00', () => {
    // From Wed 2026-06-03 -> next Monday is 2026-06-08 03:00.
    expect(iso(computeNextRunAt('0 3 * * 1', REF))).toBe('2026-06-08T03:00:00.000Z')
  })

  it('is strictly after the given instant (never returns `after`)', () => {
    const exact = Date.UTC(2026, 5, 3, 13, 0, 0)
    expect(computeNextRunAt('0 13 * * *', exact)).toBeGreaterThan(exact)
  })
})

describe('describeCron', () => {
  it('describes the acceptance presets in English', () => {
    expect(describeCron('*/30 * * * *')).toBe('Every 30 minutes')
    expect(describeCron('0 8 * * 1-5')).toBe('At 08:00 on Mon–Fri')
    expect(describeCron('0 3 * * 1')).toBe('At 03:00 on Monday')
  })

  it('falls back to the raw expression for unrecognised shapes', () => {
    expect(describeCron('not a cron')).toBe('not a cron')
  })
})
