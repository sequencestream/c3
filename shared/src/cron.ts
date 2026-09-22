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

/**
 * The single contiguous execution window an hour field carries, as the half-open
 * interval `[start:00, end:00)`. `end` is 1–24, where 24 means the following
 * midnight; `end` at or below `start` wraps past midnight. Only the all-day
 * window (0 → 24) renders as `*`.
 *
 * The hour field can encode more than this — several disjoint ranges, or a step
 * the editor cannot express — so parsing returns `null` for everything it cannot
 * round-trip faithfully rather than guessing (a wrong guess would silently widen
 * when the schedule runs).
 */
export interface HourWindow {
  start: number // 0-23
  end: number // 1-24
  /** Hour step carried by the field (`/N`), when present. */
  step?: number
  allDay: boolean
}

/** One comma-separated hour segment: `N`, `N-M`, `N/S` or `N-M/S`. */
function hourSegment(
  part: string,
): { lo: number; hi: number; step?: number; ranged: boolean } | null {
  const m = part.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/)
  if (!m) return null
  const step = m[3] !== undefined ? parseInt(m[3], 10) : undefined
  // A step without an upper bound runs to the end of the field, as in `8/2`.
  const hi = m[2] !== undefined ? parseInt(m[2], 10) : step !== undefined ? 23 : parseInt(m[1], 10)
  return { lo: parseInt(m[1], 10), hi, step, ranged: m[2] !== undefined }
}

/** `end` below `start` is an overnight window; `end === start` is empty (rejected). */
function hourWindow(start: number, end: number, step?: number): HourWindow | null {
  if (start < 0 || start > 23 || end < 1 || end > 24 || end === start) return null
  if (step !== undefined && step < 1) return null
  return { start, end, step, allDay: start === 0 && end === 24 }
}

/**
 * Parse an hour field into the execution window it encodes, or `null` when it is
 * not a single contiguous window (`8-12,14-18`, a bare hour like `8` — a point,
 * not a window — or an overnight split whose halves step differently).
 */
export function parseHourWindow(field: string): HourWindow | null {
  if (field === '*') return { start: 0, end: 24, allDay: true }
  const wildStep = field.match(/^\*\/(\d+)$/)
  if (wildStep) return hourWindow(0, 24, parseInt(wildStep[1], 10))

  const segments = field.split(',')
  if (segments.length === 1) {
    const s = hourSegment(segments[0])
    if (!s) return null
    // A reversed bound (`22-7`) matches nothing, so it is not an overnight window.
    if (s.hi < s.lo) return null
    // `0-23` is the whole day written out explicitly.
    if (s.lo === 0 && s.hi === 23) return hourWindow(0, 24, s.step)
    // A bare hour is a point, not a window — daily expressions seed from it.
    if (!s.ranged && s.step === undefined) return null
    return hourWindow(s.lo, s.hi + 1, s.step)
  }
  if (segments.length === 2) {
    const [a, b] = [hourSegment(segments[0]), hourSegment(segments[1])]
    // The canonical overnight split: `22-23` then `0-7`, with matching steps.
    // The two halves are one interval cut by midnight, so a step must be written
    // the same way on both — `22-23/2,0-7` and `22-23,0-7/2` step the halves
    // differently and would not come back out of the editor unchanged.
    if (!a || !b) return null
    if (a.lo < 1 || a.hi !== 23 || b.lo !== 0 || b.hi > 22) return null
    if (a.step !== b.step) return null
    return hourWindow(a.lo, b.hi + 1, a.step)
  }
  return null
}

/**
 * Render the hour field for the half-open window `[start, end)`, optionally
 * stepping within it. All-day renders as the bare wildcard, plus a step suffix
 * when one is given, so an editor with no window set keeps producing the same
 * expression it always did; a
 * windowed step of 1 is dropped (`8-17` rather than `8-17/1`).
 *
 * `start === end` is an empty window and the caller's to reject: it renders here
 * as the overnight split, which spans the whole day.
 */
export function renderHourWindow(start: number, end: number, step?: number): string {
  // Only 24 denotes the following midnight; 0 is the same instant written twice.
  const stop = end <= 0 ? 24 : end
  const suffix = step !== undefined && step > 1 ? `/${step}` : ''
  if (start === 0 && stop === 24) return step !== undefined ? `*/${step}` : '*'
  if (start < stop) return `${start}-${stop - 1}${suffix}`
  // Overnight: the window is cut by midnight into two runs that step separately.
  return `${start}-23${suffix},0-${stop - 1}${suffix}`
}

/** `8` → `08:00`, `24` → `00:00` (24 denotes the following midnight). */
function clockHour(hour: number): string {
  return `${String(hour % 24).padStart(2, '0')}:00`
}

/** "Every minute" / "Every 5 minutes" — singular for a step of 1. */
function everyCount(unit: 'minute' | 'hour', step: number): string {
  return step === 1 ? `Every ${unit}` : `Every ${step} ${unit}s`
}

/**
 * "between 08:00 and 18:00" for a window. An overnight window reads
 * "between 22:00 and 08:00" — the reader knows the end has wrapped.
 */
function betweenWindow(window: HourWindow): string {
  return `between ${clockHour(window.start)} and ${clockHour(window.end)}`
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

/** "on Mon–Fri" / "on Tuesday, Saturday"; empty when day-of-week is unconstrained. */
function dayOfWeekText(dow: string): string {
  const d = describeField(dow)
  if (d.isWild || d.list.length === 0) return ''
  // Recognise the weekday run (Mon–Fri).
  if (d.list.length === 5 && d.list.join(',') === '1,2,3,4,5') return 'on Mon–Fri'
  return `on ${d.list.map((n) => DOW_NAMES[n % 7]).join(', ')}`
}

/**
 * Produce a short human-readable, English description of a cron expression for
 * display next to the live preview (e.g. "Every 30 minutes",
 * "At 08:00 on Mon–Fri", "Every 5 minutes between 08:00 and 18:00"). Falls back
 * to the raw expression when the shape is not one the describer recognises.
 * Best-effort, not exhaustive.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return expr
  const [min, hour, dom, mon, dow] = fields

  // The interval shapes below describe a cadence, optionally narrowed to a
  // day-of-week set; a day-of-month or month constraint is outside them and
  // falls through to the generic path below.
  const noMonthDay = dom === '*' && mon === '*'
  const onDays = dayOfWeekText(dow)
  const suffix = onDays ? ` ${onDays}` : ''

  // Every N minutes — "*/N * * * *"
  const everyMin = min.match(/^\*\/(\d+)$/)
  if (everyMin && noMonthDay) {
    const every = everyCount('minute', parseInt(everyMin[1], 10))
    if (hour === '*') return `${every}${suffix}`
    // Every N minutes within an execution window — "*/N H1-H2".
    const window = parseHourWindow(hour)
    if (window && window.step === undefined && !window.allDay) {
      return `${every} ${betweenWindow(window)}${suffix}`
    }
  }
  // Every N hours — "0 */N * * *"
  const everyHour = hour.match(/^\*\/(\d+)$/)
  if (min === '0' && everyHour && noMonthDay) {
    return `${everyCount('hour', parseInt(everyHour[1], 10))}${suffix}`
  }

  // Every N hours within an execution window — "M H1-H2/N".
  const fixedMinute = min.match(/^(\d+)$/)
  if (fixedMinute && noMonthDay) {
    const window = parseHourWindow(hour)
    if (window && !window.allDay) {
      const at = fixedMinute[1] === '0' ? '' : ` at minute ${fixedMinute[1].padStart(2, '0')}`
      return `${everyCount('hour', window.step ?? 1)}${at} ${betweenWindow(window)}${suffix}`
    }
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
  if (onDays) {
    parts.push(onDays)
  } else if (!describeField(dom).isWild) {
    parts.push(`on day ${dom} of the month`)
  }

  return parts.length > 0 ? parts.join(' ') : expr
}
