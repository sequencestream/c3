/**
 * Minimal 5-field "standard" cron parser and next-run calculator.
 *
 * Shared between the server scheduler engine and the web form's live preview so
 * both compute identical next-run timestamps. Supports the standard 5 fields
 * (minute hour day-of-month month day-of-week); no seconds, no `@yearly` macros.
 *
 * Cron fields are interpreted in a caller-supplied IANA time zone (the system
 * `timezone` setting — see `server/src/settings.ts:getTimezone`). The returned
 * value is always an absolute Unix-ms instant. When the zone is omitted (or the
 * literal `'UTC'`), computation stays in UTC — identical to the original
 * UTC-only behaviour, kept as a regression-safe default. The zoned path uses
 * `Intl.DateTimeFormat` to convert between the zone's wall-clock and UTC,
 * handling daylight-saving transitions (gap times are skipped; fold times take
 * the earlier offset).
 */

interface CronField {
  values: Set<number> // matching values (0-based for all fields)
  all: boolean // true if field is '*'
}

/**
 * Parse a single cron field into a set of matching values.
 * Supports: asterisk, asterisk/N, N-M, N,M,O, and bare numbers.
 */
function parseField(field: string, min: number, max: number): CronField {
  if (field === '*') return { values: new Set<number>(), all: true }
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\d+)(?:-(\d+))?\/(\d+)$/)
    const rangeMatch = part.match(/^(\d+)(?:-(\d+))?$/)
    const wildStep = part.match(/^\*\/(\d+)$/)
    if (wildStep) {
      const step = parseInt(wildStep[1], 10)
      for (let v = min; v <= max; v += step) values.add(v)
    } else if (stepMatch) {
      const lo = parseInt(stepMatch[1], 10)
      const hi = stepMatch[2] !== undefined ? parseInt(stepMatch[2], 10) : max
      const step = parseInt(stepMatch[3], 10)
      for (let v = lo; v <= hi; v += step) values.add(v)
    } else if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10)
      const hi = rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : lo
      for (let v = lo; v <= hi; v++) values.add(v)
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n)) values.add(n)
    }
  }
  return { values, all: false }
}

export interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

/**
 * Parse a 5-field cron expression into structured fields.
 * Standard order: minute hour day-of-month month day-of-week.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields, got ${fields.length}`)
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6),
  }
}

/** True when a 5-field cron expression parses without error. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

function matches(field: CronField, value: number): boolean {
  return field.all || field.values.has(value)
}

const MAX_LOOKAHEAD = 365 * 2 + 1 // days
const FAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Standard cron day matching: when BOTH day-of-month and day-of-week are
 * restricted, the day matches if EITHER matches (union). When one is '*', only
 * the other constrains the day. (A naive `dom || dow` would make a
 * day-of-week-only expression like "0 3 * * 1" fire every day, since dom='*'
 * always matches.)
 */
function dayMatches(cron: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = matches(cron.dayOfMonth, dayOfMonth)
  const dowMatch = matches(cron.dayOfWeek, dayOfWeek)
  return !cron.dayOfMonth.all && !cron.dayOfWeek.all ? domMatch || dowMatch : domMatch && dowMatch
}

/** The zone-local wall-clock fields of a UTC instant, via `Intl.DateTimeFormat`. */
interface WallParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
  second: number // 0-59
}

function wallParts(ms: number, timeZone: string): WallParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const out: Record<string, number> = {}
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10)
  }
  // `h23` can render midnight as hour 24; normalise to 0.
  if (out.hour === 24) out.hour = 0
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  }
}

/** The zone's UTC offset (ms) at a given instant: (wall-clock-as-UTC) − instant. */
function tzOffsetMs(ms: number, timeZone: string): number {
  const p = wallParts(ms, timeZone)
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUTC - ms
}

/**
 * Convert a wall-clock time in `timeZone` to its absolute Unix-ms instant.
 * Applies the offset, then refines once: the offset sampled at the first guess
 * may differ from the offset that actually applies at the resulting instant
 * (a DST boundary), so a second sample corrects it.
 */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const off1 = tzOffsetMs(asUTC, timeZone)
  let ts = asUTC - off1
  const off2 = tzOffsetMs(ts, timeZone)
  if (off2 !== off1) ts = asUTC - off2
  return ts
}

/**
 * Compute the next run timestamp (Unix ms) strictly after `after` for a cron
 * expression. Walks forward day-by-day, then hour/minute within each matching
 * day, until all fields match. Throws-free: returns a far-future timestamp if no
 * match is found within a reasonable look-ahead (2 years) to avoid infinite
 * loops on impossible expressions.
 *
 * `timeZone` (an IANA name, e.g. `Asia/Shanghai`) selects the zone the cron
 * fields are interpreted in. Omitted or `'UTC'` ⇒ UTC computation, identical to
 * the historical behaviour.
 */
export function computeNextRunAt(
  cronExpression: string,
  after: number = Date.now(),
  timeZone?: string,
): number {
  const cron = parseCron(cronExpression)

  if (timeZone && timeZone !== 'UTC') {
    return computeNextRunAtZoned(cron, after, timeZone)
  }

  const start = new Date(after)
  // Round to next full minute
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  for (let d = 0; d < MAX_LOOKAHEAD; d++) {
    const date = new Date(start)
    date.setUTCDate(date.getUTCDate() + d)
    if (!matches(cron.month, date.getUTCMonth() + 1)) continue
    if (!dayMatches(cron, date.getUTCDate(), date.getUTCDay())) continue

    for (let h = 0; h < 24; h++) {
      if (!matches(cron.hour, h)) continue
      for (let m = 0; m < 60; m++) {
        if (!matches(cron.minute, m)) continue
        date.setUTCHours(h, m, 0, 0)
        if (date.getTime() <= after) continue
        return date.getTime()
      }
    }
  }
  // Fallback: automation far in the future to avoid tight loop on invalid cron
  return after + FAR_FUTURE_MS
}

/**
 * Zoned variant: iterate candidate days/times in the target zone's calendar.
 * A UTC `Date` is used purely as a calendar carrier for the zone-local Y/M/D
 * (day-of-week via `getUTCDay` is calendar-only, zone-independent); each
 * candidate wall-clock is mapped back to an absolute instant via
 * {@link zonedWallToUtc}. Candidates whose round-tripped wall-clock does not
 * match the requested fields are skipped — this naturally drops the
 * non-existent local times in a spring-forward DST gap.
 */
function computeNextRunAtZoned(cron: ParsedCron, after: number, timeZone: string): number {
  const startWall = wallParts(after, timeZone)
  // Calendar carrier: a UTC date holding the zone-local calendar date of `after`.
  const carrier = new Date(Date.UTC(startWall.year, startWall.month - 1, startWall.day))

  for (let d = 0; d < MAX_LOOKAHEAD; d++) {
    const date = new Date(carrier)
    date.setUTCDate(date.getUTCDate() + d)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const dom = date.getUTCDate()
    if (!matches(cron.month, month)) continue
    if (!dayMatches(cron, dom, date.getUTCDay())) continue

    for (let h = 0; h < 24; h++) {
      if (!matches(cron.hour, h)) continue
      for (let m = 0; m < 60; m++) {
        if (!matches(cron.minute, m)) continue
        const ts = zonedWallToUtc(year, month, dom, h, m, timeZone)
        if (ts <= after) continue
        // Reject DST-gap times: the requested wall-clock doesn't exist, so its
        // round-trip lands on a different local time.
        const back = wallParts(ts, timeZone)
        if (back.year !== year || back.month !== month || back.day !== dom) continue
        if (back.hour !== h || back.minute !== m) continue
        return ts
      }
    }
  }
  return after + FAR_FUTURE_MS
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function describeField(raw: string): { isWild: boolean; list: number[] } {
  if (raw === '*') return { isWild: true, list: [] }
  const list: number[] = []
  for (const part of raw.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (m) {
      const lo = parseInt(m[1], 10)
      const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo
      for (let v = lo; v <= hi; v++) list.push(v)
    }
  }
  return { isWild: false, list }
}

/**
 * Produce a short human-readable, English description of a cron expression for
 * display next to the live preview (e.g. "Every 30 minutes",
 * "At 08:00 on Mon–Fri"). Falls back to the raw expression when the shape is not
 * one the describer recognises. Best-effort, not exhaustive.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return expr
  const [min, hour, dom, mon, dow] = fields

  // Every N minutes — "*/N * * * *"
  const everyMin = min.match(/^\*\/(\d+)$/)
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${everyMin[1]} minutes`
  }
  // Every N hours — "0 */N * * *"
  const everyHour = hour.match(/^\*\/(\d+)$/)
  if (min === '0' && everyHour && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${everyHour[1]} hours`
  }

  const parts: string[] = []

  // Time-of-day, when minute and hour are concrete single values.
  const minD = describeField(min)
  const hourD = describeField(hour)
  if (!minD.isWild && !hourD.isWild && minD.list.length === 1 && hourD.list.length === 1) {
    const hh = String(hourD.list[0]).padStart(2, '0')
    const mm = String(minD.list[0]).padStart(2, '0')
    parts.push(`At ${hh}:${mm}`)
  } else if (min === '0' && hourD.isWild) {
    parts.push('Every hour')
  }

  // Day-of-week.
  const dowD = describeField(dow)
  if (!dowD.isWild && dowD.list.length > 0) {
    const days = dowD.list.map((d) => DOW_NAMES[d % 7])
    // Recognise the weekday run (Mon–Fri).
    if (dowD.list.length === 5 && dowD.list.join(',') === '1,2,3,4,5') {
      parts.push('on Mon–Fri')
    } else {
      parts.push(`on ${days.join(', ')}`)
    }
  } else if (!describeField(dom).isWild) {
    parts.push(`on day ${dom} of the month`)
  }

  return parts.length > 0 ? parts.join(' ') : expr
}
