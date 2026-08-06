/**
 * Delivery domain store over the shared {@link Db} (c3.db).
 *
 * Owns the delivery schema (created lazily) and all delivery ledger operations.
 * Sibling to the intent / discussion stores: all ride the one `~/.c3/c3.db`
 * connection, each owning its own tables and a private `schemaReady` flag.
 * Every `workspacePath` is `resolve()`d so it matches the workspace registry
 * key, the runtime `workspacePath`, and the SDK `cwd`.
 *
 * Degradation: when the db is unavailable, reads return empty/null and writes
 * throw (callers surface an error or skip), so c3 keeps running without the
 * delivery feature.
 *
 * `intent_prs.delivery_id` is the delivery's association surface (already
 * created by the intent store's v19→v20 migration): the real-time integration
 * aggregate is derived here by reading that column directly — never persisted,
 * so removing an association or a PR status change can never leave a stale
 * count behind.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Delivery, DeliveryIntegration, DeliveryStatus } from '@ccc/shared/protocol'
import { DELIVERY_STATUSES } from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { pathToId } from '../../state.js'

/**
 * Delivery schema version. Independent of the other stores' versions — all
 * write the single `PRAGMA user_version` and so clobber each other, but the
 * value is informational only: migrations key off `CREATE TABLE IF NOT EXISTS`
 * / partial-index creation, never off the version number.
 */
const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL
                 CHECK(status IN ('planned','integrating','verifying','verified','delivered','cancelled')),
  start_date     INTEGER,
  end_date       INTEGER,
  branch_name    TEXT,
  base_branch    TEXT NOT NULL,
  branch_ready   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_workspace_status ON deliveries(workspace_path, status);
-- 活动状态 (非 delivered/cancelled) 下 (workspace_path, branch_name) 唯一;终态不占位,
-- 允许后续交付复用历史分支名。空分支名不参与冲突 (SQLite 唯一索引视 NULL 互不相等)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_workspace_active_branch
  ON deliveries(workspace_path, branch_name)
  WHERE branch_name IS NOT NULL AND status NOT IN ('delivered','cancelled');
`

let schemaReady = false

/** Return the db with the delivery schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('交付库不可用 (c3.db unavailable)')
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

interface DeliveryRow {
  id: string
  workspace_path: string
  title: string
  description: string
  status: string
  start_date: number | null
  end_date: number | null
  branch_name: string | null
  base_branch: string
  branch_ready: number
  created_at: number
  updated_at: number
}

/**
 * Real-time "集成就绪 N/M" for a delivery, derived from `intent_prs` rows
 * whose `delivery_id` points at it: M = associated intents (one PR row per
 * intent per delivery, enforced by `idx_intent_pr_delivery`), N = those whose
 * PR toward this delivery is `merged`. Never persisted.
 */
export function integrationAggregate(deliveryId: string): DeliveryIntegration {
  const d = db()
  if (!d) return { merged: 0, total: 0 }
  // `intent_prs` is owned by the intent store's schema ensure and may not have
  // been created yet at boot (delivery reads can precede any intent operation).
  // Degrade to 0/0 rather than throw — the moment the intent store initializes
  // (it always does for a live ledger) the aggregate reads real facts.
  const hasPrsTable = d.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intent_prs'")
  if (!hasPrsTable) return { merged: 0, total: 0 }
  const row = d.get<{ total: number; merged: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END), 0) AS merged
     FROM intent_prs WHERE delivery_id = ?`,
    deliveryId,
  )
  return { total: row?.total ?? 0, merged: row?.merged ?? 0 }
}

function toDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    workspaceId: pathToId(r.workspace_path)!,
    title: r.title,
    description: r.description,
    status: r.status as DeliveryStatus,
    startDate: r.start_date,
    endDate: r.end_date,
    branchName: r.branch_name,
    baseBranch: r.base_branch,
    branchReady: r.branch_ready === 1,
    integration: integrationAggregate(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** A workspace's deliveries, most-recently-updated first. */
export function listDeliveries(workspacePath: string): Delivery[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  const rows = d.all<DeliveryRow>(
    'SELECT * FROM deliveries WHERE workspace_path=? ORDER BY updated_at DESC, rowid DESC',
    proj,
  )
  return rows.map(toDelivery)
}

export function getDelivery(id: string): Delivery | null {
  const d = db()
  if (!d) return null
  const row = d.get<DeliveryRow>('SELECT * FROM deliveries WHERE id=?', id)
  return row ? toDelivery(row) : null
}

export interface CreateDeliveryInput {
  workspacePath: string
  title: string
  description: string
  startDate: number | null
  endDate: number | null
  /**
   * The workspace's effective main branch, snapshotted at create time by the
   * caller (never an empty string) — later config changes must not re-point an
   * existing delivery at a branch it was never based on.
   */
  baseBranch: string
}

export interface CreateDeliveryResult {
  delivery: Delivery
  /**
   * True only when this is the workspace's FIRST delivery ever — decided inside
   * the create transaction (an existing `deliveries` row for the workspace,
   * including cancelled ones, means it is not first), so concurrent creates
   * cannot both claim the one-time `pr:merge` notice.
   */
  prMergeNotice: boolean
}

/**
 * Insert a delivery (status `planned`, `branch_ready` false) and return it with
 * the first-delivery notice flag. Pure local data action — no git / forge /
 * network. Insert + first-check share one transaction.
 */
export function createDelivery(input: CreateDeliveryInput): CreateDeliveryResult {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const proj = resolve(input.workspacePath)
  return tx(d, () => {
    const existing = d.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM deliveries WHERE workspace_path=?',
      proj,
    )
    const prMergeNotice = (existing?.c ?? 0) === 0
    d.run(
      `INSERT INTO deliveries
         (id, workspace_path, title, description, status, start_date, end_date,
          branch_name, base_branch, branch_ready, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      proj,
      input.title,
      input.description,
      'planned',
      input.startDate,
      input.endDate,
      null,
      input.baseBranch,
      0,
      now,
      now,
    )
    return { delivery: getDelivery(id)!, prMergeNotice }
  })
}

export interface UpdateDeliveryInput {
  title?: string
  description?: string
  startDate?: number | null
  endDate?: number | null
}

/** Edit a delivery's data fields (status untouched). Returns null if unknown. */
export function updateDelivery(id: string, input: UpdateDeliveryInput): Delivery | null {
  const d = requireDb()
  const existing = d.get<DeliveryRow>('SELECT * FROM deliveries WHERE id=?', id)
  if (!existing) return null
  d.run(
    `UPDATE deliveries SET title=?, description=?, start_date=?, end_date=?, updated_at=?
     WHERE id=?`,
    input.title ?? existing.title,
    input.description ?? existing.description,
    input.startDate !== undefined ? input.startDate : existing.start_date,
    input.endDate !== undefined ? input.endDate : existing.end_date,
    Date.now(),
    id,
  )
  return getDelivery(id)
}

/**
 * Apply a status write. The caller MUST have already passed
 * `canTransitionDelivery` — this store never re-derives the state machine (the
 * single gate is the feature's transition handler). Returns null if unknown.
 */
export function setDeliveryStatus(id: string, status: DeliveryStatus): Delivery | null {
  const d = requireDb()
  const prior = d.get<{ status: string }>('SELECT status FROM deliveries WHERE id=?', id)
  if (!prior) return null
  if (prior.status !== status) {
    d.run('UPDATE deliveries SET status=?, updated_at=? WHERE id=?', status, Date.now(), id)
  }
  return getDelivery(id)
}

/** Whether `status` is a delivery status the ledger accepts (wire closed-set). */
export function isDeliveryStatus(status: string): status is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(status)
}
