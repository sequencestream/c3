/**
 * Automation schema lifecycle over the shared {@link Db} (c3.db).
 *
 * Isolates the automation store's one-time schema concerns from its runtime
 * CRUD path: the base DDL + version, table/column probes, legacy-name renames,
 * the per-version ALTER migrations, and the v12/v13 event-filter backfills
 * (including the retired per-topic filter parsers, kept here as migration input
 * only). {@link store.ts} calls {@link ensureAutomationSchema} once when it first
 * obtains a usable db; nothing here reaches back into the runtime store.
 */
import type {
  EventMetadataFilter,
  EventMetadataFilterCondition,
  GenericEventFilter,
  IntentLifecycleFilter,
  IntentLifecyclePhase,
  PrOperation,
  PrOperationFilter,
  PrOperationResult,
  RunEndReason,
} from '@ccc/shared/protocol'
import {
  INTENT_LIFECYCLE_PHASES,
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  isValidAutomationMaxWallClockMs,
  normalizeEventMetadataFilter,
  normalizeGenericEventFilter,
  upgradeV12EventFilter,
} from '@ccc/shared/protocol'
import type { Db } from '../../kernel/infra/db.js'

const SCHEMA_VERSION = 13

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automations (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL,
  config              TEXT NOT NULL DEFAULT '{}',
  max_wall_clock_ms   INTEGER,
  workspace_path      TEXT NOT NULL,
  trigger_type        TEXT NOT NULL DEFAULT 'cron',
  cron_expression     TEXT NOT NULL,
  next_run_at         INTEGER,
  event_topic         TEXT,
  event_reason_filter TEXT,
  event_pr_filter     TEXT,
  event_intent_filter TEXT,
  event_session_kind_filter TEXT,
  event_metadata_filter     TEXT,
  event_filter        TEXT,
  event_filters       TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT '',
  tool_allowlist      TEXT NOT NULL DEFAULT '[]',
  tool_denylist       TEXT NOT NULL DEFAULT '[]',
  vendor              TEXT NOT NULL DEFAULT 'claude',
  agent_id            TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sch_workspace ON automations(workspace_path);

CREATE TABLE IF NOT EXISTS automation_execution_logs (
  id            TEXT PRIMARY KEY,
  automation_id   TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  exit_code     INTEGER,
  output        TEXT NOT NULL DEFAULT '',
  error         TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sch_exec_schedule ON automation_execution_logs(automation_id);

CREATE TABLE IF NOT EXISTS workspace_mcp_configs (
  workspace_path TEXT PRIMARY KEY,
  config_json    TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL
);
`

/**
 * Ensure the automation schema on `d`: rename legacy tables, apply the base DDL,
 * run the per-version migrations + backfills, then stamp the version. The order
 * is fixed — legacy renames MUST precede the base `CREATE TABLE IF NOT EXISTS`
 * so an empty new table is never created ahead of the old data. Errors propagate
 * to the caller (schema init aborts) so a half-migrated db is never marked ready.
 */
export function ensureAutomationSchema(d: Db): void {
  renameLegacyTables(d)
  d.exec(SCHEMA)
  runMigrations(d)
  d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
}

/** Whether a column already exists on a table (so an ALTER ADD is idempotent). */
function columnExists(d: Db, table: string, column: string): boolean {
  const rows = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return rows.some((r) => r.name === column)
}

/** Whether a table exists (any column) — used to gate legacy-name renames. */
function tableExists(d: Db, table: string): boolean {
  return d.all<{ name: string }>(`PRAGMA table_info(${table})`).length > 0
}

// schedule → automation 改名迁移。历史数据库带旧表名/列名，必须在 base SCHEMA
// 的 `CREATE TABLE IF NOT EXISTS automations` 之前原地改名，否则会先建出空表导致
// 旧数据孤立(数据丢失)。全部以 table_info 探测为守卫，重复运行为 no-op。
function renameLegacyTables(d: Db): void {
  if (tableExists(d, 'schedules') && !tableExists(d, 'automations')) {
    d.exec(`ALTER TABLE schedules RENAME TO automations`)
  }
  if (tableExists(d, 'schedule_execution_logs') && !tableExists(d, 'automation_execution_logs')) {
    d.exec(`ALTER TABLE schedule_execution_logs RENAME TO automation_execution_logs`)
  }
  if (
    tableExists(d, 'automation_execution_logs') &&
    columnExists(d, 'automation_execution_logs', 'schedule_id')
  ) {
    d.exec(`ALTER TABLE automation_execution_logs RENAME COLUMN schedule_id TO automation_id`)
  }
}

// Migration functions — run after the base schema to evolve the database across versions.
//
// IMPORTANT: `PRAGMA user_version` is database-global and shared with the sibling
// intent/discussion stores, which set it to THEIR own SCHEMA_VERSION. So this
// store can never trust `user_version` to gate its migrations: intents (v5)
// may have stamped it to 5 before we run, making any `currentVersion < N` check
// wrongly skip our ALTERs (the bug that left old `automation_execution_logs` tables
// without `session_id`). Mirror the intent/discussion stores: drive every
// migration off `PRAGMA table_info` / `IF NOT EXISTS` so each step is idempotent
// regardless of the shared version counter — a fresh db already has the latest
// SCHEMA, an old db gets backfilled here, and re-runs are no-ops.
function runMigrations(d: Db): void {
  // add status column to automation_execution_logs (historic rows default 'running').
  if (!columnExists(d, 'automation_execution_logs', 'status')) {
    d.exec(
      `ALTER TABLE automation_execution_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'running'`,
    )
  }
  // add workspace_mcp_configs for db files opened before the base SCHEMA carried
  // this table (IF NOT EXISTS makes this a no-op otherwise).
  d.exec(`
    CREATE TABLE IF NOT EXISTS workspace_mcp_configs (
      workspace_path TEXT PRIMARY KEY,
      config_json    TEXT NOT NULL DEFAULT '{}',
      updated_at     INTEGER NOT NULL
    );
  `)
  // add session_id column to automation_execution_logs (llm-type runs record their
  // agent session id so the transcript can be loaded on demand).
  if (!columnExists(d, 'automation_execution_logs', 'session_id')) {
    d.exec(`ALTER TABLE automation_execution_logs ADD COLUMN session_id TEXT`)
  }
  // v5 (2026-06-08): event-triggered automations. trigger_type defaults old rows to
  // 'cron' so their cron behaviour is unchanged; event_topic / event_reason_filter
  // stay NULL for cron rows. Each ALTER is gated on table_info so re-runs no-op.
  if (!columnExists(d, 'automations', 'trigger_type')) {
    d.exec(`ALTER TABLE automations ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'`)
  }
  if (!columnExists(d, 'automations', 'event_topic')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_topic TEXT`)
  }
  if (!columnExists(d, 'automations', 'event_reason_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_reason_filter TEXT`)
  }
  // v6 (2026-06-08): vendor column. Old automations default to 'claude' so their
  // execution behaviour is unchanged — they keep running under the default vendor.
  if (!columnExists(d, 'automations', 'vendor')) {
    d.exec(`ALTER TABLE automations ADD COLUMN vendor TEXT NOT NULL DEFAULT 'claude'`)
  }
  // v7 (2026-06-09): replace mcp_mode with mode. Add the new column, backfill
  // from the old one for legacy rows, then drop the old column so new INSERTs
  // that write to `mode` don't hit the NOT NULL constraint on `mcp_mode`.
  // DROP COLUMN requires SQLite ≥ 3.35.0 (2021); Node.js ≥ 18 ships it.
  if (!columnExists(d, 'automations', 'mode')) {
    d.exec(`ALTER TABLE automations ADD COLUMN mode TEXT NOT NULL DEFAULT ''`)
    d.exec(`UPDATE automations SET mode = mcp_mode`)
  }
  if (columnExists(d, 'automations', 'mcp_mode')) {
    d.exec(`ALTER TABLE automations DROP COLUMN mcp_mode`)
  }
  // v8 (2026-06-20): execution timeout is a first-class automation setting. Copy
  // the historic type-specific JSON keys once, retaining the original defaults
  // for rows that did not set either key.
  if (!columnExists(d, 'automations', 'max_wall_clock_ms')) {
    d.exec(`ALTER TABLE automations ADD COLUMN max_wall_clock_ms INTEGER`)
    const rows = d.all<{ id: string; type: string; config: string }>(
      `SELECT id, type, config FROM automations`,
    )
    for (const row of rows) {
      try {
        const config = JSON.parse(row.config) as Record<string, unknown>
        const legacy = row.type === 'command' ? config.timeout : config.maxWallClockMs
        if (isValidAutomationMaxWallClockMs(legacy) && legacy !== null) {
          d.run(`UPDATE automations SET max_wall_clock_ms=? WHERE id=?`, legacy, row.id)
        }
      } catch {
        /* A corrupt legacy config keeps its existing type-specific default. */
      }
    }
  }
  if (!columnExists(d, 'automations', 'agent_id')) {
    d.exec(`ALTER TABLE automations ADD COLUMN agent_id TEXT`)
  }
  // v8 (2026-06-20): pr:operation event triggers. event_pr_filter holds the
  // optional PR operation/result filter (JSON) for automations subscribed to the
  // model-published `pr:operation` event. NULL for cron + run-lifecycle rows, so
  // their behaviour is unchanged. Gated on table_info so re-runs no-op.
  if (!columnExists(d, 'automations', 'event_pr_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_pr_filter TEXT`)
  }
  if (!columnExists(d, 'automations', 'event_intent_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_intent_filter TEXT`)
  }
  // v11 (2026-07-04): automation metadata + run-lifecycle sessionKind / metadata
  // event-trigger filters. `metadata` defaults to an empty object for existing
  // rows. `event_session_kind_filter` / `event_metadata_filter` stay NULL for cron
  // and non-run-lifecycle rows. Existing run-lifecycle event automations are
  // backfilled to an explicit ['work'] filter — the persisted equivalent of the
  // removed hardcoded AUTOMATION_TRIGGER_KINDS whitelist — so their behaviour is
  // unchanged (they are NOT widened to automation / discussion / intent sources).
  if (!columnExists(d, 'automations', 'metadata')) {
    d.exec(`ALTER TABLE automations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!columnExists(d, 'automations', 'event_session_kind_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_session_kind_filter TEXT`)
    d.run(
      `UPDATE automations SET event_session_kind_filter=?
         WHERE trigger_type='event' AND event_topic IN ('run:started','run:settled')`,
      JSON.stringify(['work']),
    )
  }
  if (!columnExists(d, 'automations', 'event_metadata_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_metadata_filter TEXT`)
  }
  // v12 (2026-07-13): converge the three per-topic event-trigger filters
  // (event_reason_filter / event_pr_filter / event_intent_filter) plus the
  // run-lifecycle event_metadata_filter into a single generic `event_filter`
  // (JSON GenericEventFilter: { type, statuses?, metadata? }). The legacy
  // columns (event_topic + the four filter columns) are RETAINED as migration
  // input only — runtime reads/writes/matches exclusively through event_filter.
  // The backfill runs in a transaction and only fills rows whose event_filter is
  // still NULL, so re-runs are idempotent and never overwrite a value written by
  // a newer client. A behaviour-preserving projection: the retired columns map to
  // the exact same hit set (topic→type; reason/result/phase→statuses; PR
  // operations→OR metadata conditions on `operation`; run metadata filter→metadata).
  if (!columnExists(d, 'automations', 'event_filter')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_filter TEXT`)
  }
  backfillEventFilter(d)
  // v13 (2026-07-14): `<category>:<action>` event types + multi-row subscriptions.
  // The single `event_filter` becomes a JSON ARRAY column `event_filters` (any-row
  // OR). The action dimension moves out of status/metadata into the type itself:
  // `pr:operation` splits into `pr:create`…`pr:update` (its `metadata.operation`
  // OR conditions become one row per operation), `intent:lifecycle` phases move
  // from `statuses` into `intent:<phase>` rows; "any action" is the `<category>:*`
  // wildcard. `event_filter` is RETAINED as migration input only — runtime
  // reads/writes/matches exclusively through event_filters. Backfill fills only
  // rows whose event_filters is still NULL (idempotent, never overwrites).
  if (!columnExists(d, 'automations', 'event_filters')) {
    d.exec(`ALTER TABLE automations ADD COLUMN event_filters TEXT`)
  }
  backfillEventFilters(d)
}

/** Transaction wrapper for the backfills: commit on success, rollback + rethrow on error. */
function tx<T>(d: Db, fn: () => T): T {
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

/**
 * Legacy row shape read during the v12 event_filter backfill — the retired
 * per-topic columns projected into the generic filter. Kept private to the
 * migration; runtime code reads the current event_filters column only.
 */
interface LegacyFilterRow {
  id: string
  event_topic: string | null
  event_reason_filter: string | null
  event_pr_filter: string | null
  event_intent_filter: string | null
  event_metadata_filter: string | null
}

/**
 * Project one legacy event-trigger row to a {@link GenericEventFilter}, preserving
 * its exact hit set. Returns `null` when the row has no usable `event_topic` (it
 * cannot have matched anything anyway, so it is left un-migrated / inert). Corrupt
 * legacy JSON in any single dimension degrades to "that dimension wildcards" via
 * the tolerant parse helpers — never widening beyond the type, never throwing.
 */
function legacyRowToEventFilter(row: LegacyFilterRow): GenericEventFilter | null {
  const type = typeof row.event_topic === 'string' ? row.event_topic.trim() : ''
  if (!type) return null
  const filter: GenericEventFilter = { type }

  const statuses: string[] = []
  let metadata: EventMetadataFilter | null = null
  if (type === 'run:started' || type === 'run:settled') {
    // reason (run:settled only; run:started carries none) → statuses; run metadata filter → metadata.
    for (const r of parseReasonFilter(row.event_reason_filter) ?? []) statuses.push(r)
    metadata = parseEventMetadataFilter(row.event_metadata_filter)
  } else if (type === 'pr:operation') {
    // PR result → statuses; PR operations → OR conditions on metadata.operation.
    const pr = parsePrFilter(row.event_pr_filter)
    for (const r of pr?.results ?? []) statuses.push(r)
    if (pr?.operations?.length) {
      const conditions: EventMetadataFilterCondition[] = pr.operations.map((op) => ({
        key: 'operation',
        value: op,
      }))
      metadata = { conditions, combinator: 'OR' }
    }
  } else if (type === 'intent:lifecycle') {
    for (const p of parseIntentFilter(row.event_intent_filter)?.phases ?? []) statuses.push(p)
  }

  if (statuses.length) filter.statuses = statuses
  if (metadata && metadata.conditions.length) filter.metadata = metadata
  return filter
}

/**
 * Backfill `event_filter` from the retired per-topic columns for every event
 * automation that has not been migrated yet. Runs inside a transaction: a failure
 * aborts schema init (the caller lets it propagate) rather than starting with a
 * partially-migrated table.
 */
function backfillEventFilter(d: Db): void {
  const rows = d.all<LegacyFilterRow>(
    `SELECT id, event_topic, event_reason_filter, event_pr_filter,
            event_intent_filter, event_metadata_filter
       FROM automations
      WHERE trigger_type = 'event' AND event_filter IS NULL`,
  )
  if (!rows.length) return
  tx(d, () => {
    for (const row of rows) {
      const filter = legacyRowToEventFilter(row)
      if (!filter) continue
      d.run(`UPDATE automations SET event_filter=? WHERE id=?`, JSON.stringify(filter), row.id)
    }
  })
}

/**
 * Backfill `event_filters` from the v12 single `event_filter` for every event
 * automation not migrated yet. The hit-set-preserving projection lives in the
 * shared {@link upgradeV12EventFilter} (also used by the client-side automation
 * import for old export files). Same discipline as {@link backfillEventFilter}:
 * one transaction, corrupt/absent input leaves the row inert (NULL), a failure
 * aborts schema init.
 */
function backfillEventFilters(d: Db): void {
  const rows = d.all<{ id: string; event_filter: string | null }>(
    `SELECT id, event_filter FROM automations
      WHERE trigger_type = 'event' AND event_filters IS NULL AND event_filter IS NOT NULL`,
  )
  if (!rows.length) return
  tx(d, () => {
    for (const row of rows) {
      const filter = parseEventFilter(row.event_filter)
      if (!filter) continue
      const filters = upgradeV12EventFilter(filter)
      d.run(`UPDATE automations SET event_filters=? WHERE id=?`, JSON.stringify(filters), row.id)
    }
  })
}

// ---- Legacy per-topic filter parsers (v12 migration input ONLY) ----
// These read the retired event_reason_filter / event_pr_filter /
// event_intent_filter / event_metadata_filter columns during the one-time
// backfill into the generic `event_filter`. Runtime CRUD no longer calls them.

/** Parse a JSON-array column to a string list; tolerate null/blank/corrupt → `[]`. */
function parseStringList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Parse the event_reason_filter column to a reason list; null/blank/[] → null (= any reason). */
function parseReasonFilter(raw: string | null): RunEndReason[] | null {
  const list = parseStringList(raw).filter(
    (x): x is RunEndReason => x === 'complete' || x === 'error' || x === 'aborted',
  )
  return list.length ? list : null
}

/**
 * Parse the event_pr_filter column to a {@link PrOperationFilter}; null/blank/
 * corrupt → null (= any PR operation). Unknown operation/result values are
 * dropped, and a dimension that ends up empty is omitted so it matches any value.
 */
function parsePrFilter(raw: string | null): PrOperationFilter | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const operations = Array.isArray(obj.operations)
    ? obj.operations.filter((x): x is PrOperation => PR_OPERATIONS.includes(x as PrOperation))
    : []
  const results = Array.isArray(obj.results)
    ? obj.results.filter((x): x is PrOperationResult =>
        PR_OPERATION_RESULTS.includes(x as PrOperationResult),
      )
    : []
  const filter: PrOperationFilter = {}
  if (operations.length) filter.operations = operations
  if (results.length) filter.results = results
  return Object.keys(filter).length ? filter : null
}

function parseIntentFilter(raw: string | null): IntentLifecycleFilter | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { phases?: unknown }
    const phases = Array.isArray(parsed.phases)
      ? parsed.phases.filter((phase): phase is IntentLifecyclePhase =>
          INTENT_LIFECYCLE_PHASES.includes(phase as IntentLifecyclePhase),
        )
      : []
    return phases.length ? { phases } : null
  } catch {
    return null
  }
}

/** Parse the event_metadata_filter column to a {@link EventMetadataFilter}; null/corrupt → null. */
function parseEventMetadataFilter(raw: string | null): EventMetadataFilter | null {
  if (!raw) return null
  try {
    return normalizeEventMetadataFilter(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Parse the generic event_filter column to a {@link GenericEventFilter}; null/blank/corrupt/no-type → null. */
function parseEventFilter(raw: string | null): GenericEventFilter | null {
  if (!raw) return null
  try {
    return normalizeGenericEventFilter(JSON.parse(raw))
  } catch {
    return null
  }
}
