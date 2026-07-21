/**
 * Automation hygiene rules shared by the server save boundary and the web
 * console (form + import/export): the execution wall-clock guard and the
 * free-form metadata sanitizer. Bounds and types stay in the wire contract.
 */
import {
  MAX_AUTOMATION_MAX_WALL_CLOCK_MS,
  MAX_AUTOMATION_METADATA_ENTRIES,
  MAX_AUTOMATION_METADATA_KEY_LEN,
  MAX_AUTOMATION_METADATA_VALUE_LEN,
  MIN_AUTOMATION_MAX_WALL_CLOCK_MS,
} from './protocol.js'

/** Whether a wire value is a valid explicit automation execution time limit. */
export function isValidAutomationMaxWallClockMs(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_AUTOMATION_MAX_WALL_CLOCK_MS &&
      value <= MAX_AUTOMATION_MAX_WALL_CLOCK_MS)
  )
}

/**
 * Sanitize free-form automation metadata to a clean `Record<string,string>`:
 * trims keys/values, drops empty-key / empty-value / non-string / over-long
 * entries, caps the total entry count. A non-object input yields `{}`. Used at
 * the server save boundary so no unexpected structure is persisted.
 */
export function normalizeAutomationMetadata(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_AUTOMATION_METADATA_ENTRIES) break
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key || key.length > MAX_AUTOMATION_METADATA_KEY_LEN) continue
    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value || value.length > MAX_AUTOMATION_METADATA_VALUE_LEN) continue
    out[key] = value
  }
  return out
}
