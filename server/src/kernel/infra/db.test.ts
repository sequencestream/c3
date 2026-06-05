/**
 * Integration tests for the shared cross-runtime SQLite adapter (`db.ts`).
 *
 * Under Node these exercise the `node:sqlite` (`DatabaseSync`) branch — the path
 * a `node cli.cjs` deployment takes. The `bun:sqlite` branch is structurally
 * identical and only reachable under a Bun binary (out of scope for vitest/Node).
 * Covered here: `?` positional-param round-trips against a real temp file, the
 * WAL + busy_timeout pragmas not throwing, the `:memory:` sentinel passthrough
 * (reviewer's fix), and the open-failure degradation contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDbDriver, getDb, isDbAvailable, resetDbForTests } from './db.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-dbadapter-'))
  resetDbForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('db adapter — file-backed (node:sqlite)', () => {
  it('opens a temp file, runs WAL/busy_timeout pragmas, and reports available', () => {
    // §2.1: getDb() sets `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;` on
    // open — those must not throw, and the db must report available.
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    const db = getDb()
    expect(db).not.toBeNull()
    expect(isDbAvailable()).toBe(true)
    // journal_mode actually flipped to WAL on a real file.
    const row = db!.get<{ journal_mode: string }>('PRAGMA journal_mode')
    expect(String(row?.journal_mode).toLowerCase()).toBe('wal')
  })

  it('round-trips rows through `?` positional params (run / get / all)', () => {
    // §2.1 adapter constraint: only `?` placeholders; rows read by field. Verify
    // the three surfaces against a real table.
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    const db = getDb()!
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, blob TEXT)')
    db.run('INSERT INTO t (id, n, blob) VALUES (?,?,?)', 'a', 1, 'x')
    db.run('INSERT INTO t (id, n, blob) VALUES (?,?,?)', 'b', 2, null)
    const one = db.get<{ id: string; n: number; blob: string | null }>(
      'SELECT id, n, blob FROM t WHERE id=?',
      'b',
    )
    expect(one).toEqual({ id: 'b', n: 2, blob: null })
    const many = db.all<{ id: string }>('SELECT id FROM t WHERE n >= ? ORDER BY id', 1)
    expect(many.map((r) => r.id)).toEqual(['a', 'b'])
    // get() on no match is undefined.
    expect(db.get('SELECT id FROM t WHERE id=?', 'missing')).toBeUndefined()
  })

  it('passes the `:memory:` sentinel through verbatim (reviewer fix)', () => {
    // db.ts dbPath() must NOT resolve() `:memory:` into a literal file path, else
    // the in-memory special-case (mkdir skip) never triggers. An in-memory db
    // opens and works.
    process.env.C3_DB_PATH = ':memory:'
    const db = getDb()
    expect(db).not.toBeNull()
    expect(isDbAvailable()).toBe(true)
    db!.exec('CREATE TABLE m (id TEXT)')
    db!.run('INSERT INTO m (id) VALUES (?)', 'z')
    expect(db!.get<{ id: string }>('SELECT id FROM m')?.id).toBe('z')
  })

  it('degrades to unavailable (null, no throw) when the path cannot be opened', () => {
    // §2.1 failure fallback: open failure flips available=false WITHOUT throwing,
    // so c3 still boots. A path nested under a non-directory forces the failure.
    process.env.C3_DB_PATH = '/dev/null/nope/c3.db'
    expect(() => getDb()).not.toThrow()
    expect(getDb()).toBeNull()
    expect(isDbAvailable()).toBe(false)
  })

  it('memoizes the open attempt until reset', () => {
    // getDb() opens once (opened flag); resetDbForTests() forces a re-open. This
    // underpins the test isolation the store tests rely on.
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    const first = getDb()
    expect(getDb()).toBe(first)
    resetDbForTests()
    process.env.C3_DB_PATH = join(dir, 'other.db')
    const second = getDb()
    expect(second).not.toBe(first)
  })
})

describe('db driver startup probe + home resolution (release 4/7)', () => {
  it('checkDbDriver() reports the builtin SQLite driver usable on this runtime', () => {
    // The boot-time probe (server.ts) — opens :memory: + SELECT 1 on the platform
    // driver. Under vitest/Node that's node:sqlite; it must succeed (return true).
    expect(checkDbDriver()).toBe(true)
  })

  it('defaults the db dir to `<homedir>/.c3` when neither C3_DB_PATH nor C3_DIR is set', () => {
    // The Windows-correctness item: home resolution goes through os.homedir()
    // (→ %USERPROFILE% on win32), never a raw `~`. os.homedir() honours $HOME on
    // POSIX, so point it at a throwaway and assert the db lands under <home>/.c3.
    const prevHome = process.env.HOME
    delete process.env.C3_DB_PATH
    delete process.env.C3_DIR
    process.env.HOME = dir
    try {
      const db = getDb()
      expect(db).not.toBeNull()
      expect(existsSync(join(dir, '.c3', 'c3.db'))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  })
})
