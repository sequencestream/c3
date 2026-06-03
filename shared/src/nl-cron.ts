/**
 * Best-effort natural-language → cron heuristic parser for the schedule form's
 * "Natural language" input mode. It recognises a bounded set of common English
 * phrasings; anything it does not understand returns `null`, and the UI then asks
 * the user to pick a preset or use the Advanced segmented builder instead.
 *
 * This is deliberately NOT a general NLP system — it guarantees the documented
 * acceptance phrasings and the built-in presets, plus a handful of obvious
 * variations. All times are interpreted as server (UTC) time, matching `cron.ts`.
 */

export interface CronPreset {
  /** Short English label shown on the preset card. */
  label: string
  /** Cron expression filled in when the card is picked. */
  cron: string
}

/** One-click preset cards offered in the form. */
export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Weekdays at 8am', cron: '0 8 * * 1-5' },
  { label: 'Every day at midnight', cron: '0 0 * * *' },
  { label: 'Every Monday at 3am', cron: '0 3 * * 1' },
  { label: 'First day of month at 9am', cron: '0 9 1 * *' },
]

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

/** Parse a time-of-day fragment like "8am", "3:30pm", "08:00", "noon". */
function parseTime(text: string): { hour: number; minute: number } | null {
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0 }
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 }

  // "at 8", "at 8:30", "8am", "8:30 pm", "08:00", "20:00"
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = m[2] !== undefined ? parseInt(m[2], 10) : 0
  const meridiem = m[3]
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  // A bare number with no am/pm and no colon is ambiguous (could be "every 8
  // minutes" handled elsewhere) — only treat it as a time when "at" precedes it.
  if (!meridiem && m[2] === undefined && !/\bat\s+\d/.test(text)) return null
  return { hour, minute }
}

/** Collect the set of matched weekday numbers (0=Sun..6=Sat) referenced in the text. */
function parseDays(text: string): number[] {
  if (/\bweekday(s)?\b/.test(text) || /\bevery work\s?day\b/.test(text)) return [1, 2, 3, 4, 5]
  if (/\bweekend(s)?\b/.test(text)) return [0, 6]
  const found = new Set<number>()
  for (const [name, num] of Object.entries(DAY_NAMES)) {
    const re = new RegExp(`\\b${name}\\b`)
    if (re.test(text)) found.add(num)
  }
  return [...found].sort((a, b) => a - b)
}

/** Render a day-of-week field from a list of weekday numbers. */
function renderDow(days: number[]): string {
  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return '1-5'
  return days.join(',')
}

/**
 * Attempt to convert a natural-language schedule description into a 5-field cron
 * expression. Returns the cron string, or `null` when the phrasing is not
 * recognised.
 */
export function nlToCron(input: string): string | null {
  const text = input.toLowerCase().trim()
  if (!text) return null

  // "every N minutes" / "every minute"
  const everyMin = text.match(/\bevery\s+(\d+)\s*min(ute)?s?\b/)
  if (everyMin) {
    const n = parseInt(everyMin[1], 10)
    if (n >= 1 && n <= 59) return `*/${n} * * * *`
  }
  if (/\bevery\s+minute\b/.test(text)) return '* * * * *'

  // "every N hours" / "hourly" / "every hour"
  const everyHour = text.match(/\bevery\s+(\d+)\s*hours?\b/)
  if (everyHour) {
    const n = parseInt(everyHour[1], 10)
    if (n >= 1 && n <= 23) return `0 */${n} * * *`
  }
  if (/\bhourly\b/.test(text) || /\bevery\s+hour\b/.test(text)) return '0 * * * *'

  // Time-of-day based schedules (daily / weekday / specific days).
  const time = parseTime(text)
  const days = parseDays(text)

  if (time) {
    const dow = days.length > 0 ? renderDow(days) : '*'
    return `${time.minute} ${time.hour} * * ${dow}`
  }

  // "daily" / "every day" with no explicit time → midnight.
  if (/\bdaily\b/.test(text) || /\bevery\s+day\b/.test(text)) {
    return '0 0 * * *'
  }

  return null
}
