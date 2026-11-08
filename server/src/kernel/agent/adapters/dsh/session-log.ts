/**
 * Replay a DSH session log into canonical messages.
 *
 * The persistence backend stores one append-only log per session. The default
 * file is a concatenation of independent Zstandard frames; `compression: none`
 * is the same JSONL without frames. The current generation is one JSON object
 * per event, and the header line's `version` is 4. Older packed generations are
 * not migrated here: a log whose header is not the current version yields no
 * transcript rather than a mis-read one.
 *
 * The human transcript is the append-origin surface, not the model-visible one.
 * A replacement shadows history the model should forget and would erase or
 * duplicate conversation the user already saw, so those rows are skipped.
 * Injected user rows (instructions, skill catalog, clocks) are skipped too —
 * the chat only showed the prompt the person sent.
 */
import { Buffer } from 'node:buffer'
import { zstdDecompressSync } from 'node:zlib'
import type { CanonicalBlock, CanonicalMessage } from '../types.js'

/** Physical format this reader knows how to project. */
const CURRENT_LOG_VERSION = 4

const ZSTD_MAGIC = 0xfd2fb528

/** `session.jsonl[.zstd]` is generation 0; `session.vN.jsonl[.zstd]` is generation N. */
const GENERATION_FILE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/

export interface DshGenerationFile {
  readonly name: string
  readonly version: number
  readonly compressed: boolean
}

/**
 * Highest canonical generation in one session directory.
 * A version-zero file tagged `v0`, or a name with a leading zero, is not a generation.
 */
export function selectDshGeneration(names: readonly string[]): DshGenerationFile | null {
  let best: DshGenerationFile | null = null
  for (const name of names) {
    const parsed = parseGeneration(name)
    if (!parsed) continue
    if (
      !best ||
      parsed.version > best.version ||
      (parsed.version === best.version && parsed.compressed && !best.compressed)
    ) {
      best = parsed
    }
  }
  return best
}

function parseGeneration(name: string): DshGenerationFile | null {
  const match = GENERATION_FILE.exec(name)
  if (!match) return null
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version)) return null
  return { name, version, compressed: match[2] === '.zstd' }
}

/**
 * Plaintext JSONL for one log file.
 *
 * The file is a concatenation of independent frames: the header, then one frame
 * per append. Decode each frame on its own. A single decompress of the whole
 * buffer keeps only the header on Bun, which is what the compiled binary runs,
 * and drops the conversation. A torn final frame is not a frame and is dropped.
 */
export function decodeDshSessionLog(
  buffer: Buffer,
  compressed: boolean,
  decompress: (frame: Buffer) => Buffer = zstdDecompressSync,
): string {
  if (!compressed) return buffer.toString('utf8')
  const frames = completeZstdFrames(buffer)
  if (frames.length === 0) throw new Error('unreadable zstd session log: no complete frame')
  try {
    return Buffer.concat(frames.map((frame) => decompress(frame))).toString('utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`unreadable zstd session log: ${message}`, { cause: err })
  }
}

/** Project one current-format log. An older header yields an empty transcript. */
export function replayDshSessionLog(text: string, sessionId: string): CanonicalMessage[] {
  const lines = completeLines(text)
  const header = lines.length > 0 ? parseJson(lines[0]) : null
  if (!isRecord(header) || header.type !== 'session' || header.version !== CURRENT_LOG_VERSION) {
    return []
  }

  const out: CanonicalMessage[] = []
  const pending = new Map<string, PendingCall>()
  let anonymous = 0

  const flushPending = (): void => {
    for (const call of pending.values()) out.push(toolMessage(sessionId, call))
    pending.clear()
  }

  for (const line of lines.slice(1)) {
    const event = parseJson(line)
    if (!isRecord(event) || typeof event.type !== 'string') continue
    if (isReplacement(event)) continue
    const ts = finiteMs(event.time) ?? 0

    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
        flushPending()
        break
      case 'user/message': {
        const message = userPayload(event)
        if (!message || !isHumanPrompt(message)) break
        const blocks = textBlocks(message.content, eventSeq(event))
        if (blocks.length > 0) out.push(envelope(sessionId, 'user', ts, blocks))
        break
      }
      case 'assistant/message': {
        const blocks = textBlocks(assistantContent(event), eventSeq(event))
        if (blocks.length > 0) out.push(envelope(sessionId, 'assistant', ts, blocks))
        break
      }
      case 'tool/call': {
        const data = recordOf(event.data)
        const callId = data ? stringOf(data.callId) : null
        if (!data || !callId) break
        const displaced = pending.get(callId)
        if (displaced) out.push(toolMessage(sessionId, displaced))
        pending.set(callId, {
          id: blockId(event, anonymous),
          name: stringOf(data.name) ?? 'unknown',
          input: parseArguments(data.arguments),
          ts,
        })
        anonymous += 1
        break
      }
      case 'tool/result': {
        const data = recordOf(event.data)
        const message = data ? recordOf(data.message) : null
        const callId = (message && stringOf(message.toolCallId)) ?? (data && stringOf(data.callId))
        const prior = callId ? pending.get(callId) : undefined
        if (callId && prior) pending.delete(callId)
        const call: PendingCall = prior ?? {
          id: blockId(event, anonymous),
          name: 'unknown',
          input: {},
          ts,
        }
        if (!prior) anonymous += 1
        out.push(toolMessage(sessionId, call, toolResultOf(message)))
        break
      }
      default:
        break
    }
  }

  flushPending()
  return out
}

interface PendingCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly ts: number
}

function envelope(
  sessionId: string,
  role: 'user' | 'assistant',
  ts: number,
  blocks: CanonicalBlock[],
): CanonicalMessage {
  return { vendor: 'dsh', sessionId, role, ts, blocks }
}

function toolMessage(
  sessionId: string,
  call: PendingCall,
  result?: { content: string; isError: boolean },
): CanonicalMessage {
  return envelope(sessionId, 'assistant', call.ts, [
    {
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
      ...(result ? { result } : {}),
    },
  ])
}

/** Newline-terminated records only. A torn tail has no closing newline and is dropped. */
function completeLines(text: string): string[] {
  const lines = text.split('\n')
  if (!text.endsWith('\n')) lines.pop()
  return lines.filter((line) => line.length > 0)
}

function isReplacement(event: Record<string, unknown>): boolean {
  const op = event.surfaceOp
  return isRecord(op) && op.op === 'replace'
}

function userPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  const data = recordOf(event.data)
  if (!data) return null
  if (data.role === 'user') return data
  return recordOf(data.message)
}

function isHumanPrompt(message: Record<string, unknown>): boolean {
  const source = recordOf(message.source)
  return source?.kind === 'user'
}

function assistantContent(event: Record<string, unknown>): unknown {
  const data = recordOf(event.data)
  if (!data) return undefined
  const message = recordOf(data.message)
  return message ? message.content : data.content
}

function textBlocks(content: unknown, seq: number | null): CanonicalBlock[] {
  if (!Array.isArray(content)) return []
  const blocks: CanonicalBlock[] = []
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue
    if (!part.text.trim()) continue
    blocks.push({
      type: 'text',
      text: part.text,
      id: `dsh-${seq ?? 'x'}-${blocks.length}`,
    })
  }
  return blocks
}

function toolResultOf(message: Record<string, unknown> | null): {
  content: string
  isError: boolean
} {
  if (!message) return { content: '', isError: false }
  const isError = message.isError === true
  const content = message.content
  if (typeof content === 'string') return { content, isError }
  if (!Array.isArray(content)) return { content: '', isError }
  const text = content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .filter((part) => part.length > 0)
    .join('\n')
  return { content: text, isError }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { raw: value }
  }
}

function blockId(event: Record<string, unknown>, anonymous: number): string {
  const seq = eventSeq(event)
  return seq === null ? `dsh-anon-${anonymous}` : `dsh-${seq}`
}

function eventSeq(event: Record<string, unknown>): number | null {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

/**
 * Complete frames in a concatenated Zstandard stream.
 * EOF inside the final frame stops the scan; that prefix is not a frame.
 * A bad magic or reserved header stops the scan and keeps frames already accepted.
 */
function completeZstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    const end = frameEnd(buffer, offset)
    if (end === null) break
    frames.push(buffer.subarray(start, end))
    offset = end
  }
  return frames
}

/** Exclusive end of the frame at `offset`, or null when the frame is torn or not a frame. */
function frameEnd(buffer: Buffer, offset: number): number | null {
  if (buffer.length - offset < 4) return null
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return null
  let cursor = offset + 4
  if (cursor >= buffer.length) return null
  const descriptor = buffer.readUInt8(cursor)
  cursor += 1
  // Bits 3 and 4 are reserved. A set bit is not a frame this reader can walk.
  if ((descriptor & 0x18) !== 0) return null
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - cursor < headerBytes) return null
  cursor += headerBytes
  for (;;) {
    if (buffer.length - cursor < 3) return null
    const blockHeader = buffer.readUIntLE(cursor, 3)
    cursor += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) return null
    // Raw and compressed blocks store `blockSize` bytes. An RLE block stores one byte.
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - cursor < payloadBytes) return null
    cursor += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - cursor < 4) return null
    cursor += 4
  }
  return cursor
}
