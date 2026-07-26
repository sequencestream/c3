/**
 * Automation hygiene rules shared by the server save boundary and the web
 * console (form + import/export): the execution wall-clock guard and the
 * free-form metadata sanitizer. Bounds and types stay in the wire contract.
 *
 * The same metadata bounds are reused by every other flat `string → string`
 * annotation map in c3 (e.g. the MCP `start_discussion` metadata) — either
 * through the lenient {@link normalizeAutomationMetadata} (drop-and-continue, for
 * a save boundary that must never fail) or through the strict
 * {@link validateFlatMetadata} (reject-the-whole-input, for a tool call that must
 * tell its caller the input was refused).
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

/** Why a flat metadata input was refused (the caller renders the message). */
export type FlatMetadataRejection =
  | { code: 'notObject' }
  | { code: 'tooManyEntries'; limit: number }
  | { code: 'keyTooLong'; key: string; limit: number }
  | { code: 'valueNotString'; key: string }
  | { code: 'valueTooLong'; key: string; limit: number }

/** Outcome of {@link validateFlatMetadata}: the clean map, or the refusal reason. */
export type FlatMetadataValidation =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: FlatMetadataRejection }

/**
 * Strictly validate a caller-supplied flat metadata map against the automation
 * metadata bounds. Unlike {@link normalizeAutomationMetadata} this REJECTS the
 * whole input rather than silently dropping offending entries: an over-capacity
 * map, an over-long key/value, or a nested / non-string value (which is what a
 * nested object looks like here) returns `{ ok: false }`. Only the two hygiene
 * rules that cannot lose caller intent are applied silently — keys and values are
 * trimmed, and an entry that trims to an empty key or value is dropped.
 *
 * Used by tool surfaces (MCP `start_discussion`) where a bad input must surface
 * as an error to the caller instead of being partially honoured.
 */
export function validateFlatMetadata(input: unknown): FlatMetadataValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: { code: 'notObject' } }
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_AUTOMATION_METADATA_ENTRIES) {
    return {
      ok: false,
      error: { code: 'tooManyEntries', limit: MAX_AUTOMATION_METADATA_ENTRIES },
    }
  }
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    if (key.length > MAX_AUTOMATION_METADATA_KEY_LEN) {
      return {
        ok: false,
        error: { code: 'keyTooLong', key, limit: MAX_AUTOMATION_METADATA_KEY_LEN },
      }
    }
    if (typeof rawValue !== 'string') {
      return { ok: false, error: { code: 'valueNotString', key } }
    }
    const value = rawValue.trim()
    if (value.length > MAX_AUTOMATION_METADATA_VALUE_LEN) {
      return {
        ok: false,
        error: { code: 'valueTooLong', key, limit: MAX_AUTOMATION_METADATA_VALUE_LEN },
      }
    }
    // Hygiene (never a rejection): a key/value that trims to empty carries no
    // context, so it does not enter the persisted result.
    if (!key || !value) continue
    out[key] = value
  }
  return { ok: true, value: out }
}
