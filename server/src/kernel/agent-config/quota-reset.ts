interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const QUOTA_LIMIT_RE =
  /\b(session\s*limit|session_limit|concurrent\s*session|rate\s*limit|rate_limit|too\s*many\s*requests|quota|exhausted|insufficient\s*quota|429)\b/i
const RESET_TIME_RE =
  /\breset(?:s|ting)?(?:\s+(?:at|on))?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\b/i

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
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = parseInt(part.value, 10)
  }
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

function tzOffsetMs(ms: number, timeZone: string): number {
  const parts = wallParts(ms, timeZone)
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return asUTC - ms
}

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

function addLocalDays(parts: WallParts, days: number): WallParts {
  const carrier = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  carrier.setUTCDate(carrier.getUTCDate() + days)
  return {
    ...parts,
    year: carrier.getUTCFullYear(),
    month: carrier.getUTCMonth() + 1,
    day: carrier.getUTCDate(),
  }
}

function parseHour(rawHour: string, marker: string | undefined): number | null {
  const hour = Number.parseInt(rawHour, 10)
  if (!Number.isFinite(hour)) return null
  if (!marker) return hour >= 0 && hour <= 23 ? hour : null
  if (hour < 1 || hour > 12) return null
  const normalized = marker.toLowerCase().replaceAll('.', '')
  if (normalized === 'am') return hour === 12 ? 0 : hour
  if (normalized === 'pm') return hour === 12 ? 12 : hour + 12
  return null
}

export function parseQuotaResetAt(
  message: string,
  timeZone: string,
  now: number = Date.now(),
): number | null {
  if (!QUOTA_LIMIT_RE.test(message)) return null
  const match = RESET_TIME_RE.exec(message)
  if (!match) return null

  const hour = parseHour(match[1], match[3])
  const minute = match[2] === undefined ? 0 : Number.parseInt(match[2], 10)
  if (hour === null || !Number.isFinite(minute) || minute < 0 || minute > 59) return null

  const today = wallParts(now, timeZone)
  const candidate = zonedWallToUtc(today.year, today.month, today.day, hour, minute, timeZone)
  if (candidate > now) return candidate

  const tomorrow = addLocalDays(today, 1)
  return zonedWallToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timeZone)
}
