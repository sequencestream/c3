/**
 * Minimal 5-field "standard" cron parser and next-run calculator.
 *
 * Shared between the server scheduler engine and the web form's live preview so
 * both compute identical next-run timestamps. Supports the standard 5 fields
 * (minute hour day-of-month month day-of-week); no seconds, no `@yearly` macros.
 *
 * All computation is in UTC — callers must treat the schedule timeline as server
 * (UTC) time. There is no per-schedule timezone.
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

/**
 * Compute the next run timestamp (Unix ms) at or after `after` for a cron expression.
 * Walks forward minute-by-minute until all fields match. Throws if no match found
 * within a reasonable look-ahead (2 years) to avoid infinite loops on impossible
 * expressions.
 */
export function computeNextRunAt(cronExpression: string, after: number = Date.now()): number {
  const cron = parseCron(cronExpression)
  const start = new Date(after)
  // Round to next full minute
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  const MAX_LOOKAHEAD = 365 * 2 + 1 // days

  for (let d = 0; d < MAX_LOOKAHEAD; d++) {
    const date = new Date(start)
    date.setUTCDate(date.getUTCDate() + d)
    if (!matches(cron.month, date.getUTCMonth() + 1)) continue
    // Standard cron day matching: when BOTH day-of-month and day-of-week are
    // restricted, the day matches if EITHER matches (union). When one is '*',
    // only the other constrains the day. (A naive `dom || dow` would make a
    // day-of-week-only expression like "0 3 * * 1" fire every day, since dom='*'
    // always matches.)
    const domMatch = matches(cron.dayOfMonth, date.getUTCDate())
    const dowMatch = matches(cron.dayOfWeek, date.getUTCDay())
    const dayMatch =
      !cron.dayOfMonth.all && !cron.dayOfWeek.all ? domMatch || dowMatch : domMatch && dowMatch
    if (!dayMatch) continue

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
  // Fallback: schedule far in the future to avoid tight loop on invalid cron
  return after + 365 * 24 * 60 * 60 * 1000
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
