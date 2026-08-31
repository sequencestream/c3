/**
 * Shared SQLite access for c3, persisted at `~/.c3/c3.db` (overridable by the CLI
 * `--db <path>`, by `C3_DB_PATH`, or the dir via `C3_DIR`). The single c3.db backs
 * every persistence domain — configuration included (kernel/config/config-store.ts),
 * which is what makes the db path the one override that relocates a whole c3
 * instance; each domain store owns its own tables and schema-ensure flag over this
 * one connection.
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

/** How to open a database file. */
export interface OpenOptions {
  /**
   * Open without write access. Required when reading a file another program owns:
   * a read-write open would take a lock and can create sidecar journal files in a
   * directory that is not ours.
   */
  readonly?: boolean
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

function nodeAdapter(path: string, options: OpenOptions = {}): Db {
  const { DatabaseSync } = runtimeRequire('node:sqlite') as {
    DatabaseSync: new (p: string, o: { readOnly?: boolean }) => RawNodeDb
  }
  // Always an object: `node:sqlite` rejects an explicit `undefined` here.
  const db = new DatabaseSync(path, options.readonly ? { readOnly: true } : {})
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

function bunAdapter(path: string, options: OpenOptions = {}): Db {
  const { Database } = runtimeRequire('bun:sqlite') as {
    Database: new (
      p: string,
      o: { readonly?: boolean; readwrite?: boolean; create?: boolean },
    ) => RawBunDb
  }
  // bun:sqlite derives the SQLite open flags from THIS object and nothing else:
  // its read-write+create default applies only when the argument is omitted, so
  // an empty `{}` computes flags=0 and Bun throws SQLITE_MISUSE ("flags must
  // include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE") — the whole database
  // then degrades to unavailable under the binary while Node stays fine. Spell
  // the write intent out instead of relying on any default.
  const db = new Database(
    path,
    options.readonly ? { readonly: true } : { readwrite: true, create: true },
  )
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

/**
 * Explicit database path (CLI `--db <path>`), set once at startup before anything
 * opens the db. It is the strongest override there is: c3.db holds the whole
 * configuration, so pointing at another file relocates the entire instance — which
 * is why `c3HomeDir()` derives the config home from it (kernel/config/paths.ts).
 */
let dbPathOverride: string | null = null

/**
 * Set the database file used for all subsequent access. Must be called before the
 * first {@link getDb} (the cli's `start` action does this).
 */
export function setDbPath(path: string): void {
  dbPathOverride = path === ':memory:' ? ':memory:' : resolve(path)
}

/** Whether `--db` was given — the config home follows it (kernel/config/paths.ts). */
export function hasDbPathOverride(): boolean {
  return dbPathOverride !== null
}

/**
 * The resolved database file: `--db` → `C3_DB_PATH` → `<C3_DIR>/c3.db` → `~/.c3/c3.db`.
 * The `:memory:` sentinel is preserved verbatim — `resolve()` would turn it into a
 * literal file path and defeat the in-memory special-case in {@link getDb}.
 */
export function dbPath(): string {
  if (dbPathOverride) return dbPathOverride
  if (process.env.C3_DB_PATH) {
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
 * Open an arbitrary SQLite file with this runtime's driver, or `null` when it
 * cannot be opened.
 *
 * Separate from {@link getDb}, which owns the single shared c3 database: this is
 * for reading a file some *other* program owns, where a failure to open is an
 * ordinary outcome (missing, locked, or written by a newer schema) rather than a
 * condition worth logging as a c3 fault. Callers close what they open.
 */
export function openSqlite(path: string, options: OpenOptions = {}): Db | null {
  try {
    return isBun() ? bunAdapter(path, options) : nodeAdapter(path, options)
  } catch {
    return null
  }
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
        `(${isBun() ? 'Bun' : 'Node'} runtime). Persistence (intents, discussions, automations) ` +
        `will not work. Cause: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// One-shot data-migration markers
// ---------------------------------------------------------------------------

/**
 * Marker table for one-shot DATA migrations: one row = one migration that has
 * finished. It answers what column/table existence checks cannot — "the table is
 * there, but is its backfill done?" — and what `INSERT OR IGNORE` cannot express:
 * "this backfill completed, never run it again".
 *
 * Deliberately NOT `PRAGMA user_version`: that is a single integer shared by every
 * store, so using it as the verdict would force globally serialized numbering
 * across independent domains. Each store keeps its own version stamp; this table
 * is the cross-domain fact of "already applied".
 */
const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);`

/**
 * Create the marker table if missing. Callers run this before their first
 * {@link hasMigration} check; it is idempotent and cheap.
 */
export function ensureMigrationsTable(d: Db): void {
  d.exec(MIGRATIONS_TABLE)
}

/** Whether the one-shot migration `id` has already been applied. */
export function hasMigration(d: Db, id: string): boolean {
  ensureMigrationsTable(d)
  return !!d.get('SELECT 1 FROM schema_migrations WHERE id=?', id)
}

/**
 * Record `id` as applied. Call INSIDE the same transaction as the migration's
 * data writes — a rollback must take the marker with it, so a half-finished
 * backfill can never read as complete.
 */
export function markMigration(d: Db, id: string): void {
  d.run('INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?,?)', id, Date.now())
}

/** Whether the c3 database opened successfully (callers degrade if not). */
export function isDbAvailable(): boolean {
  if (!opened) getDb()
  return available
}

/** Whether a table exists — used to gate idempotent schema migrations. */
export function tableExists(d: Db, table: string): boolean {
  return !!d.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    table,
  )
}

/** Column names on `table`, from `PRAGMA table_info`. */
export function tableColumns(d: Db, table: string): Set<string> {
  return new Set(d.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
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
  dbPathOverride = null
}
