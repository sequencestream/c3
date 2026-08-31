/**
 * Shared persistence base for the IM robot stores: the error type, the injected
 * clock, transaction helper, SQLite introspection primitives, and the lazy
 * schema-ensure entrypoint (`db()` / `requireDb()`) that the four split modules
 * (config / context / turn / schema) all route through.
 *
 * `db()` owns the "schema ensured once per connection" state. It does not know
 * *what* the schema is — `robot-schema.ts` registers the ensure + post-ensure
 * steps here at load time via {@link registerSchemaSetup}. That keeps this module
 * dependency-free so config/context/turn can import it without a cycle back into
 * the schema module.
 */
import {
  getDb,
  isDbAvailable,
  tableColumns,
  tableExists,
  type Db,
  type SqlParam,
} from '../../kernel/infra/db.js'

// ---- Errors ----

export type RobotStoreErrorCode =
  | 'db_unavailable'
  | 'not_found'
  | 'name_invalid'
  | 'name_conflict'
  | 'platform_unsupported'
  | 'secret_required'
  | 'outbound_not_acknowledged'
  | 'locale_invalid'

export class RobotStoreError extends Error {
  constructor(
    readonly code: RobotStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RobotStoreError'
  }
}

// ---- Clock ----

let nowFn: () => number = () => Date.now()

/** Test hook: inject a clock for retention boundaries. */
export function setRobotStoreClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

export function now(): number {
  return nowFn()
}

// ---- SQLite primitives ----

export { tableColumns, tableExists }

/** Run `fn` inside BEGIN/COMMIT; a throw rolls back and rethrows. */
export function tx<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw err
  }
}

// ---- Lazy schema lifecycle ----

let schemaReadyFor: Db | null = null
let schemaFailed = false
let schemaEnsure: ((d: Db) => void) | null = null
let afterSchemaEnsure: ((d: Db) => void) | null = null

/**
 * Register the schema ensure + post-ensure steps that `db()` runs once per fresh
 * connection. Called by `robot-schema.ts` at module load; the post-ensure step
 * lets the context store converge leftover pending rows after a restart.
 */
export function registerSchemaSetup(ensure: (d: Db) => void, after: (d: Db) => void): void {
  schemaEnsure = ensure
  afterSchemaEnsure = after
}

/** The schema-ensured connection, or null when the store is unavailable. */
export function db(): Db | null {
  if (schemaFailed) return null
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      schemaEnsure?.(d)
      afterSchemaEnsure?.(d)
    } catch (err) {
      schemaFailed = true
      schemaReadyFor = null
      console.error(
        '[c3][im] robot schema migration failed; supervisor must not start:',
        err instanceof Error ? err.message : err,
      )
      return null
    }
    schemaReadyFor = d
  }
  return d
}

export function requireDb(): Db {
  const d = db()
  if (!d) throw new RobotStoreError('db_unavailable', '机器人库不可用,本次写入未生效。')
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetRobotStoreForTests(): void {
  schemaReadyFor = null
  schemaFailed = false
  nowFn = () => Date.now()
}

/** Materialize the tables at startup so an unusable database is found early. */
export function ensureRobotSchema(): boolean {
  return db() !== null
}

export function isStoreAvailable(): boolean {
  return db() !== null
}

export type { Db, SqlParam }
