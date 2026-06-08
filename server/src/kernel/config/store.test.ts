import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, withFileLock, writeAtomic, SETTINGS_LOCK_STALE_MS } from './store.js'

let dir: string
let target: string
let lockDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-store-'))
  target = join(dir, 'settings.json')
  lockDir = `${target}.lock`
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('writeAtomic + readJsonFile', () => {
  it('round-trips JSON and creates parent dirs', () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    writeAtomic(nested, { hello: 'world', n: 1 })
    expect(readJsonFile<{ hello: string; n: number }>(nested)).toEqual({ hello: 'world', n: 1 })
  })

  it('readJsonFile returns undefined for a missing or unparseable file', () => {
    expect(readJsonFile(join(dir, 'nope.json'))).toBeUndefined()
    writeAtomic(target, '{not json')
    // writeAtomic JSON-encodes the string, so it parses back to the string itself.
    expect(readJsonFile(target)).toBe('{not json')
  })
})

describe('withFileLock — happy path', () => {
  it('runs fn, returns its value, and releases the lock dir', () => {
    expect(existsSync(lockDir)).toBe(false)
    const result = withFileLock(target, () => {
      // The lock is held while fn runs.
      expect(existsSync(lockDir)).toBe(true)
      writeAtomic(target, { ok: true })
      return 42
    })
    expect(result).toBe(42)
    // Released afterwards.
    expect(existsSync(lockDir)).toBe(false)
    expect(readJsonFile(target)).toEqual({ ok: true })
  })

  it('releases the lock even when fn throws', () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lockDir)).toBe(false)
  })
})

describe('withFileLock — stale lock reclaim', () => {
  it('reclaims a lock older than staleMs and runs fn', () => {
    // Simulate an abandoned lock from a crashed owner: dir present, meta ts old.
    mkdirSync(lockDir)
    writeAtomic(join(lockDir, 'meta.json'), {
      pid: 999999,
      ts: Date.now() - (SETTINGS_LOCK_STALE_MS + 10_000),
    })
    const ran = withFileLock(
      target,
      () => {
        writeAtomic(target, { reclaimed: true })
        return true
      },
      { timeoutMs: 1_000, retryMs: 5 },
    )
    expect(ran).toBe(true)
    expect(readJsonFile(target)).toEqual({ reclaimed: true })
    // The reclaimed-then-reacquired lock is released on exit.
    expect(existsSync(lockDir)).toBe(false)
  })
})

describe('withFileLock — acquire timeout never silently drops the write', () => {
  it('times out against a fresh foreign lock, warns, and STILL runs fn', () => {
    // A live foreign lock (fresh ts ⇒ not stale) we cannot acquire.
    mkdirSync(lockDir)
    writeAtomic(join(lockDir, 'meta.json'), { pid: 999999, ts: Date.now() })
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ran = withFileLock(
      target,
      () => {
        writeAtomic(target, { bestEffort: true })
        return 'wrote'
      },
      { timeoutMs: 60, retryMs: 10, staleMs: SETTINGS_LOCK_STALE_MS },
    )

    // Best-effort: the write happened despite the lock failure (no silent drop).
    expect(ran).toBe('wrote')
    expect(readJsonFile(target)).toEqual({ bestEffort: true })
    // It warned loudly about degrading to best-effort.
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('best-effort')
    // It did NOT remove the foreign process's lock on exit (only the holder releases).
    expect(existsSync(lockDir)).toBe(true)
  })
})
