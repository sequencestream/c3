/**
 * Shared SQLite access for c3, persisted at `~/.c3/c3.db` (overridable for tests
 * via `C3_DB_PATH`, or the dir via `C3_DIR`). The single c3.db backs every
 * persistence domain (requirements, discussions, …); each domain store owns its
 * own tables and schema-ensure flag over this one connection.
 *
 * Cross-runtime: c3 ships both as a Node bundle (`node cli.cjs`) and a Bun
 * single binary. The two runtimes expose DIFFERENT builtin SQLite modules and
 * NEITHER carries the other's — verified: Node 26 has `node:sqlite`
 * (`DatabaseSync`), Bun 1.3 has `bun:sqlite` (`Database`), and a Bun build
 * cannot load `node:sqlite`. So we pick the driver at runtime via `globalThis.Bun`
 * and load it with a runtime `require` (never a static import, which would make
 * the wrong runtime eagerly resolve a missing module). Both APIs are synchronous,
 * so a single sync {@link Db} interface fits; `server/build.mjs` must mark both
 * `node:sqlite` and `bun:sqlite` as esbuild externals.
 *
 * On any open/migration error the module degrades to "unavailable" rather than
 * crashing c3 — callers guard with {@link isDbAvailable} / a null {@link getDb}.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export type SqlParam = string | number | bigint | null | Uint8Array

/** Minimal synchronous SQLite surface shared by both drivers. */
export interface Db {
  /** Run one or more statements with no bound params (DDL / PRAGMA / BEGIN…). */
  exec(sql: string): void
  /** Execute a write statement with `?` positional params. */
  run(sql: string, ...params: SqlParam[]): void
  /** Run a query, returning all rows as plain objects. */
  all<T>(sql: string, ...params: SqlParam[]): T[]
  /** Run a query, returning the first row or undefined. */
  get<T>(sql: string, ...params: SqlParam[]): T | undefined
  close(): void
}

// Structural shapes of the two drivers — declared locally so we depend on
// neither @types/node's experimental `node:sqlite` types nor bun-types.
interface RawStmt {
  run(...p: SqlParam[]): unknown
  all(...p: SqlParam[]): unknown[]
  get(...p: SqlParam[]): unknown
}
interface RawNodeDb {
  exec(sql: string): void
  prepare(sql: string): RawStmt
  close(): void
}
interface RawBunDb {
  exec(sql: string): void
  query(sql: string): RawStmt
  close(): void
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/** The builtin SQLite driver this runtime requires: Bun → `bun:sqlite`, else `node:sqlite`. */
function driverName(): string {
  return isBun() ? 'bun:sqlite' : 'node:sqlite'
}

// A `require` that works in every execution context: native in the esbuild CJS
// bundle, and `createRequire(import.meta.url)` under ESM (tsx dev / Bun binary).
// In the CJS bundle esbuild rewrites `import.meta.url` to `undefined`, but the
// ternary short-circuits to the native `require` there, so that arg is never
// evaluated — the empty-import-meta warning it emits is silenced in build.mjs.
// (We can't use direct eval here: Node 26 runs eval in script goal, where
// `import.meta` is a hard SyntaxError.)
const runtimeRequire: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url)

function nodeAdapter(path: string): Db {
  const { DatabaseSync } = runtimeRequire('node:sqlite') as {
    DatabaseSync: new (p: string) => RawNodeDb
  }
  const db = new DatabaseSync(path)
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...p) => {
      db.prepare(sql).run(...p)
    },
    all: <T>(sql: string, ...p: SqlParam[]) => db.prepare(sql).all(...p) as T[],
    get: <T>(sql: string, ...p: SqlParam[]) => db.prepare(sql).get(...p) as T | undefined,
    close: () => db.close(),
  }
}

function bunAdapter(path: string): Db {
  const { Database } = runtimeRequire('bun:sqlite') as {
    Database: new (p: string) => RawBunDb
  }
  const db = new Database(path)
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...p) => {
      db.query(sql).run(...p)
    },
    all: <T>(sql: string, ...p: SqlParam[]) => db.query(sql).all(...p) as T[],
    get: <T>(sql: string, ...p: SqlParam[]) =>
      (db.query(sql).get(...p) ?? undefined) as T | undefined,
    close: () => db.close(),
  }
}

function dbPath(): string {
  if (process.env.C3_DB_PATH) {
    // Preserve the `:memory:` sentinel verbatim — `resolve()` would turn it into
    // a literal file path and defeat the in-memory special-case in `getDb()`.
    return process.env.C3_DB_PATH === ':memory:' ? ':memory:' : resolve(process.env.C3_DB_PATH)
  }
  const home = process.env.C3_DIR ? resolve(process.env.C3_DIR) : join(homedir(), '.c3')
  return join(home, 'c3.db')
}

let instance: Db | null = null
let opened = false
let available = false

/**
 * Open (once) and return the database, or null if it could not be opened. Sets
 * WAL + a busy timeout — cheap insurance if multiple c3 processes point at one
 * file (not a primary goal, but zero-cost).
 */
export function getDb(): Db | null {
  if (opened) return instance
  opened = true
  try {
    const path = dbPath()
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = isBun() ? bunAdapter(path) : nodeAdapter(path)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
    instance = db
    available = true
  } catch (err) {
    console.error(`[c3] c3.db unavailable (driver ${driverName()}):`, err)
    instance = null
    available = false
  }
  return instance
}

/**
 * Startup probe for the platform's builtin SQLite driver. A Bun single binary
 * needs `bun:sqlite`; a Node bundle needs `node:sqlite` — and a platform/runtime
 * that ships without its driver (the realistic risk on a freshly-supported target
 * like a Windows Bun binary) must fail LOUD at boot, not silently degrade to a
 * persistence-less app that "works" until the first write quietly no-ops. Opens an
 * in-memory db and runs `SELECT 1`; returns true if usable, else prints an explicit,
 * actionable error and returns false (callers still degrade via {@link isDbAvailable},
 * but the operator was told exactly what broke and on which platform).
 */
export function checkDbDriver(): boolean {
  const driver = driverName()
  try {
    const probe = isBun() ? bunAdapter(':memory:') : nodeAdapter(':memory:')
    probe.exec('SELECT 1;')
    probe.close()
    return true
  } catch (err) {
    console.error(
      `[c3] FATAL: SQLite driver "${driver}" unavailable on ${process.platform}/${process.arch} ` +
        `(${isBun() ? 'Bun' : 'Node'} runtime). Persistence (requirements, discussions, schedules) ` +
        `will not work. Cause: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

/** Whether the c3 database opened successfully (callers degrade if not). */
export function isDbAvailable(): boolean {
  if (!opened) getDb()
  return available
}

/** Test-only: close and forget the connection so the next `getDb()` re-opens. */
export function resetDbForTests(): void {
  try {
    instance?.close()
  } catch {
    /* noop */
  }
  instance = null
  opened = false
  available = false
}
