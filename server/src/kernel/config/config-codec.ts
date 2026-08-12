/**
 * Object ⇄ config-row codec. Turns a settings object into the fine-grained rows the
 * config tables store (`config_key` / `config_value` / `config_type`) and back.
 *
 * The point of the fine grain: one field = one row. A workspace toggle writes ONE
 * row instead of rewriting the whole settings document, so two concurrent writers
 * touching different fields can no longer clobber each other — the anti-clobber
 * merge the JSON file needed disappears with the read-modify-write it protected.
 *
 * Expansion rules (declared per settings shape by the caller, see `config-schema.ts`):
 *  - scalar            → one row, typed `string` / `number` / `boolean`
 *  - plain object      → recursed into dotted keys (`proxy.enabled`)
 *  - record array      → one segment per record id (`agents.<id>.vendor`), plus a
 *                        `<path>._order` row that preserves the array's order
 *  - anything else     → a single `json` row (scalar arrays, maps whose keys may
 *                        contain dots, and any subtree explicitly pinned as JSON)
 *  - secret            → a `secret` row: ciphertext on disk, plaintext in memory
 *
 * `undefined` is absence — those fields produce no row at all, which is what keeps
 * an unset optional field distinguishable from one explicitly set to null.
 */
import { decryptSecret, encryptSecret } from './encryption.js'

/** How a stored `config_value` is to be read back. */
export type ConfigType = 'string' | 'number' | 'boolean' | 'json' | 'secret'

/** One persisted config row, independent of which table it lives in. */
export interface ConfigEntry {
  key: string
  /** Encoded form; `null` is the encoded form of a null value. */
  value: string | null
  type: ConfigType
}

/**
 * Which paths get special treatment. Patterns are dotted paths where `*` matches
 * exactly one segment (`agents.*.config.apiKey`).
 */
export interface ConfigRules {
  /** Paths whose value is a secret — stored encrypted, returned decrypted. */
  secrets?: readonly string[]
  /** Paths whose subtree is stored whole as one `json` row instead of expanded. */
  json?: readonly string[]
  /**
   * Array paths expanded per record, mapped to the field holding each record's id
   * (`{ agents: 'id' }`). An element without a usable id falls back to its index.
   */
  recordArrays?: Readonly<Record<string, string>>
}

/** The row that remembers a record array's element order. */
const ORDER_SUFFIX = '_order'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/**
 * `.` separates key segments, so a segment that legitimately contains one — a
 * username like `a.b@example.com`, a skill-repo id, a vendor map key — is
 * percent-escaped on the way in and unescaped on the way out. Field names never
 * contain a dot, so ordinary keys are unaffected and stay readable.
 */
function encodeSegment(segment: string): string {
  return segment.replace(/%/g, '%25').replace(/\./g, '%2E')
}

function decodeSegment(segment: string): string {
  // One pass, so an escaped escape (`%252E` ⇒ the literal `%2E`) is not decoded twice.
  return segment.replace(/%(25|2E)/g, (_, code: string) => (code === '2E' ? '.' : '%'))
}

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('.')
  const s = path.split('.')
  if (p.length !== s.length) return false
  return p.every((seg, i) => seg === '*' || seg === s[i])
}

function anyMatch(patterns: readonly string[] | undefined, path: string): boolean {
  return !!patterns?.some((p) => matches(p, path))
}

/**
 * The record-array id field for `path`, or undefined when this path is not a
 * record array. Patterns may use `*` so nested arrays can be declared once.
 */
function recordIdField(rules: ConfigRules, path: string): string | undefined {
  const arrays = rules.recordArrays
  if (!arrays) return undefined
  for (const [pattern, idField] of Object.entries(arrays)) {
    if (matches(pattern, path)) return idField
  }
  return undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Encode one leaf value into its row form. Secrets are encrypted here, nowhere else. */
function encodeLeaf(path: string, value: unknown, rules: ConfigRules): ConfigEntry {
  if (anyMatch(rules.secrets, path)) {
    // A non-string secret is a caller bug, not data — store it as JSON rather than
    // silently encrypting `[object Object]`.
    if (typeof value === 'string') return { key: path, value: encryptSecret(value), type: 'secret' }
  }
  if (value === null) return { key: path, value: null, type: 'json' }
  switch (typeof value) {
    case 'string':
      return { key: path, value, type: 'string' }
    case 'number':
      return { key: path, value: String(value), type: 'number' }
    case 'boolean':
      return { key: path, value: value ? 'true' : 'false', type: 'boolean' }
    default:
      return { key: path, value: JSON.stringify(value ?? null), type: 'json' }
  }
}

/** Decode one row back into its in-memory value. Secrets are decrypted here. */
export function decodeEntry(entry: ConfigEntry): unknown {
  switch (entry.type) {
    case 'string':
      return entry.value ?? ''
    case 'number': {
      const n = Number(entry.value)
      return Number.isFinite(n) ? n : undefined
    }
    case 'boolean':
      return entry.value === 'true' || entry.value === '1'
    case 'secret':
      // A corrupt/foreign ciphertext must not take the whole settings load down;
      // the field reads as absent and the next save rewrites it.
      try {
        return entry.value ? decryptSecret(entry.value) : ''
      } catch {
        return undefined
      }
    case 'json':
      if (entry.value === null) return null
      try {
        return JSON.parse(entry.value) as Json
      } catch {
        return undefined
      }
  }
}

/**
 * Flatten `value` into rows. `undefined` fields (and `undefined` array elements)
 * produce nothing — absence is not a value.
 */
export function toEntries(value: unknown, rules: ConfigRules = {}, prefix = ''): ConfigEntry[] {
  const out: ConfigEntry[] = []
  walk(value, prefix, rules, out)
  return out
}

function walk(value: unknown, path: string, rules: ConfigRules, out: ConfigEntry[]): void {
  if (value === undefined) return
  if (path !== '' && anyMatch(rules.json, path)) {
    out.push({ key: path, value: JSON.stringify(value ?? null), type: 'json' })
    return
  }
  if (Array.isArray(value)) {
    const idField = recordIdField(rules, path)
    if (!idField) {
      out.push({ key: path, value: JSON.stringify(value), type: 'json' })
      return
    }
    const ids: string[] = []
    value.forEach((item, index) => {
      if (item === undefined) return
      const rawId = isPlainObject(item) ? item[idField] : undefined
      const id = typeof rawId === 'string' && rawId !== '' ? rawId : String(index)
      ids.push(id)
      walk(item, join(path, encodeSegment(id)), rules, out)
    })
    // Order is data: a record array reassembled from rows would otherwise come back
    // in whatever order the table scan produced.
    out.push({ key: join(path, ORDER_SUFFIX), value: JSON.stringify(ids), type: 'json' })
    return
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    // An empty object is a real value (an agent with no per-vendor config), so it
    // needs a row of its own — recursion alone would emit nothing.
    if (keys.length === 0) {
      if (path !== '') out.push({ key: path, value: '{}', type: 'json' })
      return
    }
    for (const k of keys) walk(value[k], join(path, encodeSegment(k)), rules, out)
    return
  }
  if (path === '') return
  out.push(encodeLeaf(path, value, rules))
}

function join(prefix: string, segment: string): string {
  return prefix === '' ? segment : `${prefix}.${segment}`
}

/**
 * Rebuild the object graph from rows. Unknown/undecodable rows are skipped rather
 * than throwing: a settings load must survive one bad field.
 */
export function fromEntries(
  entries: readonly ConfigEntry[],
  rules: ConfigRules = {},
): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  // Record-array order rows are consumed as metadata, not as fields.
  const orders = new Map<string, string[]>()
  for (const entry of entries) {
    const segments = entry.key.split('.').map(decodeSegment)
    if (segments[segments.length - 1] === ORDER_SUFFIX) {
      const arrayPath = segments.slice(0, -1).join('.')
      if (recordIdField(rules, arrayPath)) {
        const decoded = decodeEntry(entry)
        if (Array.isArray(decoded)) orders.set(arrayPath, decoded.map(String))
        continue
      }
    }
    const decoded = decodeEntry(entry)
    if (decoded === undefined) continue
    assign(root, segments, decoded)
  }
  return materializeArrays(root, '', rules, orders) as Record<string, unknown>
}

function assign(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = node[seg]
    if (!isPlainObject(next)) {
      // A scalar already sitting where a branch belongs means two rows disagree
      // about the shape; the deeper row wins, since it carries more structure.
      node[seg] = {}
    }
    node = node[seg] as Record<string, unknown>
  }
  node[segments[segments.length - 1]] = value
}

/**
 * Turn the id-keyed maps produced by record-array rows back into arrays, ordered by
 * the stored `_order` list (ids it doesn't mention are appended in insertion order,
 * so a row written by a newer client is never dropped).
 */
function materializeArrays(
  node: unknown,
  path: string,
  rules: ConfigRules,
  orders: Map<string, string[]>,
): unknown {
  if (!isPlainObject(node)) return node
  const idField = path !== '' ? recordIdField(rules, path) : undefined
  const converted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    converted[k] = materializeArrays(v, join(path, k), rules, orders)
  }
  if (!idField) return converted
  const order = orders.get(path) ?? []
  const ids = [
    ...order.filter((id) => id in converted),
    ...Object.keys(converted).filter((id) => !order.includes(id)),
  ]
  return ids.map((id) => converted[id])
}
