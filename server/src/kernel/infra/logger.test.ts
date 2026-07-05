/**
 * Tests for the file-logging subsystem (`logger.ts`).
 *
 * Pure helpers (date keys, archive parse, expiry boundary) run against injected
 * `now` with no real clock; disk-touching helpers use a temp dir. The installed
 * tee is exercised via `C3_DIR` + a direct `process.stdout.write` (the surface
 * the tee wraps; `console.log` is intercepted asynchronously by vitest). Error
 * paths assert best-effort: no throw, a stderr warning, terminal output kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveFilename,
  archiveStaleLiveLog,
  cleanupOldArchives,
  initLogging,
  isExpiredArchive,
  localDateKey,
  parseArchiveDate,
  resetLoggingForTests,
  shutdownLogging,
  startupArchive,
  timestampPrefix,
} from './logger.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-logger-'))
  resetLoggingForTests()
})

afterEach(() => {
  resetLoggingForTests()
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Build a Date `daysAgo` local days before `from`. */
function daysBefore(from: Date, daysAgo: number): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  d.setDate(d.getDate() - daysAgo)
  return d
}

describe('pure helpers', () => {
  it('round-trips local date key ↔ archive filename', () => {
    const d = new Date(2026, 5, 21) // 2026-06-21 local
    expect(localDateKey(d)).toBe('2026-06-21')
    expect(archiveFilename('2026-06-21')).toBe('c3-2026-06-21.log')
  })

  it('parses valid archive names and rejects malformed / impossible ones', () => {
    expect(parseArchiveDate('c3-2026-06-21.log')).toEqual(new Date(2026, 5, 21))
    expect(parseArchiveDate('c3.log')).toBeNull()
    expect(parseArchiveDate('c3-2026-6-1.log')).toBeNull() // unpadded
    expect(parseArchiveDate('c3-2026-13-40.log')).toBeNull() // overflow
    expect(parseArchiveDate('other.log')).toBeNull()
  })
})

describe('isExpiredArchive — retention boundary', () => {
  const now = new Date(2026, 5, 21)

  it('keeps 29- and 30-day-old archives, deletes 31-day-old (boundary inclusive at 30)', () => {
    const at = (n: number): string => archiveFilename(localDateKey(daysBefore(now, n)))
    expect(isExpiredArchive(at(29), now, 30)).toBe(false)
    expect(isExpiredArchive(at(30), now, 30)).toBe(false) // exactly 30 days → kept
    expect(isExpiredArchive(at(31), now, 30)).toBe(true)
  })

  it('never expires the live log or non-archive files', () => {
    expect(isExpiredArchive('c3.log', now, 30)).toBe(false)
    expect(isExpiredArchive('notes.txt', now, 30)).toBe(false)
  })
})

describe('cleanupOldArchives', () => {
  it('deletes only expired archives, sparing live log and unrelated files', () => {
    const now = new Date(2026, 5, 21)
    const at = (n: number): string => archiveFilename(localDateKey(daysBefore(now, n)))
    writeFileSync(join(dir, at(29)), 'keep29')
    writeFileSync(join(dir, at(30)), 'keep30')
    writeFileSync(join(dir, at(31)), 'drop31')
    writeFileSync(join(dir, 'c3.log'), 'live')
    writeFileSync(join(dir, 'README.txt'), 'unrelated')
    writeFileSync(join(dir, 'c3-2026-13-40.log'), 'invalid-name')

    cleanupOldArchives(dir, now, 30)

    expect(existsSync(join(dir, at(29)))).toBe(true)
    expect(existsSync(join(dir, at(30)))).toBe(true)
    expect(existsSync(join(dir, at(31)))).toBe(false)
    expect(existsSync(join(dir, 'c3.log'))).toBe(true)
    expect(existsSync(join(dir, 'README.txt'))).toBe(true)
    expect(existsSync(join(dir, 'c3-2026-13-40.log'))).toBe(true)
  })

  it('does not throw on a missing directory', () => {
    expect(() => cleanupOldArchives(join(dir, 'nope'), new Date(2026, 5, 21), 30)).not.toThrow()
  })
})

describe('archiveStaleLiveLog — cross-day rollover', () => {
  it('renames the live log to the ended day and leaves room for a fresh one', () => {
    const now = new Date(2026, 5, 21)
    const yesterdayKey = localDateKey(daysBefore(now, 1))
    writeFileSync(join(dir, 'c3.log'), 'yesterday content')

    const newKey = archiveStaleLiveLog(dir, now, yesterdayKey)

    expect(newKey).toBe('2026-06-21')
    expect(existsSync(join(dir, 'c3.log'))).toBe(false)
    expect(readFileSync(join(dir, archiveFilename(yesterdayKey)), 'utf8')).toBe('yesterday content')

    // A fresh live log starts empty and is writable.
    writeFileSync(join(dir, 'c3.log'), '')
    expect(readFileSync(join(dir, 'c3.log'), 'utf8')).toBe('')
  })

  it('is a no-op within the same day', () => {
    const now = new Date(2026, 5, 21)
    writeFileSync(join(dir, 'c3.log'), 'today')
    const key = archiveStaleLiveLog(dir, now, '2026-06-21')
    expect(key).toBe('2026-06-21')
    expect(existsSync(join(dir, 'c3.log'))).toBe(true)
    expect(existsSync(join(dir, archiveFilename('2026-06-21')))).toBe(false)
  })
})

describe('startupArchive — catch-up after midnight downtime', () => {
  it('archives a leftover c3.log whose mtime is a previous day', () => {
    const now = new Date(2026, 5, 21)
    const yesterday = daysBefore(now, 1)
    const live = join(dir, 'c3.log')
    writeFileSync(live, 'left over from yesterday')
    utimesSync(live, yesterday, yesterday)

    const key = startupArchive(dir, now)

    expect(key).toBe('2026-06-21')
    expect(existsSync(live)).toBe(false)
    expect(readFileSync(join(dir, archiveFilename(localDateKey(yesterday))), 'utf8')).toBe(
      'left over from yesterday',
    )
  })

  it('leaves a same-day c3.log untouched', () => {
    const now = new Date(2026, 5, 21)
    const live = join(dir, 'c3.log')
    writeFileSync(live, 'today content')
    utimesSync(live, now, now)
    const key = startupArchive(dir, now)
    expect(key).toBe('2026-06-21')
    expect(existsSync(live)).toBe(true)
  })
})

describe('initLogging — installed tee', () => {
  it('persists stdout output to ~/.c3/log/c3.log while keeping terminal output', () => {
    process.env.C3_DIR = dir
    const captured: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    // Capture terminal passthrough without printing during the test run. The tee
    // wraps `process.stdout.write` — exactly the surface `console.log` calls in
    // production — so writing to it directly faithfully exercises the tee
    // (and sidesteps vitest's async global-console interception).
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      initLogging()
      process.stdout.write('[c3] marker-line-12345\n')
    } finally {
      shutdownLogging()
      process.stdout.write = realWrite
    }

    const logged = readFileSync(join(dir, 'log', 'c3.log'), 'utf8')
    expect(logged).toContain('[c3] marker-line-12345')
    expect(captured.join('')).toContain('[c3] marker-line-12345') // terminal passthrough intact
  })
})

describe('timestamp line prefix', () => {
  const PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /
  const PREFIX_G = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /g

  it('formats a host-local second-precision prefix', () => {
    // 2026-06-21 09:07:05 local → note zero-padded time and trailing space.
    expect(timestampPrefix(new Date(2026, 5, 21, 9, 7, 5))).toBe('2026-06-21 09:07:05 ')
  })

  /**
   * Run `writes` through the installed tee (via direct `process.stdout.write`, the
   * surface the tee wraps) and return the captured terminal text and the on-disk
   * `c3.log` text.
   */
  function teeWrites(writes: (w: (s: string) => void) => void): {
    captured: string
    logged: string
  } {
    process.env.C3_DIR = dir
    const captured: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      initLogging()
      writes((s) => process.stdout.write(s))
    } finally {
      shutdownLogging()
      process.stdout.write = realWrite
    }
    return { captured: captured.join(''), logged: readFileSync(join(dir, 'log', 'c3.log'), 'utf8') }
  }

  it('prefixes a single-line write in both terminal and file', () => {
    const { captured, logged } = teeWrites((w) => w('hello-single\n'))
    expect(logged).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hello-single\n$/)
    expect(captured).toBe(logged) // terminal and file byte-identical
  })

  it('prefixes every line of a single multi-line write', () => {
    const { logged } = teeWrites((w) => w('line-A\nline-B\nline-C\n'))
    const lines = logged.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const l of lines) {
      expect(l).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} line-[ABC]$/)
    }
  })

  it('prefixes a line split across writes exactly once, resuming after the newline', () => {
    const { logged } = teeWrites((w) => {
      w('half-') // no newline — stays mid-line
      w('line-joined\n') // completes the same line, then ends it
      w('next-line\n') // a fresh line → a fresh prefix
    })
    expect(logged.match(PREFIX_G) ?? []).toHaveLength(2)
    expect(logged).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} half-line-joined\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} next-line\n$/,
    )
  })

  it('keeps terminal and file identical across a mixed write sequence', () => {
    const { captured, logged } = teeWrites((w) => {
      w('a\nb') // trailing half-line
      w('c\n') // completes it
      w('') // empty write — no extra line, no extra prefix
      w('d\n')
    })
    expect(captured).toBe(logged)
    // Lines emitted: "a", "bc" (the half-line completed), "d" → three prefixes;
    // the empty write adds none.
    const lines = logged.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(logged.match(PREFIX_G) ?? []).toHaveLength(3)
    expect(lines.every((l) => PREFIX.test(l))).toBe(true)
  })
})

describe('error paths — best-effort, no crash', () => {
  it('disables file logging without throwing when the log dir cannot be created', () => {
    process.env.C3_DIR = dir
    // Occupy the would-be log dir path with a FILE so mkdir fails.
    writeFileSync(join(dir, 'log'), 'i am a file, not a dir')

    const warnings: string[] = []
    const realErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
    try {
      expect(() => initLogging()).not.toThrow()
      // Console still works after a failed init (terminal-only fallback).
      expect(() => console.log('still-alive')).not.toThrow()
    } finally {
      process.stderr.write = realErr
    }

    expect(warnings.join('')).toContain('[c3][logger]')
  })
})
