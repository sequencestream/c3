/**
 * Reader for a Cursor chat's on-disk transcript.
 *
 * Each chat is a directory holding `meta.json` (the listing facts) and `store.db`
 * (the content). The database has two tables: `meta`, whose single row is a
 * hex-encoded JSON header naming the DAG's root, and `blobs`, a content-addressed
 * store keyed by the sha256 of each value.
 *
 * The root blob is the only binary node — a protobuf record whose repeated first
 * field lists its children in conversation order. Every child is plain JSON in
 * the shape the model layer uses: `{ role, content: [...] }`. So the only wire
 * decoding needed is "read field 1 of one record", and everything after that is
 * ordinary JSON.
 *
 * The format carries no compatibility promise, so every step here fails soft: an
 * unreadable database, a missing root, a node that does not parse and a field
 * layout that has moved all produce a shorter transcript rather than an error.
 * Resume is unaffected either way — it replays Cursor's own context, never this.
 *
 * @module
 */

import { openSqlite, type Db } from '../../../infra/db.js'

/** One message as the store holds it. */
export interface CursorStoredMessage {
  readonly role: string
  readonly content: unknown
}

/** The header the `meta` table carries. */
interface CursorStoreHeader {
  readonly latestRootBlobId?: unknown
  readonly name?: unknown
}

/**
 * How far the walk will go. The DAG is content-addressed, so a shared node can be
 * reached twice and a corrupt one could point at itself; both are bounded here
 * rather than trusted not to happen.
 */
const MAX_NODES = 4000

/** Read a protobuf varint, returning the value and the next offset. */
function readVarint(buf: Uint8Array, start: number): [value: number, next: number] | null {
  let value = 0
  let shift = 0
  let i = start
  while (i < buf.length) {
    const byte = buf[i]!
    i += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [value, i]
    shift += 7
    if (shift > 49) return null
  }
  return null
}

/**
 * The length-delimited values of protobuf field `field` in `buf`, in order.
 *
 * A general-purpose reader is not needed: only the child list is read, and every
 * other field is skipped by its wire type. Any malformed byte ends the scan and
 * keeps what was already collected.
 */
export function readRepeatedBytes(buf: Uint8Array, field: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let i = 0
  while (i < buf.length) {
    const tag = readVarint(buf, i)
    if (!tag) break
    const [key, afterTag] = tag
    const fieldNumber = key >> 3
    const wireType = key & 7
    if (fieldNumber === 0) break
    i = afterTag
    if (wireType === 0) {
      const varint = readVarint(buf, i)
      if (!varint) break
      i = varint[1]
    } else if (wireType === 2) {
      const len = readVarint(buf, i)
      if (!len) break
      const [size, afterLen] = len
      if (afterLen + size > buf.length) break
      if (fieldNumber === field) out.push(buf.subarray(afterLen, afterLen + size))
      i = afterLen + size
    } else if (wireType === 5) {
      i += 4
    } else if (wireType === 1) {
      i += 8
    } else {
      break
    }
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Decode the hex-encoded JSON header, or `null` when it is not one. */
function readHeader(db: Db): CursorStoreHeader | null {
  const row = db.get<{ value?: unknown }>("SELECT value FROM meta WHERE key='0'")
  if (!row || typeof row.value !== 'string') return null
  let text: string
  try {
    text = Buffer.from(row.value, 'hex').toString('utf-8')
  } catch {
    return null
  }
  const parsed = parseJson(text)
  return parsed && typeof parsed === 'object' ? (parsed as CursorStoreHeader) : null
}

/** A stored message, or `null` when the node is not one. */
function asMessage(value: unknown): CursorStoredMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.role !== 'string' || record.content === undefined) return null
  return { role: record.role, content: record.content }
}

/**
 * The chat's messages in conversation order.
 *
 * The database is opened read-only: Cursor may be writing this very file from the
 * IDE, and taking a write lock on another program's store to read it would be
 * both unnecessary and hostile.
 */
export function readCursorStoreMessages(dbPath: string): CursorStoredMessage[] {
  const db = openSqlite(dbPath, { readonly: true })
  if (!db) return []
  try {
    const header = readHeader(db)
    const rootId = typeof header?.latestRootBlobId === 'string' ? header.latestRootBlobId : null
    if (!rootId) return []

    const blobs = new Map<string, Uint8Array>()
    for (const row of db.all<{ id?: unknown; data?: unknown }>('SELECT id, data FROM blobs')) {
      if (typeof row.id === 'string' && row.data instanceof Uint8Array) blobs.set(row.id, row.data)
    }

    const root = blobs.get(rootId)
    if (!root) return []

    const out: CursorStoredMessage[] = []
    const seen = new Set<string>([rootId])
    for (const child of readRepeatedBytes(root, 1)) {
      if (out.length >= MAX_NODES) break
      // A child reference is the sha256 of the node it names, so only a 32-byte
      // value that actually resolves is one; anything else is a different field
      // that happens to share the number.
      if (child.length !== 32) continue
      const id = toHex(child)
      if (seen.has(id)) continue
      seen.add(id)
      const data = blobs.get(id)
      if (!data || data[0] !== 0x7b) continue
      const message = asMessage(parseJson(Buffer.from(data).toString('utf-8')))
      if (message) out.push(message)
    }
    return out
  } catch {
    // A locked or newer-schema database reads as an empty transcript, which is
    // what the console already renders for a session it cannot replay.
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}
