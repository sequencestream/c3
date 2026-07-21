/**
 * Structural validation of an untrusted generic-event core (kernel).
 *
 * The publish layer calls this BEFORE handing a core to its normalizer and again
 * on the normalizer's result, so nothing structurally invalid can reach the bus.
 * The event shape itself is wire contract (`@ccc/shared/protocol`); the executable
 * check lives server-side because only the publish path applies it.
 */
import type { GenericEvent, JsonObject } from '@ccc/shared'

/** Result of validating an untrusted generic-event core against the contract. */
export type GenericEventValidation =
  { ok: true; value: GenericEvent } | { ok: false; reason: string }

/**
 * True if `v` is a finite JSON value: string, boolean, finite number, `null`,
 * array of JSON values, or plain object of JSON values. Rejects functions,
 * `undefined`, symbols, bigints, non-finite numbers, class instances and cycles.
 */
export function isJsonValue(v: unknown, seen: Set<object> = new Set()): boolean {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v as number)
  if (t !== 'object') return false // function, symbol, bigint, undefined
  const obj = v as object
  if (seen.has(obj)) return false // cycle
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      for (const item of obj) if (!isJsonValue(item, seen)) return false
      return true
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return false // class instance
    for (const key of Object.keys(obj)) {
      if (!isJsonValue((obj as Record<string, unknown>)[key], seen)) return false
    }
    return true
  } finally {
    seen.delete(obj)
  }
}

/**
 * Validate an untrusted generic-event core: non-empty string `type`, string
 * `status`/`description`, a FLAT `string → string` `metadata`, and a
 * JSON-compatible `data` object. On success returns a copy with only the known
 * fields (extra keys dropped); on failure returns a machine-friendly `reason`
 * that never echoes the offending value.
 */
export function validateGenericEvent(value: unknown): GenericEventValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'event must be an object' }
  }
  const e = value as Record<string, unknown>
  if (typeof e.type !== 'string' || e.type.trim() === '') {
    return { ok: false, reason: 'event.type must be a non-empty string' }
  }
  if (e.status !== undefined && typeof e.status !== 'string') {
    return { ok: false, reason: 'event.status must be a string' }
  }
  if (e.description !== undefined && typeof e.description !== 'string') {
    return { ok: false, reason: 'event.description must be a string' }
  }
  if (e.metadata !== undefined) {
    if (typeof e.metadata !== 'object' || e.metadata === null || Array.isArray(e.metadata)) {
      return { ok: false, reason: 'event.metadata must be a flat object' }
    }
    for (const [k, val] of Object.entries(e.metadata)) {
      if (typeof val !== 'string') {
        return { ok: false, reason: `event.metadata.${k} must be a string` }
      }
    }
  }
  if (e.data !== undefined) {
    if (typeof e.data !== 'object' || e.data === null || Array.isArray(e.data)) {
      return { ok: false, reason: 'event.data must be an object' }
    }
    if (!isJsonValue(e.data)) {
      return { ok: false, reason: 'event.data must be JSON-compatible' }
    }
  }
  const clean: GenericEvent = { type: e.type }
  if (e.status !== undefined) clean.status = e.status as string
  if (e.description !== undefined) clean.description = e.description as string
  if (e.metadata !== undefined) clean.metadata = { ...(e.metadata as Record<string, string>) }
  if (e.data !== undefined) clean.data = e.data as JsonObject
  return { ok: true, value: clean }
}
