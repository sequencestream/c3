/**
 * Local-only park funnel observation over the shared {@link Db} (c3.db).
 *
 * Owns exactly one table, `funnel_event`, which records park STATE TRANSITIONS
 * and nothing else. It exists to answer a single question — "after an intent is
 * parked, how often does a human actually bring it back?" — so the batch of park
 * guidance can be judged on evidence instead of impressions.
 *
 * The hard boundary this module enforces: **no free text, ever**. The table has
 * six columns and every one of them is an id, a closed enum or a timestamp.
 * `stage` and `reason_code` are validated against their allowed sets at the write
 * boundary, so `parkDetail`, an intent title or a log summary cannot reach it
 * even by being passed to the wrong argument. That is deliberate — a table that
 * structurally cannot hold prose can never be repurposed into telemetry.
 *
 * Nothing here is sent anywhere. The data lives in the local c3.db, rolls off
 * after 90 days, and is read back by exactly one read-only settings panel.
 *
 * Degradation is deliberately asymmetric. A write that cannot land is a reported
 * no-op: losing an observation costs accuracy only, and must never block, roll
 * back or alter the park/unpark it was observing. A read that cannot run fails
 * loudly instead, so the panel can say "statistics unavailable" — a database
 * that would not open is not the same fact as "this workspace has no samples",
 * and dressing one up as the other invites a decision made on evidence that was
 * never collected.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { QUEUE_REASON_CODES } from '../../kernel/queue/index.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

/** The closed set of transitions worth observing. */
export const FUNNEL_STAGES = ['parked', 'unparked'] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

/**
 * The closed set of reason codes an `unparked` row may carry. Leaving the
 * queue's park vocabulary out of the unpark side keeps the column an enum rather
 * than a place to smuggle a description of why the park ended.
 */
export const UNPARK_REASONS = ['manual_unpark', 'auto_unpark'] as const
export type UnparkReason = (typeof UNPARK_REASONS)[number]

/**
 * The reason code for a HUMAN unpark (the manual "解除 park" control).
 */
export const MANUAL_UNPARK_REASON: UnparkReason = 'manual_unpark'

/**
 * The reason code for an AUTOMATIC unpark — the kernel auto-recovering a
 * failure-ladder park once its dependencies are satisfied. Distinct from the
 * manual code so recovery by the machine stays observable separately.
 */
export const AUTO_UNPARK_REASON: UnparkReason = 'auto_unpark'

/** Rolling retention: rows older than this are deleted, never archived. */
export const FUNNEL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** The observation window a park has to be recovered within to count. */
export const PARK_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000

const STAGE_SET: ReadonlySet<string> = new Set<string>(FUNNEL_STAGES)
const PARK_REASON_SET: ReadonlySet<string> = new Set<string>(QUEUE_REASON_CODES)
const UNPARK_REASON_SET: ReadonlySet<string> = new Set<string>(UNPARK_REASONS)

// `workspace_id` holds the normalized (resolved) workspace path — the same value
// the protocol's opaque `workspaceId` resolves to server-side. The column keeps
// the protocol's name because this table is read back through one read-only
// protocol reply and never joined against the queue tables.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS funnel_event (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_id    TEXT NOT NULL,
  stage        TEXT NOT NULL,
  reason_code  TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_event_workspace_stage_at ON funnel_event(workspace_id, stage, at);
CREATE INDEX IF NOT EXISTS idx_funnel_event_pair ON funnel_event(workspace_id, intent_id, stage);
CREATE INDEX IF NOT EXISTS idx_funnel_event_at ON funnel_event(at);
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

/** Test hook: forget the lazily-created schema flag. */
export function resetFunnelStoreForTests(): void {
  schemaReady = false
}

export function isFunnelStoreAvailable(): boolean {
  return db() !== null
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface AppendFunnelEventInput {
  workspacePath: string
  intentId: string
  stage: FunnelStage
  /**
   * A queue reason code for `parked`; one of the closed {@link UNPARK_REASONS}
   * (`manual_unpark` / `auto_unpark`) for `unparked`.
   */
  reasonCode: string
  /** When the transition was persisted (epoch ms). */
  at: number
}

/**
 * Whether a `(stage, reasonCode)` pair may be stored. The check is deliberately
 * a value-set membership test rather than a type assertion: the point is to stop
 * text that a caller wrongly believes is a code, and a type cannot do that at
 * runtime.
 */
function isAllowedReason(stage: string, reasonCode: string): boolean {
  if (stage === 'parked') return PARK_REASON_SET.has(reasonCode)
  if (stage === 'unparked') return UNPARK_REASON_SET.has(reasonCode)
  return false
}

/**
 * Append one observed transition, after the park state it describes has already
 * been persisted. Returns false when the row was refused or the write failed —
 * callers report it and carry on, because a lost observation must never undo a
 * park or an unpark that really happened.
 */
export function appendFunnelEvent(input: AppendFunnelEventInput): boolean {
  if (!STAGE_SET.has(input.stage) || !isAllowedReason(input.stage, input.reasonCode)) {
    console.error(`[c3:funnel] 拒绝非法漏斗事件(stage=${input.stage}):原因码不在允许集合内,已丢弃`)
    return false
  }
  if (!Number.isFinite(input.at)) {
    console.error('[c3:funnel] 拒绝非法漏斗事件:时间戳不是有限数值,已丢弃')
    return false
  }
  const workspaceId = resolve(input.workspacePath)
  try {
    // Inside the try on purpose: opening the db or materializing the schema can
    // throw too, and that must degrade to a lost observation like any other
    // write failure — never escape into the park/unpark call that triggered it.
    const d = db()
    if (!d) return false
    d.run(
      `INSERT INTO funnel_event (id, workspace_id, intent_id, stage, reason_code, at)
       VALUES (?,?,?,?,?,?)`,
      randomUUID(),
      workspaceId,
      input.intentId,
      input.stage,
      input.reasonCode,
      Math.trunc(input.at),
    )
    pruneExpired(d, input.at)
    return true
  } catch (err) {
    console.error('[c3:funnel] 漏斗事件写入失败(不影响 park/unpark 结果):', err)
    return false
  }
}

/**
 * Drop everything past the retention horizon. Runs on both the write and the
 * read path, so a database nobody has written to in months still cannot serve
 * expired rows. An event exactly at the boundary is kept.
 */
function pruneExpired(d: Db, now: number): void {
  d.run('DELETE FROM funnel_event WHERE at < ?', now - FUNNEL_RETENTION_MS)
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * One workspace's park recovery figures. `rate` is null when no sample has
 * finished its observation window yet — an empty denominator is "not enough
 * samples", never 0%.
 */
export interface ParkRecoveryFigures {
  windowMs: number
  /** Parks old enough to have finished the window (the denominator). */
  eligible: number
  /** Of those, the ones a human brought back inside the window. */
  recovered: number
  /** Parks too recent to judge yet — shown so a small sample cannot read as a verdict. */
  pending: number
  rate: number | null
}

/**
 * Compute one workspace's park→recovery figures at `now`.
 *
 * Sampling: every `parked` row is its own sample, so an intent parked three
 * times contributes three. Its pairing partner is the FIRST `unparked` appended
 * after it for the same workspace and intent — insertion order, not wall clock,
 * because that is what "the unpark that ended this park cycle" actually means. A
 * pair whose duration is negative (a clock that went backwards) or longer than
 * the window is simply not a recovery.
 *
 * Throws when the database is unavailable or the query fails, so the caller can
 * report "statistics unavailable" instead of passing an all-zero row off as a
 * real measurement. Only a table that was actually read and found empty is
 * allowed to read as "no samples".
 */
export function parkRecoveryFigures(workspacePath: string, now: number): ParkRecoveryFigures {
  const d = db()
  if (!d) throw new Error('park recovery statistics unavailable: local database is not open')
  const workspaceId = resolve(workspacePath)
  pruneExpired(d, now)
  const matured = now - PARK_RECOVERY_WINDOW_MS
  const eligible =
    d.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM funnel_event WHERE workspace_id=? AND stage='parked' AND at<=?",
      workspaceId,
      matured,
    )?.n ?? 0
  const pending =
    d.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM funnel_event WHERE workspace_id=? AND stage='parked' AND at>?",
      workspaceId,
      matured,
    )?.n ?? 0
  // The correlated subquery yields the paired unpark's timestamp, or NULL when
  // this park cycle never ended. `NULL - at BETWEEN …` is NULL, i.e. not counted.
  const recovered =
    d.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM funnel_event p
        WHERE p.workspace_id=? AND p.stage='parked' AND p.at<=?
          AND ((SELECT u.at FROM funnel_event u
                 WHERE u.workspace_id=p.workspace_id AND u.intent_id=p.intent_id
                   AND u.stage='unparked' AND u.rowid>p.rowid
                 ORDER BY u.rowid ASC LIMIT 1) - p.at) BETWEEN 0 AND ?`,
      workspaceId,
      matured,
      PARK_RECOVERY_WINDOW_MS,
    )?.n ?? 0
  return {
    windowMs: PARK_RECOVERY_WINDOW_MS,
    eligible,
    recovered,
    pending,
    rate: eligible === 0 ? null : recovered / eligible,
  }
}
