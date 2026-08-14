/**
 * Queue scheduling persistence over the shared {@link Db} (c3.db).
 *
 * Owns three small tables:
 *  - `queue_workspace_state` — whether a workspace's queue is running/paused and
 *    which intents the user force-skipped, so a restart resumes what the user
 *    actually asked for instead of silently going idle.
 *  - `queue_intent_state` — the ONLY per-intent scheduling state that survives a
 *    restart: consecutive failures, backoff deadline, park flag + reason, and the
 *    self-excitation cooldown. Everything else (run phase, current session, gate
 *    results) is re-derived from the ledger and run liveness on every pass.
 *  - `queue_decision_log` — per tick/intent audit of what the kernel chose and
 *    why. Deliberately NOT the automation `automation_execution_logs` table: that
 *    one is metered per automation execution, a different granularity.
 *
 * Degradation: an unavailable db degrades reads to defaults and turns writes into
 * reported no-ops. An in-memory mirror keeps the CURRENT process correct even
 * when writes fail, so a db outage can never relax a gate or replay a launch; the
 * durable copy catches up on the next successful write.
 */
import { randomUUID } from 'node:crypto'
import { workspaceNameFor } from '../../state.js'

const workspaceKey = workspaceNameFor
import type { QueueIntentMeta, QueueReasonCode, QueueRunState } from '../../kernel/queue/index.js'
import { emptyQueueIntentMeta } from '../../kernel/queue/index.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

/** Keep the decision log bounded; older rows are pruned per workspace. */
const DECISION_LOG_RETENTION = 2000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_workspace_state (
  workspace_name TEXT PRIMARY KEY,
  state          TEXT NOT NULL,
  started_at     INTEGER,
  force_skipped  TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_intent_state (
  intent_id      TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  backoff_count  INTEGER NOT NULL DEFAULT 0,
  backoff_until  INTEGER,
  parked         INTEGER NOT NULL DEFAULT 0,
  park_reason    TEXT,
  park_detail    TEXT,
  cooldown_until INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_intent_workspace ON queue_intent_state(workspace_name);
CREATE TABLE IF NOT EXISTS queue_decision_log (
  id             TEXT PRIMARY KEY,
  tick_id        TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  intent_id      TEXT NOT NULL,
  decided_at     INTEGER NOT NULL,
  action         TEXT NOT NULL,
  blocked_gate   TEXT,
  reject_reason  TEXT,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  backoff_count  INTEGER NOT NULL DEFAULT 0,
  next_wakeup_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_decision_workspace ON queue_decision_log(workspace_name, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_decision_intent ON queue_decision_log(intent_id, decided_at DESC);
`

let schemaReady = false

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    schemaReady = true
  }
  return d
}

/** Test hook: forget the lazily-created schema flag and the in-memory mirror. */
export function resetQueueStoreForTests(): void {
  schemaReady = false
  metaMirror.clear()
  controlMirror.clear()
}

export function isQueueStoreAvailable(): boolean {
  return db() !== null
}

// ---------------------------------------------------------------------------
// In-memory mirror
// ---------------------------------------------------------------------------

/** Scoped mirror entry: which workspace an intent's metadata belongs to. */
interface MirroredMeta {
  workspacePath: string
  meta: QueueIntentMeta
}

const metaMirror = new Map<string, MirroredMeta>()
const controlMirror = new Map<string, QueueControlRow>()

export interface QueueControlRow {
  state: QueueRunState
  startedAt: number | null
  forceSkipped: string[]
}

const IDLE_CONTROL: QueueControlRow = { state: 'idle', startedAt: null, forceSkipped: [] }

// ---------------------------------------------------------------------------
// Workspace control state
// ---------------------------------------------------------------------------

interface ControlDbRow {
  state: string
  started_at: number | null
  force_skipped: string
}

/** Read a workspace's queue control state (idle when never started). */
export function getQueueControl(workspacePath: string): QueueControlRow {
  const key = workspaceKey(workspacePath)
  const cached = controlMirror.get(key)
  if (cached) return { ...cached, forceSkipped: [...cached.forceSkipped] }
  const d = db()
  if (!d) return { ...IDLE_CONTROL }
  const row = d.get<ControlDbRow>(
    'SELECT state, started_at, force_skipped FROM queue_workspace_state WHERE workspace_name=?',
    key,
  )
  if (!row) return { ...IDLE_CONTROL }
  const control: QueueControlRow = {
    state: normalizeRunState(row.state),
    startedAt: row.started_at,
    forceSkipped: parseIdList(row.force_skipped),
  }
  controlMirror.set(key, control)
  return { ...control, forceSkipped: [...control.forceSkipped] }
}

/** Persist a workspace's queue control state. Returns false when the db refused. */
export function setQueueControl(workspacePath: string, next: QueueControlRow): boolean {
  const key = workspaceKey(workspacePath)
  controlMirror.set(key, { ...next, forceSkipped: [...next.forceSkipped] })
  const d = db()
  if (!d) return false
  try {
    d.run(
      `INSERT INTO queue_workspace_state (workspace_name, state, started_at, force_skipped, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(workspace_name) DO UPDATE SET
         state=excluded.state,
         started_at=excluded.started_at,
         force_skipped=excluded.force_skipped,
         updated_at=excluded.updated_at`,
      key,
      next.state,
      next.startedAt,
      JSON.stringify(next.forceSkipped),
      Date.now(),
    )
    return true
  } catch (err) {
    console.error('[c3:queue] 队列控制状态写入失败:', err)
    return false
  }
}

/** Every workspace whose queue was left running/paused — the startup reconcile set. */
export function listActiveQueueWorkspaces(): string[] {
  const d = db()
  if (!d) return []
  try {
    const rows = d.all<{ workspace_name: string }>(
      "SELECT workspace_name FROM queue_workspace_state WHERE state IN ('running','paused')",
    )
    return rows.map((r) => r.workspace_name)
  } catch (err) {
    console.error('[c3:queue] 读取活跃队列工作区失败:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Per-intent scheduling metadata
// ---------------------------------------------------------------------------

interface MetaDbRow {
  intent_id: string
  failure_count: number
  backoff_count: number
  backoff_until: number | null
  parked: number
  park_reason: string | null
  park_detail: string | null
  cooldown_until: number | null
  updated_at: number
}

function toMeta(row: MetaDbRow): QueueIntentMeta {
  return {
    intentId: row.intent_id,
    failureCount: row.failure_count,
    backoffCount: row.backoff_count,
    backoffUntil: row.backoff_until,
    parked: row.parked === 1,
    parkReason: (row.park_reason as QueueReasonCode | null) ?? null,
    parkDetail: row.park_detail,
    cooldownUntil: row.cooldown_until,
    updatedAt: row.updated_at,
  }
}

/**
 * All scheduling metadata for a workspace, keyed by intent id. Intents with no
 * row are simply absent — callers read them as zero failures, not parked, no
 * backoff and no cooldown, which is exactly how historic intents behave.
 */
export function getQueueIntentMeta(workspacePath: string): Record<string, QueueIntentMeta> {
  const key = workspaceKey(workspacePath)
  const out: Record<string, QueueIntentMeta> = {}
  const d = db()
  if (d) {
    try {
      for (const row of d.all<MetaDbRow>(
        'SELECT * FROM queue_intent_state WHERE workspace_name=?',
        key,
      )) {
        out[row.intent_id] = toMeta(row)
      }
    } catch (err) {
      console.error('[c3:queue] 读取调度元数据失败:', err)
    }
  }
  // The mirror wins: it holds writes this process made, including ones the db
  // rejected. Without it a failed write would silently reset a failure counter.
  for (const [id, meta] of metaMirror) {
    if (meta.workspacePath === key) out[id] = meta.meta
  }
  return out
}

/** One intent's scheduling metadata (zero-valued when never scheduled). */
export function getQueueIntentMetaById(intentId: string): QueueIntentMeta {
  const mirrored = metaMirror.get(intentId)
  if (mirrored) return mirrored.meta
  const d = db()
  if (!d) return emptyQueueIntentMeta(intentId)
  try {
    const row = d.get<MetaDbRow>('SELECT * FROM queue_intent_state WHERE intent_id=?', intentId)
    return row ? toMeta(row) : emptyQueueIntentMeta(intentId)
  } catch (err) {
    console.error('[c3:queue] 读取调度元数据失败:', err)
    return emptyQueueIntentMeta(intentId)
  }
}

/** Upsert one intent's scheduling metadata. Returns false when the db refused. */
export function putQueueIntentMeta(workspacePath: string, meta: QueueIntentMeta): boolean {
  const key = workspaceKey(workspacePath)
  metaMirror.set(meta.intentId, { workspacePath: key, meta })
  const d = db()
  if (!d) return false
  try {
    d.run(
      `INSERT INTO queue_intent_state
         (intent_id, workspace_name, failure_count, backoff_count, backoff_until,
          parked, park_reason, park_detail, cooldown_until, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(intent_id) DO UPDATE SET
         workspace_name=excluded.workspace_name,
         failure_count=excluded.failure_count,
         backoff_count=excluded.backoff_count,
         backoff_until=excluded.backoff_until,
         parked=excluded.parked,
         park_reason=excluded.park_reason,
         park_detail=excluded.park_detail,
         cooldown_until=excluded.cooldown_until,
         updated_at=excluded.updated_at`,
      meta.intentId,
      key,
      meta.failureCount,
      meta.backoffCount,
      meta.backoffUntil,
      meta.parked ? 1 : 0,
      meta.parkReason,
      meta.parkDetail,
      meta.cooldownUntil,
      meta.updatedAt,
    )
    return true
  } catch (err) {
    console.error('[c3:queue] 调度元数据写入失败:', err)
    return false
  }
}

/** Drop an intent's scheduling metadata (intent deleted). */
export function deleteQueueIntentMeta(intentId: string): void {
  metaMirror.delete(intentId)
  const d = db()
  if (!d) return
  try {
    d.run('DELETE FROM queue_intent_state WHERE intent_id=?', intentId)
    d.run('DELETE FROM queue_decision_log WHERE intent_id=?', intentId)
  } catch (err) {
    console.error('[c3:queue] 删除调度元数据失败:', err)
  }
}

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

export interface QueueDecisionRow {
  id: string
  tickId: string
  workspaceName: string
  intentId: string
  decidedAt: number
  action: string
  blockedGate: string | null
  rejectReason: string | null
  attemptCount: number
  backoffCount: number
  nextWakeupAt: number | null
}

export interface AppendDecisionInput {
  tickId: string
  workspacePath: string
  intentId: string
  decidedAt: number
  action: string
  blockedGate: string | null
  rejectReason: string | null
  attemptCount: number
  backoffCount: number
  nextWakeupAt: number | null
}

/**
 * Append decision rows for one pass. A write failure is reported and swallowed:
 * the log is an audit trail, so losing a row must never relax a gate or cause a
 * second launch — the next tick simply reconciles again.
 */
export function appendQueueDecisions(rows: readonly AppendDecisionInput[]): boolean {
  if (rows.length === 0) return true
  const d = db()
  if (!d) return false
  try {
    for (const r of rows) {
      d.run(
        `INSERT INTO queue_decision_log
           (id, tick_id, workspace_name, intent_id, decided_at, action, blocked_gate,
            reject_reason, attempt_count, backoff_count, next_wakeup_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        r.tickId,
        workspaceKey(r.workspacePath),
        r.intentId,
        r.decidedAt,
        r.action,
        r.blockedGate,
        r.rejectReason,
        r.attemptCount,
        r.backoffCount,
        r.nextWakeupAt,
      )
    }
    pruneDecisionLog(d, workspaceKey(rows[0]!.workspacePath))
    return true
  } catch (err) {
    console.error('[c3:queue] 决策日志写入失败(不放宽任何闸门,下轮 tick 继续对账):', err)
    return false
  }
}

function pruneDecisionLog(d: Db, workspacePath: string): void {
  d.run(
    `DELETE FROM queue_decision_log
      WHERE workspace_name=? AND id NOT IN (
        SELECT id FROM queue_decision_log WHERE workspace_name=?
        ORDER BY decided_at DESC LIMIT ?
      )`,
    workspacePath,
    workspacePath,
    DECISION_LOG_RETENTION,
  )
}

function rowToDecision(r: {
  id: string
  tick_id: string
  workspace_name: string
  intent_id: string
  decided_at: number
  action: string
  blocked_gate: string | null
  reject_reason: string | null
  attempt_count: number
  backoff_count: number
  next_wakeup_at: number | null
}): QueueDecisionRow {
  return {
    id: r.id,
    tickId: r.tick_id,
    workspaceName: r.workspace_name,
    intentId: r.intent_id,
    decidedAt: r.decided_at,
    action: r.action,
    blockedGate: r.blocked_gate,
    rejectReason: r.reject_reason,
    attemptCount: r.attempt_count,
    backoffCount: r.backoff_count,
    nextWakeupAt: r.next_wakeup_at,
  }
}

/** Most recent decisions for a workspace, newest first. */
export function listQueueDecisions(workspacePath: string, limit = 200): QueueDecisionRow[] {
  const d = db()
  if (!d) return []
  try {
    return d
      .all<Parameters<typeof rowToDecision>[0]>(
        `SELECT * FROM queue_decision_log WHERE workspace_name=?
          ORDER BY decided_at DESC, rowid DESC LIMIT ?`,
        workspaceKey(workspacePath),
        limit,
      )
      .map(rowToDecision)
  } catch (err) {
    console.error('[c3:queue] 读取决策日志失败:', err)
    return []
  }
}

/** The latest decision for each of a workspace's intents. */
export function latestQueueDecisionByIntent(
  workspacePath: string,
): Record<string, QueueDecisionRow> {
  const out: Record<string, QueueDecisionRow> = {}
  // Newest-first scan; the first row seen per intent is its latest decision.
  for (const row of listQueueDecisions(workspacePath, DECISION_LOG_RETENTION)) {
    if (!out[row.intentId]) out[row.intentId] = row
  }
  return out
}

/** Most recent decisions for one intent, newest first. */
export function listQueueDecisionsForIntent(intentId: string, limit = 50): QueueDecisionRow[] {
  const d = db()
  if (!d) return []
  try {
    return d
      .all<Parameters<typeof rowToDecision>[0]>(
        `SELECT * FROM queue_decision_log WHERE intent_id=?
          ORDER BY decided_at DESC, rowid DESC LIMIT ?`,
        intentId,
        limit,
      )
      .map(rowToDecision)
  } catch (err) {
    console.error('[c3:queue] 读取意图决策日志失败:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeRunState(raw: string): QueueRunState {
  return raw === 'running' || raw === 'paused' ? raw : 'idle'
}

function parseIdList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}
