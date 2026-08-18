/**
 * `logs` feature handler — read-only access to the live runtime log.
 *
 * The console cannot reach the host filesystem, so this is the one door onto
 * `~/.c3/log/c3.log` (the live file the logger tees into — dated archives and
 * the daemon log stay out of reach). A poller sends the previous reply's
 * `nextOffset` back, so each round trip carries only what grew.
 *
 * Slices are cut on line boundaries wherever a cut is forced (a capped reply, a
 * tail read starting mid-file), and any incomplete UTF-8 sequence at the tail is
 * left for the next poll — a byte-range read must never hand the browser a
 * mangled character.
 *
 * Reading is best-effort in the same spirit as the logger itself: a missing or
 * unreadable file answers with an empty, `available: false` chunk rather than an
 * error frame, because "file logging is degraded to off" is a normal state.
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeLogChunk } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/index.js'
import { LIVE_LOG_NAME } from '../../kernel/infra/logger.js'
import type { Handler } from '../../transport/handler-registry.js'

/** Bytes of history a first (offset-less) read looks back over. */
export const LOG_TAIL_BYTES = 64 * 1024

/** Hard cap on one reply, whatever the client asks for. */
export const LOG_MAX_CHUNK_BYTES = 256 * 1024

/** Absolute path of the live runtime log. */
export function liveLogPath(): string {
  return join(c3HomeDir(), 'log', LIVE_LOG_NAME)
}

/**
 * Byte range to read for one request. An absent, malformed, or past-the-end
 * offset (the file was rotated or truncated under the client) falls back to a
 * tail read marked `reset` — the client replaces its buffer instead of appending
 * to a position that no longer means what it meant.
 */
export function planLogRead(
  size: number,
  offset: number | undefined,
  maxBytes?: number,
): { start: number; end: number; reset: boolean } {
  const cap = clampCap(maxBytes)
  const wanted = typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : null
  if (wanted === null || wanted < 0 || wanted > size) {
    const tail = Math.min(cap, LOG_TAIL_BYTES)
    return { start: Math.max(0, size - tail), end: size, reset: true }
  }
  return { start: wanted, end: Math.min(size, wanted + cap), reset: false }
}

function clampCap(maxBytes?: number): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return LOG_MAX_CHUNK_BYTES
  }
  return Math.min(Math.floor(maxBytes), LOG_MAX_CHUNK_BYTES)
}

/**
 * Number of trailing bytes that form an incomplete UTF-8 sequence (0 when the
 * buffer ends on a character boundary). Held back so the next poll re-reads
 * them with their continuation bytes rather than decoding a replacement char.
 */
export function incompleteUtf8TailLength(buf: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= buf.length; back++) {
    const byte = buf[buf.length - back]
    if (isContinuationByte(byte)) continue
    const needed = utf8SequenceLength(byte)
    return needed > back ? back : 0
  }
  return 0
}

/** Bytes at the head that are stray UTF-8 continuations (a cut mid-character). */
function leadingContinuationLength(buf: Uint8Array): number {
  let i = 0
  while (i < buf.length && i < 3 && isContinuationByte(buf[i])) i++
  return i
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000
}

/** Total length of the UTF-8 sequence a lead byte opens (1 for plain ASCII). */
function utf8SequenceLength(byte: number): number {
  if ((byte & 0b1000_0000) === 0) return 1
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4
  return 1
}

/**
 * Turn raw bytes read at `start` into the text slice that travels on the wire.
 *
 * - A `reset` slice that starts mid-file drops its leading partial line, so the
 *   first rendered line is a whole one.
 * - A slice that stops short of EOF (the cap bit) ends after the last newline it
 *   contains, so the next slice starts on a line boundary too.
 * - Whatever the cut, trailing bytes of an unfinished UTF-8 character stay put.
 *
 * `nextOffset` is the file position the returned text ends at — the offset to
 * send on the next poll.
 */
export function sliceRuntimeLog(
  bytes: Uint8Array,
  start: number,
  size: number,
  reset: boolean,
): { text: string; offset: number; nextOffset: number } {
  let from = 0
  if (reset && start > 0) {
    const nl = bytes.indexOf(0x0a)
    // No newline in the whole tail window ⇒ one very long line; keep it (minus
    // any half character at the cut) rather than returning nothing.
    from = nl === -1 ? leadingContinuationLength(bytes) : nl + 1
  }

  const cutShort = start + bytes.length < size
  let to = bytes.length
  if (cutShort) {
    const lastNl = bytes.lastIndexOf(0x0a)
    if (lastNl >= from) to = lastNl + 1
  }
  if (to === bytes.length) {
    to -= incompleteUtf8TailLength(bytes.subarray(from, to))
  }
  if (to < from) to = from

  return {
    text: Buffer.from(bytes.subarray(from, to)).toString('utf8'),
    offset: start + from,
    nextOffset: start + to,
  }
}

/** Read one slice of the live runtime log. `path` is injectable for tests. */
export async function readRuntimeLogChunk(
  req: { offset?: number; maxBytes?: number },
  path: string = liveLogPath(),
): Promise<RuntimeLogChunk> {
  const unavailable: RuntimeLogChunk = {
    offset: 0,
    nextOffset: 0,
    size: 0,
    text: '',
    reset: true,
    available: false,
  }
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return unavailable
    size = info.size
  } catch {
    return unavailable
  }

  const plan = planLogRead(size, req.offset, req.maxBytes)
  const length = plan.end - plan.start
  if (length <= 0) {
    return {
      offset: plan.start,
      nextOffset: plan.start,
      size,
      text: '',
      reset: plan.reset,
      available: true,
    }
  }

  let bytes: Uint8Array
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, plan.start)
    bytes = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  const slice = sliceRuntimeLog(bytes, plan.start, size, plan.reset)
  return { ...slice, size, reset: plan.reset, available: true }
}

/**
 * Serve one runtime-log slice. Reachable by any connection that cleared the
 * handshake — the dispatch gate is the whole authorization story here (no admin
 * role), matching every other read-only pull.
 */
export const readRuntimeLogHandler: Handler<'read_runtime_log'> = async (_ctx, conn, msg) => {
  const chunk = await readRuntimeLogChunk({ offset: msg.offset, maxBytes: msg.maxBytes })
  conn.send({ type: 'runtime_log', chunk })
}
