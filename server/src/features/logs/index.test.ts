import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import {
  LOG_MAX_CHUNK_BYTES,
  LOG_TAIL_BYTES,
  incompleteUtf8TailLength,
  liveLogPath,
  planLogRead,
  readRuntimeLogChunk,
  readRuntimeLogHandler,
  sliceRuntimeLog,
} from './index.js'

let dir: string
let logFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-logread-'))
  logFile = join(dir, 'c3.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Collect what a handler sends on a stub connection. */
function stubConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = { send: (msg: ServerToClient) => sent.push(msg) } as unknown as Conn
  return { conn, sent }
}

describe('planLogRead', () => {
  it('reads the tail when no offset is given', () => {
    const size = LOG_TAIL_BYTES * 3
    expect(planLogRead(size, undefined)).toEqual({
      start: size - LOG_TAIL_BYTES,
      end: size,
      reset: true,
    })
  })

  it('reads the whole file when it is shorter than the tail window', () => {
    expect(planLogRead(120, undefined)).toEqual({ start: 0, end: 120, reset: true })
  })

  it('continues from a known offset without resetting', () => {
    expect(planLogRead(500, 200)).toEqual({ start: 200, end: 500, reset: false })
  })

  it('caps one reply and leaves the rest for the next poll', () => {
    const size = LOG_MAX_CHUNK_BYTES * 2
    expect(planLogRead(size, 0)).toEqual({ start: 0, end: LOG_MAX_CHUNK_BYTES, reset: false })
    expect(planLogRead(size, 0, 1000)).toEqual({ start: 0, end: 1000, reset: false })
    // A client-asked cap can only shrink the reply, never grow it past the hard cap.
    expect(planLogRead(size, 0, LOG_MAX_CHUNK_BYTES * 5).end).toBe(LOG_MAX_CHUNK_BYTES)
  })

  it('falls back to a reset tail read when the offset is past the end (rotation)', () => {
    expect(planLogRead(100, 9_000)).toEqual({ start: 0, end: 100, reset: true })
  })

  it('falls back to a reset tail read on a malformed offset', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planLogRead(100, bad).reset).toBe(true)
    }
  })

  it('reports no new bytes when the offset is exactly the end', () => {
    expect(planLogRead(100, 100)).toEqual({ start: 100, end: 100, reset: false })
  })
})

describe('sliceRuntimeLog', () => {
  it('drops the partial first line of a mid-file tail read', () => {
    const buf = Buffer.from('ncated line\nsecond\n')
    const size = 100 + buf.length
    const slice = sliceRuntimeLog(buf, 100, size, true)
    expect(slice.text).toBe('second\n')
    expect(slice.offset).toBe(100 + 'ncated line\n'.length)
    expect(slice.nextOffset).toBe(size)
  })

  it('keeps the whole slice when the read starts at the file head', () => {
    const buf = Buffer.from('first\nsecond\n')
    expect(sliceRuntimeLog(buf, 0, buf.length, true)).toEqual({
      text: 'first\nsecond\n',
      offset: 0,
      nextOffset: buf.length,
    })
  })

  it('ends a capped slice on a line boundary so the next one starts on one', () => {
    const buf = Buffer.from('one\ntwo\nthr')
    // The file has more bytes than this slice covers ⇒ the cut was forced.
    const slice = sliceRuntimeLog(buf, 0, 200, false)
    expect(slice.text).toBe('one\ntwo\n')
    expect(slice.nextOffset).toBe('one\ntwo\n'.length)
  })

  it('holds back an unfinished UTF-8 character at the end of the file', () => {
    const full = Buffer.from('日志\n', 'utf8')
    const partial = full.subarray(0, full.length - 2) // cuts the last char mid-sequence
    const slice = sliceRuntimeLog(partial, 0, partial.length, false)
    expect(slice.text).toBe('日')
    expect(slice.nextOffset).toBe(3)
  })
})

describe('incompleteUtf8TailLength', () => {
  it('counts nothing for a buffer ending on a character boundary', () => {
    expect(incompleteUtf8TailLength(Buffer.from('abc日志'))).toBe(0)
    expect(incompleteUtf8TailLength(Buffer.from(''))).toBe(0)
  })

  it('counts the trailing bytes of a half-written character', () => {
    const buf = Buffer.from('日', 'utf8') // 3 bytes
    expect(incompleteUtf8TailLength(buf.subarray(0, 1))).toBe(1)
    expect(incompleteUtf8TailLength(buf.subarray(0, 2))).toBe(2)
  })
})

describe('readRuntimeLogChunk', () => {
  it('reports unavailable when no live log file exists', async () => {
    const chunk = await readRuntimeLogChunk({}, logFile)
    expect(chunk).toEqual({
      offset: 0,
      nextOffset: 0,
      size: 0,
      text: '',
      reset: true,
      available: false,
    })
  })

  it('returns recent history on the first read, then only what grew', async () => {
    writeFileSync(logFile, 'line one\nline two\n')
    const first = await readRuntimeLogChunk({}, logFile)
    expect(first.available).toBe(true)
    expect(first.reset).toBe(true)
    expect(first.text).toBe('line one\nline two\n')

    // Nothing new yet.
    const idle = await readRuntimeLogChunk({ offset: first.nextOffset }, logFile)
    expect(idle.text).toBe('')
    expect(idle.nextOffset).toBe(first.nextOffset)
    expect(idle.reset).toBe(false)

    appendFileSync(logFile, 'line three\n')
    const next = await readRuntimeLogChunk({ offset: first.nextOffset }, logFile)
    expect(next.text).toBe('line three\n')
    expect(next.offset).toBe(first.nextOffset)
    expect(next.reset).toBe(false)
  })

  it('resets the stream when the file was rotated under the client', async () => {
    writeFileSync(logFile, 'old and long content\n')
    const first = await readRuntimeLogChunk({}, logFile)
    // Day rollover: c3.log is renamed away and a fresh, shorter one continues.
    writeFileSync(logFile, 'fresh\n')
    const after = await readRuntimeLogChunk({ offset: first.nextOffset }, logFile)
    expect(after.reset).toBe(true)
    expect(after.text).toBe('fresh\n')
    expect(after.offset).toBe(0)
  })

  it('reads only the tail of a file larger than the tail window', async () => {
    const filler = `${'x'.repeat(99)}\n`.repeat(Math.ceil(LOG_TAIL_BYTES / 100) + 10)
    writeFileSync(logFile, `${filler}tail marker\n`)
    const chunk = await readRuntimeLogChunk({}, logFile)
    expect(chunk.text.length).toBeLessThanOrEqual(LOG_TAIL_BYTES)
    expect(chunk.text.endsWith('tail marker\n')).toBe(true)
    // Cut on a line boundary — never a fragment of the first line kept.
    expect(chunk.text.startsWith('x'.repeat(99))).toBe(true)
    expect(chunk.nextOffset).toBe(chunk.size)
  })
})

describe('readRuntimeLogHandler', () => {
  it('answers with one runtime_log frame carrying the live log under the c3 home', async () => {
    const prev = process.env.C3_DIR
    process.env.C3_DIR = dir
    try {
      mkdirSync(join(dir, 'log'), { recursive: true })
      writeFileSync(join(dir, 'log', 'c3.log'), 'served line\n')
      expect(liveLogPath()).toBe(join(dir, 'log', 'c3.log'))

      const { conn, sent } = stubConn()
      await readRuntimeLogHandler({} as KernelContext, conn, { type: 'read_runtime_log' })
      expect(sent).toHaveLength(1)
      const frame = sent[0]
      expect(frame.type).toBe('runtime_log')
      if (frame.type !== 'runtime_log') throw new Error('unreachable')
      expect(frame.chunk.text).toBe('served line\n')
      expect(frame.chunk.available).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.C3_DIR
      else process.env.C3_DIR = prev
    }
  })
})
