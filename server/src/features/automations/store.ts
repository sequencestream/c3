/**
 * Automation domain store over the shared {@link Db} (c3.db).
 *
 * Owns the automation schema (created lazily, versioned via `PRAGMA user_version`)
 * and all automation / execution-log operations. Sibling to intent and
 * discussion stores: all ride the one `~/.c3/c3.db` connection, each owning its
 * own tables and a private `schemaReady` flag. Every `workspacePath` arg is
 * `resolve()`d so it matches the workspace registry key.
 *
 * Degradation: when the db is unavailable, reads return empty/null and writes
 * throw (callers surface an error or skip), so c3 keeps running without the
 * automation feature.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { resolveWorkspaceRoot, pathToId } from '../../state.js'
import { isValidAutomationMaxWallClockMs } from '@ccc/shared/protocol'
import type {
  CodexPolicy,
  CreateAutomationInput,
  EventMetadataFilter,
  EventMetadataFilterCondition,
  GenericEventFilter,
  IntentLifecycleFilter,
  IntentLifecyclePhase,
  ModeToken,
  PrOperation,
  PrOperationFilter,
  PrOperationResult,
  RunEndReason,
  Automation,
  AutomationExecutionLog,
  AutomationStatus,
  ScheduleTriggerType,
  AutomationType,
  SessionKind,
  UpdateAutomationInput,
  VendorId,
  WorkspaceMcpConfig,
} from '@ccc/shared/protocol'
import {
  INTENT_LIFECYCLE_PHASES,
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  SESSION_KINDS,
  eventTypeMatches,
  hasRunLifecycleEventFilter,
  normalizeAutomationMetadata,
  normalizeEventMetadataFilter,
  normalizeGenericEventFilter,
  normalizeGenericEventFilters,
  upgradeV12EventFilter,
} from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron } from '@ccc/shared/cron'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { getTimezone } from '../../kernel/config/index.js'
import { fallbackName } from './naming.js'

/**
 * Strip server-owned / dropped keys from a client-supplied config before
 * persisting. `name` and `nameSource` are server-owned (the caller decides the
 * final name via the `nameOverride` / preserve logic in {@link updateAutomation},
 * or the generated name in {@link createAutomation}); `description` is removed
 * entirely (legacy field). Returns a fresh object.
 */
function sanitizeConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {}
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  delete out.name
  delete out.nameSource
  delete out.description
  return out
}

/** Resolved display name + provenance the update path writes into config. */
export interface AutomationNameOverride {
  name: string
  /** `'user'` marks a manually-set name as sticky (auto-naming never overrides it). */
  source: 'user' | 'auto'
}

const AGENT_RECOVERY_ACTION = 'agent_quota_recovery'
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

/**
 * Legacy row shape read during the v12 event_filter backfill — the retired
 * per-topic columns projected into the generic filter. Kept private to the
 * migration; runtime code reads {@link AutomationRow.event_filter} only.
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

let schemaReady = false

/** Return the db with the automation schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    renameLegacyTables(d)
    d.exec(SCHEMA)
    runMigrations(d)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('自动化库不可用 (c3.db unavailable)')
  return d
}

/** Whether the store can be used (db opened). */
export function isStoreAvailable(): boolean {
  return isDbAvailable()
}

/** Test-only: forget the "schema ensured" flag (pair with `resetDbForTests`). */
export function resetStoreForTests(): void {
  schemaReady = false
}

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

// ---- Row shapes ----

interface AutomationRow {
  id: string
  type: string
  config: string
  max_wall_clock_ms: number | null
  workspace_path: string
  trigger_type: string | null
  cron_expression: string
  next_run_at: number | null
  event_topic: string | null
  event_reason_filter: string | null
  event_pr_filter: string | null
  event_intent_filter: string | null
  event_session_kind_filter: string | null
  event_metadata_filter: string | null
  event_filter: string | null
  event_filters: string | null
  metadata: string | null
  status: string
  mode: string
  tool_allowlist: string
  tool_denylist: string
  vendor: string
  agent_id: string | null
  created_at: number
  updated_at: number
}

interface ExecutionLogRow {
  id: string
  automation_id: string
  started_at: number
  finished_at: number | null
  exit_code: number | null
  output: string
  error: string | null
  status: string | null
  session_id: string | null
}

/**
 * Parse the `mode` column: try JSON-object first (CodexPolicy), fall back to
 * plain string (ModeToken for claude, or legacy McpMode for migrated rows).
 */
function parseMode(raw: string | null): ModeToken | CodexPolicy {
  if (!raw) return 'sandboxed' // default for empty/missing
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'sandboxMode' in parsed) {
      return parsed as CodexPolicy
    }
  } catch {
    /* not JSON → treat as plain string */
  }
  return raw
}

/** Serialize mode for DB storage: CodexPolicy → JSON, string → as-is. */
function serializeMode(mode: ModeToken | CodexPolicy): string {
  if (typeof mode === 'object') return JSON.stringify(mode)
  return mode
}

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

// ---- Legacy per-topic filter parsers (v12 migration input ONLY) ----
// These read the retired event_reason_filter / event_pr_filter /
// event_intent_filter / event_metadata_filter columns during the one-time
// backfill into the generic `event_filter`. Runtime CRUD no longer calls them.

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

/** Parse the metadata column (JSON object) to a clean string map; null/corrupt → `{}`. */
function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    return normalizeAutomationMetadata(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** Parse the event_session_kind_filter column to a SessionKind list; null/blank/[] → null. */
function parseSessionKindFilter(raw: string | null): SessionKind[] | null {
  const list = parseStringList(raw).filter((x): x is SessionKind =>
    SESSION_KINDS.includes(x as SessionKind),
  )
  return list.length ? list : null
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

/** Serialize a SessionKind filter to a JSON array for storage; empty/absent → NULL. */
function serializeSessionKindFilter(filter: SessionKind[] | null | undefined): string | null {
  return filter && filter.length ? JSON.stringify(filter) : null
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

/** Parse the event_filters column to subscription rows; null/blank/corrupt/empty → null. */
function parseEventFilters(raw: string | null): GenericEventFilter[] | null {
  if (!raw) return null
  try {
    return normalizeGenericEventFilters(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Serialize subscription rows to JSON for storage; a list that normalizes to
 * empty (or absent) stores NULL. The caller only reaches here for event triggers,
 * whose rows are validated at the handler save boundary.
 */
function serializeEventFilters(filters: GenericEventFilter[] | null | undefined): string | null {
  const normalized = normalizeGenericEventFilters(filters)
  return normalized ? JSON.stringify(normalized) : null
}

function toAutomation(r: AutomationRow): Automation {
  let config: unknown = {}
  try {
    config = JSON.parse(r.config)
  } catch {
    /* ignore corrupt config */
  }
  return {
    id: r.id,
    type: r.type as AutomationType,
    config,
    maxWallClockMs: isValidAutomationMaxWallClockMs(r.max_wall_clock_ms)
      ? r.max_wall_clock_ms
      : null,
    workspaceId: pathToId(r.workspace_path)!,
    triggerType: (r.trigger_type as ScheduleTriggerType | null) ?? 'cron',
    cronExpression: r.cron_expression,
    nextRunAt: r.next_run_at,
    eventFilters: parseEventFilters(r.event_filters),
    eventSessionKindFilter: parseSessionKindFilter(r.event_session_kind_filter),
    metadata: parseMetadata(r.metadata),
    status: r.status as AutomationStatus,
    mode: parseMode(r.mode),
    toolAllowlist: parseStringList(r.tool_allowlist),
    toolDenylist: parseStringList(r.tool_denylist),
    vendor: r.vendor as VendorId,
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toExecutionLog(r: ExecutionLogRow): AutomationExecutionLog {
  return {
    id: r.id,
    automationId: r.automation_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    output: r.output,
    error: r.error,
    status: r.status,
    sessionId: r.session_id,
  }
}

export interface AgentQuotaRecoveryConfig {
  internalAction: typeof AGENT_RECOVERY_ACTION
  agentId: string
  resetAt: number
}

export function isAgentQuotaRecoveryConfig(config: unknown): config is AgentQuotaRecoveryConfig {
  if (!config || typeof config !== 'object') return false
  const record = config as Record<string, unknown>
  return (
    record.internalAction === AGENT_RECOVERY_ACTION &&
    typeof record.agentId === 'string' &&
    typeof record.resetAt === 'number' &&
    Number.isFinite(record.resetAt)
  )
}

export function isAgentQuotaRecoveryAutomation(automation: Automation): boolean {
  return automation.type === 'command' && isAgentQuotaRecoveryConfig(automation.config)
}

// ---- Automations CRUD ----

/** All automations in a workspace, most-recently-updated first. */
export function listAutomations(workspacePath: string): Automation[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  return d
    .all<AutomationRow>(
      'SELECT * FROM automations WHERE workspace_path=? ORDER BY updated_at DESC',
      proj,
    )
    .map(toAutomation)
}

/** Count enabled automations across the installation. */
export function countEnabledAutomations(): number {
  const d = db()
  if (!d) return 0
  const row = d.get<{ n: number }>("SELECT COUNT(*) AS n FROM automations WHERE status='active'")
  return row?.n ?? 0
}

export function getAutomation(id: string): Automation | null {
  const d = db()
  if (!d) return null
  const row = d.get<AutomationRow>('SELECT * FROM automations WHERE id=?', id)
  return row ? toAutomation(row) : null
}

/**
 * Count a workspace's automations — `total` rows and the `active` subset — optionally
 * restricted to rows whose `updated_at` falls in `[startTime, endTime]` (ms epoch;
 * either bound may be omitted). Returns zeros when the db is unavailable.
 */
export function countAutomationsInRange(
  workspacePath: string,
  startTime?: number,
  endTime?: number,
): { total: number; active: number } {
  const d = db()
  if (!d) return { total: 0, active: 0 }
  const where: string[] = ['workspace_path=?']
  const params: (string | number)[] = [resolve(workspacePath)]
  if (startTime != null) {
    where.push('updated_at >= ?')
    params.push(startTime)
  }
  if (endTime != null) {
    where.push('updated_at <= ?')
    params.push(endTime)
  }
  const row = d.get<{ total: number; active: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active
       FROM automations WHERE ${where.join(' AND ')}`,
    ...params,
  )
  return { total: row?.total ?? 0, active: row?.active ?? 0 }
}

/**
 * Number of a workspace's automations that currently have a live (`status='running'`)
 * execution log. A live-"now" notion — independent of any time range. Zero when
 * the db is unavailable.
 */
export function countRunningAutomations(workspacePath: string): number {
  const d = db()
  if (!d) return 0
  const row = d.get<{ count: number }>(
    `SELECT COUNT(DISTINCT s.id) AS count
       FROM automations s
       JOIN automation_execution_logs l ON l.automation_id = s.id
      WHERE s.workspace_path=? AND l.status='running'`,
    resolve(workspacePath),
  )
  return row?.count ?? 0
}

export function countRunningAutomationSessions(workspacePath: string): number {
  const d = db()
  if (!d) return 0
  const row = d.get<{ count: number }>(
    `SELECT COUNT(DISTINCT sm.vendor_session_id) AS count
       FROM session_metadata sm
       JOIN automations s ON sm.owner_kind='automation' AND sm.owner_id=s.id
       JOIN automation_execution_logs l
         ON l.automation_id=s.id AND l.session_id=sm.vendor_session_id
      WHERE sm.workspace_path=?
        AND sm.session_kind='automation'
        AND sm.bound=1
        AND l.status='running'
        AND sm.vendor_session_id IS NOT NULL`,
    resolve(workspacePath),
  )
  return row?.count ?? 0
}

/**
 * Insert a automation with status `active` and return the hydrated row.
 *
 * `generatedName` is the server-derived display name written to `config.name`;
 * the client never supplies a name. When omitted, a deterministic fallback is
 * derived from the task content so `config.name` is always non-empty.
 */
export function createAutomation(input: CreateAutomationInput, generatedName?: string): Automation {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const allowlist = input.toolAllowlist ?? []
  const denylist = input.toolDenylist ?? []
  const vendor = input.vendor ?? 'claude'
  const config = sanitizeConfig(input.config)
  const maxWallClockMs = isValidAutomationMaxWallClockMs(input.maxWallClockMs)
    ? input.maxWallClockMs
    : null
  config.name = (generatedName ?? '').trim() || fallbackName(input.type, input.config)
  // A supplied `initialName` (import path) is a user-chosen title: mark it sticky
  // so a later auto-naming pass never overrides the preserved exported name.
  if (typeof input.initialName === 'string' && input.initialName.trim()) {
    config.nameSource = 'user'
  }
  // Only `'paused'` is honoured as an explicit initial status (the handler rejects
  // any other value); the default stays `'active'` so normal creates are unchanged.
  const status: AutomationStatus = input.initialStatus === 'paused' ? 'paused' : 'active'
  // Event-triggered automations carry no cron and never have a planned next_run_at:
  // they fire from the run lifecycle bus, not the tick loop. Cron automations keep
  // the existing backfill (getDueAutomations filters `next_run_at IS NULL`, so the
  // first run would never fire without it). Invalid crons stay null (never due)
  // rather than throwing and rejecting the create.
  const triggerType: ScheduleTriggerType = input.triggerType ?? 'cron'
  const isEvent = triggerType === 'event'
  const cronExpression = isEvent ? '' : input.cronExpression
  const nextRunAt =
    !isEvent && isValidCron(cronExpression)
      ? computeNextRunAt(cronExpression, now, getTimezone())
      : null
  // The subscription rows are written only for event triggers; cron rows store
  // NULL. At least one valid row is validated at the handler save boundary.
  const normalizedFilters = isEvent ? normalizeGenericEventFilters(input.eventFilters) : null
  const eventFilters = normalizedFilters ? JSON.stringify(normalizedFilters) : null
  // The sessionKind security boundary applies only when some row subscribes the
  // run lifecycle; cron and pure pr/intent rows store NULL.
  const eventSessionKindFilter = hasRunLifecycleEventFilter(normalizedFilters)
    ? serializeSessionKindFilter(input.eventSessionKindFilter)
    : null
  const metadata = JSON.stringify(normalizeAutomationMetadata(input.metadata))
  d.run(
    `INSERT INTO automations
       (id, type, config, max_wall_clock_ms, workspace_path, trigger_type, cron_expression, next_run_at, event_filters, event_session_kind_filter, metadata, status, mode, tool_allowlist, tool_denylist, vendor, agent_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.type,
    JSON.stringify(config),
    maxWallClockMs,
    resolveWorkspaceRoot(input.workspaceId)!,
    triggerType,
    cronExpression,
    nextRunAt,
    eventFilters,
    eventSessionKindFilter,
    metadata,
    status,
    serializeMode(input.mode),
    JSON.stringify(allowlist),
    JSON.stringify(denylist),
    vendor,
    input.type === 'llm' ? (input.agentId ?? null) : null,
    now,
    now,
  )
  return getAutomation(id)!
}

export function createAgentQuotaRecoveryAutomation(input: {
  workspacePath: string
  agentId: string
  resetAt: number
}): Automation {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimezone(),
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(input.resetAt))
  const byType: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') byType[part.type] = Number.parseInt(part.value, 10)
  }
  const automation = createAutomation(
    {
      type: 'command',
      config: {
        internalAction: AGENT_RECOVERY_ACTION,
        agentId: input.agentId,
        resetAt: input.resetAt,
      } satisfies AgentQuotaRecoveryConfig,
      workspaceId: pathToId(input.workspacePath)!,
      cronExpression: `${byType.minute} ${byType.hour} ${byType.day} ${byType.month} *`,
      mode: 'read-only',
      vendor: 'claude',
      toolAllowlist: [],
      toolDenylist: [],
    },
    `Restore agent ${input.agentId}`,
  )
  updateNextRunAt(automation.id, input.resetAt)
  return getAutomation(automation.id) ?? automation
}

/**
 * Partial update of a automation. Only provided fields are changed.
 *
 * `nameOverride` resolves `config.name` on this update (the handler derives it
 * from the client-supplied `config.name`: a non-empty title → `source:'user'`
 * sticky name; a cleared title → a freshly-derived `source:'auto'` name). When
 * omitted, the existing name AND its `nameSource` are preserved — so a body-only
 * update never re-derives, and a manually-set name stays sticky.
 */
export function updateAutomation(
  id: string,
  patch: UpdateAutomationInput,
  nameOverride?: AutomationNameOverride,
): void {
  const d = requireDb()
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.type !== undefined) {
    sets.push('type=?')
    params.push(patch.type)
  }
  if (patch.config !== undefined) {
    // `name`/`nameSource` are server-owned (sanitizeConfig strips any client
    // copy). Resolve them from nameOverride, else preserve the existing values.
    const existing = getAutomation(id)
    const prev =
      existing && existing.config && typeof existing.config === 'object'
        ? (existing.config as Record<string, unknown>)
        : undefined
    const next = sanitizeConfig(patch.config)
    if (nameOverride) {
      next.name = nameOverride.name
      // Only the 'user' marker is persisted; absence means auto (the default).
      if (nameOverride.source === 'user') next.nameSource = 'user'
    } else {
      if (typeof prev?.name === 'string' && prev.name.trim()) next.name = prev.name
      if (prev?.nameSource === 'user') next.nameSource = 'user'
    }
    sets.push('config=?')
    params.push(JSON.stringify(next))
  }
  if (patch.maxWallClockMs !== undefined) {
    sets.push('max_wall_clock_ms=?')
    params.push(patch.maxWallClockMs)
  }
  // Trigger-type switch: clear the fields that don't belong to the new type so a
  // automation never carries stale cron AND event state. Switching to 'event' drops
  // cron + next_run_at; switching to 'cron' drops the event subscription fields.
  // The form only sends the fields matching the chosen type, so no column is set twice.
  if (patch.triggerType !== undefined) {
    sets.push('trigger_type=?')
    params.push(patch.triggerType)
    if (patch.triggerType === 'event') {
      sets.push('cron_expression=?')
      params.push('')
      sets.push('next_run_at=?')
      params.push(null)
    } else {
      sets.push('event_filters=?')
      params.push(null)
      sets.push('event_session_kind_filter=?')
      params.push(null)
    }
  }
  if (patch.cronExpression !== undefined) {
    sets.push('cron_expression=?')
    params.push(patch.cronExpression)
    // Recompute next_run_at so the new cron takes effect on the next tick rather
    // than firing against the previous expression's stale timestamp.
    sets.push('next_run_at=?')
    params.push(
      isValidCron(patch.cronExpression)
        ? computeNextRunAt(patch.cronExpression, Date.now(), getTimezone())
        : null,
    )
  }
  if (patch.eventFilters !== undefined) {
    sets.push('event_filters=?')
    params.push(serializeEventFilters(patch.eventFilters))
  }
  if (patch.metadata !== undefined) {
    sets.push('metadata=?')
    params.push(JSON.stringify(normalizeAutomationMetadata(patch.metadata)))
  }
  if (patch.eventSessionKindFilter !== undefined) {
    sets.push('event_session_kind_filter=?')
    params.push(serializeSessionKindFilter(patch.eventSessionKindFilter))
  }
  // Subscription switch within event mode: when the new rows no longer subscribe
  // any run-lifecycle type, clear the sessionKind security boundary (it only
  // applies to run events). Guarded on the sessionKind field being absent from
  // this patch so a column is set once.
  if (
    patch.eventFilters !== undefined &&
    !hasRunLifecycleEventFilter(normalizeGenericEventFilters(patch.eventFilters)) &&
    patch.eventSessionKindFilter === undefined
  ) {
    sets.push('event_session_kind_filter=?')
    params.push(null)
  }
  if (patch.mode !== undefined) {
    sets.push('mode=?')
    params.push(serializeMode(patch.mode))
  }
  if (patch.vendor !== undefined) {
    sets.push('vendor=?')
    params.push(patch.vendor)
  }
  if (patch.agentId !== undefined) {
    sets.push('agent_id=?')
    params.push(patch.agentId)
  }
  if (patch.toolAllowlist !== undefined) {
    sets.push('tool_allowlist=?')
    params.push(JSON.stringify(patch.toolAllowlist))
  }
  if (patch.toolDenylist !== undefined) {
    sets.push('tool_denylist=?')
    params.push(JSON.stringify(patch.toolDenylist))
  }
  if (patch.status !== undefined) {
    sets.push('status=?')
    params.push(patch.status)
  }

  if (sets.length > 0) {
    sets.push('updated_at=?')
    params.push(Date.now())
    params.push(id)
    d.run(`UPDATE automations SET ${sets.join(', ')} WHERE id=?`, ...params)
  }
}

/** Delete a automation and its execution logs. */
export function deleteAutomation(id: string): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM automation_execution_logs WHERE automation_id=?', id)
    d.run('DELETE FROM automations WHERE id=?', id)
  })
}

/** Get a automation plus its execution logs. */
export function getAutomationDetail(id: string): {
  automation: Automation | null
  logs: AutomationExecutionLog[]
} {
  const d = db()
  if (!d) return { automation: null, logs: [] }
  const automation = getAutomation(id)
  const logs = listExecutionLogs(id)
  return { automation, logs }
}

// ---- Scheduler queries ----

/** Query all active automations whose next_run_at is due (<= now). */
export function getDueAutomations(now: number): Automation[] {
  const d = db()
  if (!d) return []
  return d
    .all<AutomationRow>(
      'SELECT * FROM automations WHERE status = ? AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC',
      'active',
      now,
    )
    .map(toAutomation)
}

/**
 * All active event-triggered automations with a subscription row accepting
 * `type` (exact, or a `<category>:*` wildcard row). The rows live inside the
 * `event_filters` JSON (no dedicated indexed column), so the SQL selects every
 * active event row and the type prefilter is applied in JS after parsing; the
 * per-installation event-automation set is small. Cron and inactive rows are
 * excluded by the query; the full status/metadata match runs in the dispatcher.
 */
export function getEventAutomations(type: string): Automation[] {
  const d = db()
  if (!d) return []
  return d
    .all<AutomationRow>("SELECT * FROM automations WHERE status='active' AND trigger_type='event'")
    .map(toAutomation)
    .filter((a) => a.eventFilters?.some((f) => eventTypeMatches(f.type, type)))
}

/** Update a automation's next_run_at after a successful execution. */
export function updateNextRunAt(id: string, nextRunAt: number | null): void {
  const d = requireDb()
  d.run('UPDATE automations SET next_run_at=?, updated_at=? WHERE id=?', nextRunAt, Date.now(), id)
}

/**
 * Pause all automations under a given workspace path.
 * Used by archiver.ts when a workspace is removed.
 */
export function pauseAllForWorkspace(workspacePath: string): void {
  const d = requireDb()
  const abs = resolve(workspacePath)
  d.run(
    'UPDATE automations SET status=?, updated_at=? WHERE workspace_path=? AND status=?',
    'paused',
    Date.now(),
    abs,
    'active',
  )
}

/**
 * Update an execution log's fields (status, output, error, exit_code, finished_at).
 * Only provided fields are changed.
 */
export function updateExecutionLog(
  id: string,
  patch: {
    status?: string
    output?: string
    error?: string | null
    exitCode?: number | null
    finishedAt?: number | null
    sessionId?: string | null
  },
): void {
  const d = requireDb()
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.status !== undefined) {
    sets.push('status=?')
    params.push(patch.status)
  }
  if (patch.output !== undefined) {
    sets.push('output=?')
    params.push(patch.output)
  }
  if (patch.error !== undefined) {
    sets.push('error=?')
    params.push(patch.error)
  }
  if (patch.exitCode !== undefined) {
    sets.push('exit_code=?')
    params.push(patch.exitCode)
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at=?')
    params.push(patch.finishedAt)
  }
  if (patch.sessionId !== undefined) {
    sets.push('session_id=?')
    params.push(patch.sessionId)
  }

  if (sets.length === 0) return
  params.push(id)
  d.run(`UPDATE automation_execution_logs SET ${sets.join(', ')} WHERE id=?`, ...params)
}

// ---- Execution logs ----

/** Append an execution log entry for a automation with `running` status. */
export function appendExecutionLog(
  input: Omit<AutomationExecutionLog, 'id' | 'status' | 'sessionId'> & {
    status?: string | null
    sessionId?: string | null
  },
): AutomationExecutionLog {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  d.run(
    `INSERT INTO automation_execution_logs
       (id, automation_id, started_at, finished_at, exit_code, output, error, status, session_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.automationId,
    input.startedAt,
    input.finishedAt ?? null,
    input.exitCode ?? null,
    input.output ?? '',
    input.error ?? null,
    input.status ?? 'running',
    input.sessionId ?? null,
  )
  // Refresh the parent automation's updated_at so list ordering reflects activity.
  d.run('UPDATE automations SET updated_at=? WHERE id=?', now, input.automationId)
  return { id, ...input, status: input.status ?? 'running', sessionId: input.sessionId ?? null }
}

/** Get a single execution log by id (null if absent or db unavailable). */
export function getExecutionLog(id: string): AutomationExecutionLog | null {
  const d = db()
  if (!d) return null
  const row = d.get<ExecutionLogRow>('SELECT * FROM automation_execution_logs WHERE id=?', id)
  return row ? toExecutionLog(row) : null
}

/** All execution logs for a automation, most-recently-started first. */
export function listExecutionLogs(automationId: string): AutomationExecutionLog[] {
  const d = db()
  if (!d) return []
  return d
    .all<ExecutionLogRow>(
      'SELECT * FROM automation_execution_logs WHERE automation_id=? ORDER BY started_at DESC',
      automationId,
    )
    .map(toExecutionLog)
}

// ---- Workspace MCP configs ----

interface WorkspaceMcpConfigRow {
  workspace_path: string
  config_json: string
  updated_at: number
}

function toWorkspaceMcpConfig(r: WorkspaceMcpConfigRow): WorkspaceMcpConfig {
  let config: WorkspaceMcpConfig = { mcpServers: {}, denylist: [] }
  try {
    const parsed = JSON.parse(r.config_json)
    if (parsed && typeof parsed === 'object') {
      config = {
        mcpServers: parsed.mcpServers ?? {},
        denylist: Array.isArray(parsed.denylist)
          ? parsed.denylist.filter((x: unknown): x is string => typeof x === 'string')
          : [],
      }
    }
  } catch {
    /* ignore corrupt config */
  }
  return config
}

/** Get workspace-level MCP configuration (empty default if not set). */
export function getWorkspaceMcpConfig(workspacePath: string): WorkspaceMcpConfig {
  const d = db()
  if (!d) return { mcpServers: {}, denylist: [] }
  const abs = resolve(workspacePath)
  const row = d.get<WorkspaceMcpConfigRow>(
    'SELECT * FROM workspace_mcp_configs WHERE workspace_path=?',
    abs,
  )
  if (!row) return { mcpServers: {}, denylist: [] }
  return toWorkspaceMcpConfig(row)
}

/** Save workspace-level MCP configuration (upsert). */
export function saveWorkspaceMcpConfig(workspacePath: string, config: WorkspaceMcpConfig): void {
  const d = requireDb()
  const abs = resolve(workspacePath)
  const now = Date.now()
  const json = JSON.stringify({
    mcpServers: config.mcpServers ?? {},
    denylist: config.denylist ?? [],
  })
  d.run(
    `INSERT INTO workspace_mcp_configs (workspace_path, config_json, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(workspace_path) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`,
    abs,
    json,
    now,
  )
}
