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

  it("an explicit 'UTC' zone matches the default UTC behaviour exactly", () => {
    // Regression guard: passing 'UTC' must be byte-identical to the no-zone path.
    for (const expr of ['*/30 * * * *', '0 8 * * 1-5', '0 3 * * 1', '0 13 * * *']) {
      expect(computeNextRunAt(expr, REF, 'UTC')).toBe(computeNextRunAt(expr, REF))
    }
  })
})

describe('computeNextRunAt — zoned (Asia/Shanghai, UTC+8, no DST)', () => {
  const TZ = 'Asia/Shanghai'

  it('interprets the hour field in the zone, mapping to the right UTC instant', () => {
    // 2026-06-03T00:00Z = 08:00 Shanghai → 11:00 Shanghai today (= 03:00 UTC).
    expect(iso(computeNextRunAt('0 11 * * *', Date.UTC(2026, 5, 3, 0, 0), TZ))).toBe(
      '2026-06-03T03:00:00.000Z',
    )
    // REF = 2026-06-03T12:30Z = 20:30 Shanghai → today's 11:00 has passed, next is
    // 2026-06-04 11:00 Shanghai (= 03:00 UTC next day).
    expect(iso(computeNextRunAt('0 11 * * *', REF, TZ))).toBe('2026-06-04T03:00:00.000Z')
  })

  it('differs from the UTC interpretation of the same expression by the offset', () => {
    // Under UTC, `0 11 * * *` from REF (12:30Z) skips to the next day 11:00 UTC.
    expect(iso(computeNextRunAt('0 11 * * *', REF))).toBe('2026-06-04T11:00:00.000Z')
    // Under Asia/Shanghai it's 8h earlier in UTC terms (03:00Z vs 11:00Z).
    expect(iso(computeNextRunAt('0 11 * * *', REF, TZ))).toBe('2026-06-04T03:00:00.000Z')
  })
})

describe('computeNextRunAt — zoned DST (America/New_York)', () => {
  const TZ = 'America/New_York'
  // 2026 spring-forward: 02:00 EST (-5) jumps to 03:00 EDT (-4) on Sun 2026-03-08.

  it('uses the standard-time offset before the transition', () => {
    // 2026-03-07 (Sat), still EST(-5): 12:00 ET = 17:00 UTC.
    expect(iso(computeNextRunAt('0 12 * * *', Date.UTC(2026, 2, 7, 0, 0), TZ))).toBe(
      '2026-03-07T17:00:00.000Z',
    )
  })

  it('uses the daylight offset after the transition (same wall-clock, new offset)', () => {
    // After the jump, EDT(-4): the next 12:00 ET (2026-03-09) = 16:00 UTC — an
    // hour earlier in UTC than the pre-DST run, proving the offset switched.
    expect(iso(computeNextRunAt('0 12 * * *', Date.UTC(2026, 2, 8, 20, 0), TZ))).toBe(
      '2026-03-09T16:00:00.000Z',
    )
  })

  it('skips a wall-clock time that does not exist in the spring-forward gap', () => {
    // 02:30 ET does not exist on 2026-03-08 (02:00→03:00). The run must land on
    // the next day's 02:30 EDT (= 06:30 UTC), never on the gap day.
    const next = computeNextRunAt('30 2 * * *', Date.UTC(2026, 2, 8, 0, 0), TZ)
    expect(iso(next)).toBe('2026-03-09T06:30:00.000Z')
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
