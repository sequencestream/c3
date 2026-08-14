/**
 * The configuration tables in `c3.db` — c3's single source of truth for settings.
 *
 * Everything that used to live in `~/.c3/settings.json`, `~/.c3/state.json` and
 * `~/.claude/c3/state.json` is stored here as fine-grained rows: one field, one row,
 * keyed by `config_key` and tagged with `config_type` (see `config-codec.ts` for the
 * expansion rules). Four consequences that motivated the move:
 *
 *  1. One override relocates a whole c3 instance — the db path — instead of the two
 *     unrelated ones (`--settings` for the config dir, `C3_DB_PATH` for the db) that
 *     had to be kept in sync by hand.
 *  2. A write touches the fields it changes. The read-modify-write of a whole
 *     document is gone, and with it the hand-written anti-clobber merge that existed
 *     only to undo the damage of writing back fields the writer never intended to own.
 *  3. Atomicity comes from SQLite transactions + WAL, not from a `mkdirSync` directory
 *     lock with stale-owner reclaim and a best-effort timeout path.
 *  4. Secrets keep their `c3secret…` ciphertext but are now identifiable as such by
 *     `config_type='secret'` rather than by inspecting the value.
 *
 * Scopes map onto tables: system settings are global, everything else is owned by a
 * workspace / subject / session / key id. Reads degrade to empty when the db is
 * unavailable (c3 must still boot); writes throw, because a silently dropped setting
 * is worse than a failed save.
 */
import {
  ensureMigrationsTable,
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../infra/db.js'
import type { ConfigEntry, ConfigType } from './config-codec.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  name          TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64),
  path          TEXT NOT NULL UNIQUE,
  last_accessed INTEGER NOT NULL,
  registered    INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS system_configs (
  config_key   TEXT PRIMARY KEY,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_configs (
  workspace_name TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_name, config_key)
);
CREATE TABLE IF NOT EXISTS personalized_configs (
  subject      TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (subject, config_key)
);
CREATE TABLE IF NOT EXISTS session_configs (
  session_id   TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, config_key)
);
CREATE TABLE IF NOT EXISTS mcp_api_keys (
  key_id       TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (key_id, config_key)
);
`

/** Which family of configuration a scope addresses. */
export type ConfigScopeKind = 'system' | 'workspace' | 'personalized' | 'session' | 'mcpKey'

/** A scope is a table plus (for everything but `system`) the row owner's id. */
export interface ConfigScope {
  kind: ConfigScopeKind
  /** Workspace name / subject / session id / key id. Absent for `system`. */
  owner?: string
}

interface ScopeTable {
  table: string
  /** The owning column, or null for the single-row-space `system_configs`. */
  ownerCol: string | null
}

const SCOPE_TABLES: Record<ConfigScopeKind, ScopeTable> = {
  system: { table: 'system_configs', ownerCol: null },
  workspace: { table: 'workspace_configs', ownerCol: 'workspace_name' },
  personalized: { table: 'personalized_configs', ownerCol: 'subject' },
  session: { table: 'session_configs', ownerCol: 'session_id' },
  mcpKey: { table: 'mcp_api_keys', ownerCol: 'key_id' },
}

// Schema readiness is tracked by connection identity, not a boolean: a test that
// swaps the db (resetDbForTests) would otherwise inherit a "schema ready" flag that
// describes a connection nobody holds anymore.
let schemaReadyFor: Db | null = null

const WORKSPACE_NAME_MIGRATION = 'config.workspace_name_identity.v1'
const WORKSPACE_PATH_TABLES = [
  'intents',
  'intent_chats',
  'intent_fast_turns',
  'discussions',
  'deliveries',
  'automations',
  'workspace_mcp_configs',
  'queue_workspace_state',
  'queue_intent_state',
  'queue_decision_log',
  'session_metadata',
  'wait_user_involve_events',
  'funnel_event',
] as const

function tableColumns(d: Db, table: string): Set<string> {
  return new Set(d.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name))
}

function trimToChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('')
}

function allocateWorkspaceName(raw: string, used: Set<string>): string {
  const base = trimToChars(raw.trim() || 'workspace', 64)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${trimToChars(base, 64 - suffix.length)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** Convert every persisted workspace association to the immutable workspace name. */
function ensureWorkspaceNameMigration(d: Db): void {
  ensureMigrationsTable(d)
  if (hasMigration(d, WORKSPACE_NAME_MIGRATION)) return

  const workspaceCols = tableColumns(d, 'workspaces')
  const hasLegacyAssociation =
    WORKSPACE_PATH_TABLES.some((table) => {
      const cols = tableColumns(d, table)
      return cols.has('workspace_path') || (table === 'funnel_event' && cols.has('workspace_id'))
    }) || tableColumns(d, 'workspace_configs').has('workspace_id')
  if (!workspaceCols.has('id') && !hasLegacyAssociation) {
    markMigration(d, WORKSPACE_NAME_MIGRATION)
    return
  }

  d.exec('BEGIN IMMEDIATE')
  try {
    d.exec(`
      CREATE TEMP TABLE workspace_identity_map (
        legacy_id TEXT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE
      );
    `)

    const legacy = d.all<{
      id: string | null
      path: string
      name: string
      last_accessed: number
      registered: number
      created_at: number
      updated_at: number
    }>(
      `SELECT ${workspaceCols.has('id') ? 'id' : 'NULL AS id'}, path, name,
              last_accessed, registered, created_at, updated_at
       FROM workspaces
       ORDER BY registered DESC, created_at ASC, path ASC`,
    )
    const knownPaths = new Set(legacy.map((row) => row.path))
    for (const table of WORKSPACE_PATH_TABLES) {
      const cols = tableColumns(d, table)
      const column = cols.has('workspace_path')
        ? 'workspace_path'
        : table === 'funnel_event' && cols.has('workspace_id')
          ? 'workspace_id'
          : null
      if (!column) continue
      for (const row of d.all<{ path: string }>(
        `SELECT DISTINCT ${column} AS path FROM ${table}`,
      )) {
        if (row.path) knownPaths.add(row.path)
      }
    }
    if (tableColumns(d, 'mcp_api_keys').has('config_key')) {
      for (const row of d.all<{ path: string }>(
        `SELECT DISTINCT config_value AS path
           FROM mcp_api_keys
          WHERE config_key='workspace' AND config_value IS NOT NULL`,
      )) {
        if (row.path) knownPaths.add(row.path)
      }
    }

    const used = new Set<string>()
    const byPath = new Map<string, string>()
    for (const row of legacy) {
      const name = allocateWorkspaceName(row.name, used)
      byPath.set(row.path, name)
      d.run(
        'INSERT INTO workspace_identity_map (legacy_id, path, name) VALUES (?,?,?)',
        row.id,
        row.path,
        name,
      )
    }
    for (const path of [...knownPaths].filter((path) => !byPath.has(path)).sort()) {
      const basename =
        path
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || 'workspace'
      const name = allocateWorkspaceName(basename, used)
      byPath.set(path, name)
      d.run(
        'INSERT INTO workspace_identity_map (legacy_id, path, name) VALUES (NULL,?,?)',
        path,
        name,
      )
    }

    d.exec(`
      CREATE TABLE workspaces_v2 (
        name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64),
        path TEXT NOT NULL UNIQUE,
        last_accessed INTEGER NOT NULL,
        registered INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const now = Date.now()
    for (const [path, name] of byPath) {
      const row = legacy.find((item) => item.path === path)
      d.run(
        `INSERT INTO workspaces_v2
           (name, path, last_accessed, registered, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
        name,
        path,
        row?.last_accessed ?? 0,
        row?.registered ?? 0,
        row?.created_at ?? now,
        row?.updated_at ?? now,
      )
    }

    const configCols = tableColumns(d, 'workspace_configs')
    if (configCols.has('workspace_id')) {
      d.exec(`
        CREATE TABLE workspace_configs_v2 (
          workspace_name TEXT NOT NULL,
          config_key TEXT NOT NULL,
          config_value TEXT,
          config_type TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_name, config_key)
        );
        INSERT INTO workspace_configs_v2
          SELECT m.name, c.config_key, c.config_value, c.config_type, c.updated_at
          FROM workspace_configs c
          JOIN workspace_identity_map m ON m.legacy_id=c.workspace_id;
        DROP TABLE workspace_configs;
        ALTER TABLE workspace_configs_v2 RENAME TO workspace_configs;
      `)
    }

    for (const table of WORKSPACE_PATH_TABLES) {
      const cols = tableColumns(d, table)
      if (!cols.has('workspace_path')) continue
      d.exec(`ALTER TABLE ${table} RENAME COLUMN workspace_path TO workspace_name`)
      d.run(
        `UPDATE ${table}
         SET workspace_name=(SELECT name FROM workspace_identity_map WHERE path=${table}.workspace_name)`,
      )
    }
    const funnelCols = tableColumns(d, 'funnel_event')
    if (funnelCols.has('workspace_id')) {
      d.exec('ALTER TABLE funnel_event RENAME COLUMN workspace_id TO workspace_name')
      d.run(
        `UPDATE funnel_event
         SET workspace_name=(SELECT name FROM workspace_identity_map WHERE path=funnel_event.workspace_name)`,
      )
    }

    if (tableColumns(d, 'mcp_api_keys').has('config_key')) {
      d.run(
        `UPDATE mcp_api_keys
         SET config_value=(SELECT name FROM workspace_identity_map WHERE path=mcp_api_keys.config_value),
             config_key='workspaceName'
         WHERE config_key='workspace'`,
      )
    }

    d.exec('DROP TABLE workspaces; ALTER TABLE workspaces_v2 RENAME TO workspaces;')
    markMigration(d, WORKSPACE_NAME_MIGRATION)
    d.exec('COMMIT')
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      // Preserve the original migration failure.
    }
    throw err
  }
}

/**
 * The shared connection with the config schema materialized, or null when the db
 * could not be opened. Callers that read degrade to empty; callers that write use
 * {@link requireConfigDb}.
 */
export function configDb(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      d.exec(SCHEMA)
      ensureWorkspaceNameMigration(d)
      schemaReadyFor = d
    } catch {
      return null
    }
  }
  return d
}

/** The connection, or a thrown error — for write paths, where dropping is not an option. */
export function requireConfigDb(): Db {
  const d = configDb()
  if (!d) throw new Error('[c3] 配置数据库不可用,无法保存配置')
  return d
}

/** Whether configuration can be read/written at all. */
export function isConfigStoreAvailable(): boolean {
  return configDb() !== null
}

/** Test hook: forget the schema-ready connection so the next call re-materializes. */
export function resetConfigStoreForTests(): void {
  schemaReadyFor = null
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

let txDepth = 0

/**
 * Run `fn` inside one SQLite transaction. Re-entrant: a nested call joins the
 * outer transaction instead of opening a second one (SQLite has no nested BEGIN),
 * so a caller can compose writes from several stores — a legacy import writing a
 * workspace row and its config rows either lands whole or not at all.
 */
export function configTx<T>(fn: (d: Db) => T): T {
  const d = requireConfigDb()
  if (txDepth > 0) return fn(d)
  d.exec('BEGIN')
  txDepth++
  try {
    const result = fn(d)
    txDepth--
    d.exec('COMMIT')
    return result
  } catch (err) {
    txDepth--
    try {
      d.exec('ROLLBACK')
    } catch {
      /* the transaction is already gone — the original error is the one that matters */
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

interface ConfigRow {
  config_key: string
  config_value: string | null
  config_type: string
}

const VALID_TYPES: ReadonlySet<string> = new Set<ConfigType>([
  'string',
  'number',
  'boolean',
  'json',
  'secret',
])

function toEntry(row: ConfigRow): ConfigEntry | null {
  // An unknown type is a row written by a newer c3 (or by hand). Skipping it keeps
  // the rest of the settings readable instead of guessing at its encoding.
  if (!VALID_TYPES.has(row.config_type)) return null
  return { key: row.config_key, value: row.config_value, type: row.config_type as ConfigType }
}

/** Every row in one scope. Empty when the db is unavailable or the scope has none. */
export function readScope(scope: ConfigScope): ConfigEntry[] {
  const d = configDb()
  if (!d) return []
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  const rows = ownerCol
    ? d.all<ConfigRow>(
        `SELECT config_key, config_value, config_type FROM ${table} WHERE ${ownerCol}=?`,
        scope.owner ?? '',
      )
    : d.all<ConfigRow>(`SELECT config_key, config_value, config_type FROM ${table}`)
  return rows.map(toEntry).filter((e): e is ConfigEntry => e !== null)
}

/** One row by key, or null when the scope does not have it. */
export function readKey(scope: ConfigScope, key: string): ConfigEntry | null {
  const d = configDb()
  if (!d) return null
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  const row = ownerCol
    ? d.get<ConfigRow>(
        `SELECT config_key, config_value, config_type FROM ${table} WHERE ${ownerCol}=? AND config_key=?`,
        scope.owner ?? '',
        key,
      )
    : d.get<ConfigRow>(
        `SELECT config_key, config_value, config_type FROM ${table} WHERE config_key=?`,
        key,
      )
  return row ? toEntry(row) : null
}

/** Every owner id present in an owned scope kind (`system` has none, returns []). */
export function listScopeOwners(kind: ConfigScopeKind): string[] {
  const d = configDb()
  if (!d) return []
  const { table, ownerCol } = SCOPE_TABLES[kind]
  if (!ownerCol) return []
  return d
    .all<{ owner: string }>(`SELECT DISTINCT ${ownerCol} AS owner FROM ${table}`)
    .map((r) => r.owner)
}

/**
 * All rows of an owned scope kind, grouped by owner — one query instead of one per
 * owner, which matters for the settings load that has to assemble every workspace's
 * configuration at once.
 */
export function readAllScopes(kind: ConfigScopeKind): Map<string, ConfigEntry[]> {
  const grouped = new Map<string, ConfigEntry[]>()
  const d = configDb()
  if (!d) return grouped
  const { table, ownerCol } = SCOPE_TABLES[kind]
  if (!ownerCol) return grouped
  const rows = d.all<ConfigRow & { owner: string }>(
    `SELECT ${ownerCol} AS owner, config_key, config_value, config_type FROM ${table}`,
  )
  for (const row of rows) {
    const entry = toEntry(row)
    if (!entry) continue
    const bucket = grouped.get(row.owner)
    if (bucket) bucket.push(entry)
    else grouped.set(row.owner, [entry])
  }
  return grouped
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface WriteScopeOptions {
  /**
   * Delete rows of this scope that `entries` does not mention (default true — the
   * caller states the scope's whole content). Pass false to patch a few fields
   * without claiming ownership of the rest.
   */
  replace?: boolean
  /**
   * Key namespaces a replacing write does not own and must not delete. The system
   * scope holds both `SystemSettings` and things that merely share its table (the
   * `state.*` namespace, `agentLang`); a whole-settings save states the former and
   * knows nothing about the latter.
   */
  preservePrefixes?: readonly string[]
}

/**
 * Write `entries` into a scope in one transaction. With `replace` (the default) the
 * scope ends up containing exactly `entries`.
 */
export function writeScope(
  scope: ConfigScope,
  entries: readonly ConfigEntry[],
  options: WriteScopeOptions = {},
): void {
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  const owner = scope.owner ?? ''
  const now = Date.now()
  configTx((d) => {
    if (options.replace !== false) {
      const keep = new Set(entries.map((e) => e.key))
      const preserved = options.preservePrefixes ?? []
      const isPreserved = (key: string): boolean =>
        preserved.some((p) => key === p || key.startsWith(`${p}.`))
      const existing = ownerCol
        ? d.all<{ config_key: string }>(
            `SELECT config_key FROM ${table} WHERE ${ownerCol}=?`,
            owner,
          )
        : d.all<{ config_key: string }>(`SELECT config_key FROM ${table}`)
      for (const row of existing) {
        if (keep.has(row.config_key) || isPreserved(row.config_key)) continue
        if (ownerCol)
          d.run(`DELETE FROM ${table} WHERE ${ownerCol}=? AND config_key=?`, owner, row.config_key)
        else d.run(`DELETE FROM ${table} WHERE config_key=?`, row.config_key)
      }
    }
    for (const entry of entries) {
      if (ownerCol) {
        d.run(
          `INSERT INTO ${table} (${ownerCol}, config_key, config_value, config_type, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(${ownerCol}, config_key) DO UPDATE SET
             config_value=excluded.config_value,
             config_type=excluded.config_type,
             updated_at=excluded.updated_at`,
          owner,
          entry.key,
          entry.value,
          entry.type,
          now,
        )
      } else {
        d.run(
          `INSERT INTO ${table} (config_key, config_value, config_type, updated_at)
           VALUES (?,?,?,?)
           ON CONFLICT(config_key) DO UPDATE SET
             config_value=excluded.config_value,
             config_type=excluded.config_type,
             updated_at=excluded.updated_at`,
          entry.key,
          entry.value,
          entry.type,
          now,
        )
      }
    }
  })
}

/** Drop every row of a scope (a removed workspace, a revoked key, an ended session). */
export function deleteScope(scope: ConfigScope): void {
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  if (!ownerCol) throw new Error('[c3] 系统配置作用域不支持整体删除')
  const d = configDb()
  if (!d) return
  d.run(`DELETE FROM ${table} WHERE ${ownerCol}=?`, scope.owner ?? '')
}

/** Delete specific keys within a scope, leaving the rest untouched. */
export function deleteKeys(scope: ConfigScope, keys: readonly string[]): void {
  if (keys.length === 0) return
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  const d = configDb()
  if (!d) return
  configTx(() => {
    for (const key of keys) {
      if (ownerCol)
        d.run(`DELETE FROM ${table} WHERE ${ownerCol}=? AND config_key=?`, scope.owner ?? '', key)
      else d.run(`DELETE FROM ${table} WHERE config_key=?`, key)
    }
  })
}

/**
 * Delete every row whose key starts with `prefix` (dot-terminated internally, so
 * `state.skillAck` never eats `state.skillAcks`). Used where a subtree is dropped
 * as a unit — a namespace of state keys, a record removed from an expanded array.
 */
export function deleteKeyPrefix(scope: ConfigScope, prefix: string): void {
  const { table, ownerCol } = SCOPE_TABLES[scope.kind]
  const d = configDb()
  if (!d) return
  const like = `${prefix.replace(/[%_\\]/g, '\\$&')}.%`
  if (ownerCol) {
    d.run(
      `DELETE FROM ${table} WHERE ${ownerCol}=? AND (config_key=? OR config_key LIKE ? ESCAPE '\\')`,
      scope.owner ?? '',
      prefix,
      like,
    )
  } else {
    d.run(`DELETE FROM ${table} WHERE config_key=? OR config_key LIKE ? ESCAPE '\\'`, prefix, like)
  }
}
