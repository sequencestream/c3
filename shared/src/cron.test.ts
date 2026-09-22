import { describe, it, expect } from 'vitest'
import {
  computeNextRunAt,
  isValidCron,
  describeCron,
  parseCron,
  parseHourWindow,
  renderHourWindow,
} from './cron.js'

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

  it('names the execution window of a minutely schedule', () => {
    expect(describeCron('*/5 8-17 * * *')).toBe('Every 5 minutes between 08:00 and 18:00')
    // Overnight: the window end wraps past midnight.
    expect(describeCron('*/5 22-23,0-7 * * *')).toBe('Every 5 minutes between 22:00 and 08:00')
    expect(describeCron('*/1 8-17 * * *')).toBe('Every minute between 08:00 and 18:00')
  })

  it('names the execution window of an hourly schedule', () => {
    expect(describeCron('0 8-17 * * *')).toBe('Every hour between 08:00 and 18:00')
    expect(describeCron('0 8-17/2 * * *')).toBe('Every 2 hours between 08:00 and 18:00')
    expect(describeCron('0 22-23/2,0-7/2 * * *')).toBe('Every 2 hours between 22:00 and 08:00')
    expect(describeCron('30 8-17/2 * * *')).toBe(
      'Every 2 hours at minute 30 between 08:00 and 18:00',
    )
  })

  it('describes a 1-step interval in the singular', () => {
    expect(describeCron('0 */1 * * *')).toBe('Every hour')
    expect(describeCron('*/1 * * * *')).toBe('Every minute')
  })
})

describe('parseHourWindow / renderHourWindow', () => {
  it('parses the shapes the editor produces', () => {
    expect(parseHourWindow('*')).toMatchObject({ start: 0, end: 24, allDay: true })
    expect(parseHourWindow('*/2')).toMatchObject({ start: 0, end: 24, step: 2, allDay: true })
    expect(parseHourWindow('0-23')).toMatchObject({ start: 0, end: 24, allDay: true })
    expect(parseHourWindow('8-17')).toMatchObject({ start: 8, end: 18, allDay: false })
    expect(parseHourWindow('8-17/2')).toMatchObject({ start: 8, end: 18, step: 2 })
    expect(parseHourWindow('22-23,0-7')).toMatchObject({ start: 22, end: 8, allDay: false })
    expect(parseHourWindow('22-23/2,0-7/2')).toMatchObject({ start: 22, end: 8, step: 2 })
    // A single-hour window (`8-8` is [08:00, 09:00)) and an end at midnight.
    expect(parseHourWindow('8-8')).toMatchObject({ start: 8, end: 9 })
    expect(parseHourWindow('22-23')).toMatchObject({ start: 22, end: 24 })
  })

  it('refuses shapes it cannot round-trip rather than widening the window', () => {
    expect(parseHourWindow('8')).toBeNull() // a point, not a window
    expect(parseHourWindow('8-12,14-18')).toBeNull() // two disjoint windows
    expect(parseHourWindow('22-23/3,0-7/2')).toBeNull() // segments step differently
    expect(parseHourWindow('22-23,0-23')).toBeNull() // the second segment is the whole day
    expect(parseHourWindow('22-23,0-22,5-6')).toBeNull()
  })

  it('renders each shape back to the field it came from', () => {
    expect(renderHourWindow(0, 24)).toBe('*')
    expect(renderHourWindow(0, 24, 2)).toBe('*/2')
    expect(renderHourWindow(8, 18)).toBe('8-17')
    expect(renderHourWindow(8, 18, 2)).toBe('8-17/2')
    expect(renderHourWindow(8, 9)).toBe('8-8')
    expect(renderHourWindow(22, 8)).toBe('22-23,0-7')
    expect(renderHourWindow(22, 8, 2)).toBe('22-23/2,0-7/2')
    expect(renderHourWindow(22, 24)).toBe('22-23')
  })

  it('drops a step of 1 inside a window but keeps it for the all-day form', () => {
    // The all-day form is the pre-window output and must stay byte-identical.
    expect(renderHourWindow(0, 24, 1)).toBe('*/1')
    expect(renderHourWindow(8, 18, 1)).toBe('8-17')
    expect(renderHourWindow(22, 8, 1)).toBe('22-23,0-7')
  })

  it('round-trips through parse and render', () => {
    for (const field of ['*', '*/2', '8-17', '8-17/2', '22-23,0-7', '22-23/2,0-7/2']) {
      const window = parseHourWindow(field)!
      expect(renderHourWindow(window.start, window.end, window.step)).toBe(field)
    }
  })
})

describe('computeNextRunAt — execution window (Asia/Shanghai)', () => {
  const TZ = 'Asia/Shanghai'
  // 2026-06-03 21:30 Shanghai = 13:30 UTC; the window opens at 22:00 (14:00 UTC).
  const BEFORE_WINDOW = Date.UTC(2026, 5, 3, 13, 30)
  // 2026-06-03 22:05 Shanghai = 14:05 UTC; inside the window.
  const IN_WINDOW = Date.UTC(2026, 5, 3, 14, 5)

  it('minutely window — steps by minute inside the window, across midnight', () => {
    expect(iso(computeNextRunAt('*/5 22-23,0-7 * * *', BEFORE_WINDOW, TZ))).toBe(
      '2026-06-03T14:00:00.000Z',
    )
    // Stays on the minute grid: 22:05 → 22:10, not the window's next opening.
    expect(iso(computeNextRunAt('*/5 22-23,0-7 * * *', IN_WINDOW, TZ))).toBe(
      '2026-06-03T14:10:00.000Z',
    )
  })

  it('hourly window — steps by hour from the window start, across midnight', () => {
    expect(iso(computeNextRunAt('0 22-23/2,0-7/2 * * *', BEFORE_WINDOW, TZ))).toBe(
      '2026-06-03T14:00:00.000Z',
    )
    // 22:00 has fired; the next anchor is 00:00 the following day (16:00 UTC).
    expect(iso(computeNextRunAt('0 22-23/2,0-7/2 * * *', IN_WINDOW, TZ))).toBe(
      '2026-06-03T16:00:00.000Z',
    )
  })

  it('the window excludes the hour it ends on', () => {
    // 18:00 Shanghai (10:00 UTC) is outside `8-17`, so the next run is tomorrow.
    expect(iso(computeNextRunAt('0 8-17 * * *', Date.UTC(2026, 5, 3, 10, 0), TZ))).toBe(
      '2026-06-04T00:00:00.000Z',
    )
  })
})
