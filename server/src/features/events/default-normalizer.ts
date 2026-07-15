/**
 * The DEFAULT generic-event normalizer — the fallback the kernel registry applies
 * to any event `type` that has no dedicated (typed) normalizer registered. It keeps
 * the open `<category>:<action>` contract: a model may publish a `custom:*` (or any
 * other unregistered) event and it is delivered rather than rejected.
 *
 * "Delivered safely" = the same field-level hygiene the typed normalizers guarantee,
 * applied STRUCTURALLY instead of per-known-field. Every free-text string — `status`,
 * `description`, every value in `metadata`, and every string nested (recursively) in
 * `data` — has secrets redacted, absolute paths stripped, and length capped. The
 * event `type` is preserved unchanged (the registry's type-change guard requires it).
 * No field is required and none is dropped for being unknown — the whole point of the
 * default path is to carry an arbitrary custom shape without a fixed schema.
 */
import type { GenericEvent, JsonObject, JsonValue } from '@ccc/shared/protocol'
import type { EventNormalizer } from '../../kernel/events/generic-event.js'
import { redactSecrets } from '../pr-events/tool-defs.js'

const REDACTED = '[redacted]'
/** Cap on any single free-text string; defuses pasted raw stdout/stderr blobs. */
const MAX_TEXT_LEN = 1000

/** Absolute-path patterns stripped from free text (POSIX home dirs + Windows). */
const ABS_PATH_PATTERNS: RegExp[] = [
  /(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/)\S+/g,
  /[A-Za-z]:\\[^\s]+/g,
]

/** Redact secrets, strip absolute paths, and cap length on one free-text value. */
function cleanText(s: string): string {
  let out = redactSecrets(s)
  for (const re of ABS_PATH_PATTERNS) out = out.replace(re, REDACTED)
  return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out
}

/** Recursively clean every string leaf of a JSON value; non-strings pass through. */
function cleanJson(v: JsonValue): JsonValue {
  if (typeof v === 'string') return cleanText(v)
  if (Array.isArray(v)) return v.map(cleanJson)
  if (v !== null && typeof v === 'object') {
    const out: JsonObject = {}
    for (const [k, val] of Object.entries(v)) out[k] = cleanJson(val)
    return out
  }
  return v
}

/**
 * Structural safety normalizer for custom event types. Preserves the shape the
 * producer supplied (type + whichever optional fields are present), cleaning every
 * free-text leaf. Wired as the registry default at the composition root so an
 * unregistered `type` publishes safely instead of being rejected.
 */
export const normalizeGenericEventDefault: EventNormalizer = (core) => {
  const event: GenericEvent = { type: core.type }
  if (core.status !== undefined) event.status = cleanText(core.status)
  if (core.description !== undefined) event.description = cleanText(core.description)
  if (core.metadata !== undefined) {
    const metadata: Record<string, string> = {}
    for (const [k, val] of Object.entries(core.metadata)) metadata[k] = cleanText(val)
    event.metadata = metadata
  }
  if (core.data !== undefined) event.data = cleanJson(core.data) as JsonObject
  return event
}
