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
  GenericEventFilter,
  ModeToken,
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
  SESSION_KINDS,
  eventTypeMatches,
  hasRunLifecycleEventFilter,
  normalizeAutomationMetadata,
  normalizeGenericEventFilters,
} from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron } from '@ccc/shared/cron'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { getTimezone } from '../../kernel/config/index.js'
import { fallbackName } from './naming.js'
import { ensureAutomationSchema } from './store-migrations.js'

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

let schemaReady = false

/** Return the db with the automation schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    ensureAutomationSchema(d)
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

/** Serialize a SessionKind filter to a JSON array for storage; empty/absent → NULL. */
function serializeSessionKindFilter(filter: SessionKind[] | null | undefined): string | null {
  return filter && filter.length ? JSON.stringify(filter) : null
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
  return runningAutomationSessionIdsForWorkspace(workspacePath).length
}

/**
 * The distinct agent session ids of a workspace's automation sessions that
 * currently have a running (`status='running'`) execution log — a live "now"
 * notion, independent of any time range. The Workcenter Dashboard unions these
 * with the non-idle runtime session ids (see `runningRuntimeSessionIdsForWorkspace`)
 * and takes the set size, so a session that is both a live runtime and has a
 * running log counts once. Empty when the db is unavailable.
 */
export function runningAutomationSessionIdsForWorkspace(workspacePath: string): string[] {
  const d = db()
  if (!d) return []
  const rows = d.all<{ vendor_session_id: string }>(
    `SELECT DISTINCT sm.vendor_session_id AS vendor_session_id
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
  return rows.map((r) => r.vendor_session_id)
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
