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
 * count behind. `delivery_prs` is a SEPARATE table for a separate entity — the
 * PR that carries the whole delivery into mainline — and never feeds that
 * aggregate.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  AssociatedIntent,
  Delivery,
  DeliveryIntegration,
  DeliveryPr,
  DeliveryPrBlockedReason,
  DeliveryStatus,
  IntentPrForge,
  IntentPrStatus,
  IntentStatus,
} from '@ccc/shared/protocol'
import { DELIVERY_STATUSES } from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { pathToId } from '../../state.js'

/**
 * Delivery schema version. Independent of the other stores' versions — all
 * write the single `PRAGMA user_version` and so clobber each other, but the
 * value is informational only: migrations key off `CREATE TABLE IF NOT EXISTS`
 * / partial-index creation, never off the version number.
 */
const SCHEMA_VERSION = 2

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

-- 意图 ↔ 交付关联边。与 intent_prs.delivery_id 职责分离: 后者记录「这个意图对某个
-- 交付开了哪条 PR」, 本表记录「这个意图属于哪个交付」—— 关联先于 PR 存在, 且解除
-- 关联要独立于 PR 行的生死。同一 DDL 也由意图 store 声明 (双 store 声明), 保证从未
-- 用过交付的库删除意图时 DELETE FROM intent_deliveries 不会撞上 "no such table"。
CREATE TABLE IF NOT EXISTS intent_deliveries (
  id          TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  intent_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_delivery_unique
  ON intent_deliveries(delivery_id, intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_delivery_delivery ON intent_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_intent_delivery_intent ON intent_deliveries(intent_id);

-- 交付 PR:「交付分支 → 主线」的变更请求。与 intent_prs 分表而非共表 —— 两者粒度
-- (交付→主线 vs 意图→交付分支) 与生命周期 (集成聚合计数、解除关联删行) 都不同,
-- 同表会让「哪条 PR 表达交付上主线」这个问题失去精确答案:integrationAggregate 按
-- delivery_id 计数,交付 PR 一旦混进去就会把交付自己算进「关联意图数」。
CREATE TABLE IF NOT EXISTS delivery_prs (
  id             TEXT PRIMARY KEY,
  delivery_id    TEXT NOT NULL,
  forge          TEXT,
  repo           TEXT,
  number         TEXT NOT NULL,
  url            TEXT,
  head_branch    TEXT NOT NULL,
  base_branch    TEXT NOT NULL,
  base_sha       TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('reviewing','merged','closed')),
  blocked_reason TEXT CHECK(blocked_reason IN ('ci_failed','approval')),
  conflict_files TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
-- 一条真实 PR 一行 (与 intent_prs 同口径:forge/repo 可空的历史行不参与身份约束)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_identity ON delivery_prs(forge, repo, number);
-- 幂等键兜底:同一交付的同一 (base, head) 快照只允许一条 PR 行。应用层先查 forge
-- 事实再落账,索引是并发重试的最后一道。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_idempotency
  ON delivery_prs(delivery_id, base_sha, head_sha);
CREATE INDEX IF NOT EXISTS idx_delivery_pr_delivery ON delivery_prs(delivery_id, created_at DESC);

-- 交付操作审计轨迹,只增不改 (仿 intent_logs)。delivered 的状态写与它的日志行在
-- 同一事务里落定,所以「代码进了主线但没留痕」不可能出现。
CREATE TABLE IF NOT EXISTS delivery_logs (
  id             TEXT PRIMARY KEY,
  delivery_id    TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  summary        TEXT NOT NULL,
  actor          TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_log_delivery_created
  ON delivery_logs(delivery_id, created_at DESC);
`

/**
 * The connection this store last ensured its schema against — NOT a boolean.
 * A plain "ensured once" flag survives `resetDbForTests()`, which hands out a
 * BRAND NEW connection to a brand new file; the store would then read tables it
 * never created there. Keying on the connection identity makes the ensure
 * re-run exactly when the connection changes, which is also the only time it
 * needs to.
 */
let schemaReadyFor: Db | null = null

/** Return the db with the delivery schema ensured, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    d.exec(SCHEMA)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReadyFor = d
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
  schemaReadyFor = null
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

/**
 * Whether another ACTIVE delivery (status not `delivered`/`cancelled`, and not
 * `excludeId` — the caller's own retry) already holds `branchName` in this
 * workspace. Backs the `delivery.branchConflict` verdict on `bind`; the unique
 * partial index `idx_delivery_workspace_active_branch` is the DB-level backstop.
 */
export function activeDeliveryHoldsBranch(
  workspacePath: string,
  branchName: string,
  excludeId: string,
): boolean {
  const d = db()
  if (!d) return false
  const proj = resolve(workspacePath)
  const row = d.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM deliveries
     WHERE workspace_path=? AND branch_name=? AND id<>?
       AND status NOT IN ('delivered','cancelled')`,
    proj,
    branchName,
    excludeId,
  )
  return (row?.c ?? 0) > 0
}

/**
 * Record a delivery's branch as initialized — sets `branch_name` + `branch_ready`
 * in one write. Called ONLY after the git side succeeded (a push on the create
 * path, or a verified remote existence on the bind / orphan-idempotent paths);
 * a push success whose DB write then fails is recovered by the next retry via
 * the orphan-defense match. Returns null if unknown.
 */
export function setDeliveryBranch(id: string, branchName: string, ready: boolean): Delivery | null {
  const d = requireDb()
  const existing = d.get<DeliveryRow>('SELECT * FROM deliveries WHERE id=?', id)
  if (!existing) return null
  d.run(
    'UPDATE deliveries SET branch_name=?, branch_ready=?, updated_at=? WHERE id=?',
    branchName,
    ready ? 1 : 0,
    Date.now(),
    id,
  )
  return getDelivery(id)
}

/**
 * Clear a delivery's local branch reference (`branch_name` → NULL,
 * `branch_ready` → 0) — the manual cleanup of a TERMINAL delivery. Never touches
 * the remote branch; releasing the name also frees the active-branch uniqueness
 * for a later delivery to reuse the same name. Returns null if unknown.
 */
export function clearDeliveryBranch(id: string): Delivery | null {
  const d = requireDb()
  const existing = d.get<DeliveryRow>('SELECT * FROM deliveries WHERE id=?', id)
  if (!existing) return null
  d.run(
    'UPDATE deliveries SET branch_name=NULL, branch_ready=0, updated_at=? WHERE id=?',
    Date.now(),
    id,
  )
  return getDelivery(id)
}

// ---------------------------------------------------------------------------
// intent_deliveries — the intent ↔ delivery association edge
//
// The edge is what every delivery guard and the N/M aggregate ultimately hang
// off. It lives here (not in the intent store) because its whole lifecycle is
// delivery context: created by a delivery-domain link, refused for a merged PR,
// and read back as the delivery's associated-intent list.
// ---------------------------------------------------------------------------

/** Whether `table` exists yet (the intent store creates its tables lazily). */
function hasTable(d: Db, table: string): boolean {
  return !!d.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
}

/** Whether this exact (delivery, intent) edge already exists. */
export function isIntentLinked(deliveryId: string, intentId: string): boolean {
  const d = db()
  if (!d) return false
  return !!d.get(
    'SELECT 1 FROM intent_deliveries WHERE delivery_id=? AND intent_id=? LIMIT 1',
    deliveryId,
    intentId,
  )
}

/** How many deliveries this intent is currently linked to. */
function countIntentLinks(d: Db, intentId: string): number {
  return (
    d.get<{ n: number }>('SELECT COUNT(*) AS n FROM intent_deliveries WHERE intent_id=?', intentId)
      ?.n ?? 0
  )
}

/**
 * Write an intent's base-branch snapshot. Lives in the delivery store — not the
 * intent store — because it may only ever run in the SAME transaction as the
 * association edge that justifies it: an edge without its snapshot, or a
 * snapshot without its edge, is the exact drift `intents.base_branch` exists to
 * remove. Same precedent as {@link deleteIntentPr}, which likewise writes an
 * intent-domain table on a delivery-domain action.
 *
 * `intents` is created lazily by the intent store; a delivery-only database has
 * no rows to update, so a missing table is a no-op rather than a failure.
 */
function writeIntentBaseBranch(d: Db, intentId: string, branch: string): void {
  if (!hasTable(d, 'intents')) return
  d.run('UPDATE intents SET base_branch=? WHERE id=?', branch, intentId)
}

/**
 * Create the association edge. Returns false when the pair is ALREADY linked
 * (the caller surfaces `delivery.intentAlreadyLinked`) — checked in the same
 * transaction as the insert, so a concurrent duplicate hits the unique index
 * `idx_intent_delivery_unique` and rolls back rather than creating a second row.
 *
 * `deliveryBranch` is the delivery's ready branch, or null when it has none yet.
 * On the intent's FIRST link it becomes the intent's base-branch snapshot, in
 * this same transaction. A later link never touches the snapshot: link order is
 * not a decision about which delivery the intent is built on, and a second
 * delivery's branch would silently re-point an intent already developed against
 * the first. An unready delivery keeps the previous mainline snapshot — an
 * unborn branch is not something to build on — and gets picked up when its
 * branch becomes ready.
 */
export function insertIntentDelivery(
  deliveryId: string,
  intentId: string,
  deliveryBranch: string | null,
): boolean {
  const d = requireDb()
  return tx(d, () => {
    if (isIntentLinked(deliveryId, intentId)) return false
    d.run(
      'INSERT INTO intent_deliveries (id, delivery_id, intent_id, created_at) VALUES (?,?,?,?)',
      randomUUID(),
      deliveryId,
      intentId,
      Date.now(),
    )
    const branch = deliveryBranch?.trim()
    if (branch && countIntentLinks(d, intentId) === 1) writeIntentBaseBranch(d, intentId, branch)
    return true
  })
}

/**
 * Drop the association edge. Returns false when there was nothing to drop.
 *
 * Losing the LAST link returns the intent's base-branch snapshot to
 * `mainlineBranch` in the same transaction — an intent that belongs to no
 * delivery is built on the workspace mainline again. While other links remain
 * the snapshot is kept: which of them it should point at is not something the
 * removal of a different edge can answer.
 */
export function deleteIntentDelivery(
  deliveryId: string,
  intentId: string,
  mainlineBranch: string,
): boolean {
  const d = requireDb()
  return tx(d, () => {
    if (!isIntentLinked(deliveryId, intentId)) return false
    d.run('DELETE FROM intent_deliveries WHERE delivery_id=? AND intent_id=?', deliveryId, intentId)
    if (countIntentLinks(d, intentId) === 0) writeIntentBaseBranch(d, intentId, mainlineBranch)
    return true
  })
}

/**
 * A delivery branch has just become ready: adopt it as the base-branch snapshot
 * of every intent that is linked to THIS delivery and to no other. Returns the
 * intents actually updated, so the caller knows whether the intent read model
 * needs re-broadcasting.
 *
 * This is the one lifecycle catch-up the snapshot allows. Without it an intent
 * linked before its delivery's branch existed would keep the mainline snapshot
 * forever, and a worktree created afterwards would faithfully root on the wrong
 * branch — a mistake the existing baseline guard cannot even detect, because
 * mainline IS contained in the delivery branch's history.
 *
 * It is not a subscription to the delivery branch: a branch that is later
 * advanced, renamed or rebuilt does not re-run this. Being called again for an
 * already-ready branch writes the same value, so a repeated idempotent
 * initialisation cannot produce a different outcome. An intent that has since
 * gained a second delivery, or dropped this one, is left alone.
 */
export function adoptReadyDeliveryBranchAsIntentBase(
  deliveryId: string,
  branchName: string,
): string[] {
  const d = requireDb()
  const branch = branchName.trim()
  if (!branch) return []
  return tx(d, () => {
    const rows = d.all<{ intent_id: string }>(
      'SELECT intent_id FROM intent_deliveries WHERE delivery_id=?',
      deliveryId,
    )
    const updated: string[] = []
    for (const r of rows) {
      if (countIntentLinks(d, r.intent_id) !== 1) continue
      writeIntentBaseBranch(d, r.intent_id, branch)
      updated.push(r.intent_id)
    }
    return updated
  })
}

/**
 * Delete the `intent_prs` row for one intent's PR toward one delivery. Called
 * after that PR was successfully closed on the forge during an unlink.
 *
 * The row is DELETED rather than kept as `closed`: a kept row would still be
 * counted by {@link integrationAggregate} (which counts by `delivery_id`), so
 * `total` would include the unlinked intent forever and `merged < total` would
 * permanently block the delivery. Clearing `delivery_id` to NULL instead would
 * collide with `idx_intent_pr_intent_nodelivery` whenever the intent already
 * holds a delivery-less PR row. Deleting is the only option that leaves no
 * orphan, breaks no unique index, and does not skew the aggregate.
 */
export function deleteIntentPr(intentId: string, deliveryId: string): void {
  const d = requireDb()
  if (!hasTable(d, 'intent_prs')) return
  d.run('DELETE FROM intent_prs WHERE intent_id=? AND delivery_id=?', intentId, deliveryId)
}

/**
 * The intents linked to a delivery, by title.
 *
 * `prStatus` / `headBranch` / `prNumber` / `prUrl` come from the `intent_prs`
 * row whose `delivery_id` is THIS delivery — never the intent's global PR
 * state, which would show another delivery's PR in this delivery's list.
 *
 * `intents` / `intent_prs` are owned by the intent store and created lazily, so
 * a delivery read that precedes any intent operation degrades to `[]` (same
 * precedent as {@link integrationAggregate}). `intent_deliveries` itself is in
 * this store's own schema ensure and always exists.
 */
export function listAssociatedIntents(deliveryId: string): AssociatedIntent[] {
  const d = db()
  if (!d) return []
  if (!hasTable(d, 'intents')) return []
  const hasPrs = hasTable(d, 'intent_prs')
  const rows = d.all<{
    id: string
    title: string
    status: string
    pr_status: string | null
    head_branch: string | null
    pr_number: string | null
    pr_url: string | null
  }>(
    `SELECT i.id            AS id,
            i.title         AS title,
            i.status        AS status,
            ${hasPrs ? 'p.status' : 'NULL'}      AS pr_status,
            ${hasPrs ? 'p.head_branch' : 'NULL'} AS head_branch,
            ${hasPrs ? 'p.number' : 'NULL'}      AS pr_number,
            ${hasPrs ? 'p.url' : 'NULL'}         AS pr_url
       FROM intent_deliveries e
       JOIN intents i ON i.id = e.intent_id
       ${hasPrs ? 'LEFT JOIN intent_prs p ON p.intent_id = e.intent_id AND p.delivery_id = e.delivery_id' : ''}
      WHERE e.delivery_id = ?
      ORDER BY i.title ASC, i.id ASC`,
    deliveryId,
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as IntentStatus,
    prStatus: (r.pr_status as IntentPrStatus | null) ?? null,
    headBranch: r.head_branch ?? null,
    prNumber: r.pr_number ?? null,
    prUrl: r.pr_url ?? null,
  }))
}

// ---------------------------------------------------------------------------
// delivery_prs — the「交付分支 → 主线」PR, and delivery_logs — the audit trail
// ---------------------------------------------------------------------------

interface DeliveryPrRow {
  id: string
  delivery_id: string
  forge: string | null
  repo: string | null
  number: string
  url: string | null
  head_branch: string
  base_branch: string
  base_sha: string
  head_sha: string
  status: string
  blocked_reason: string | null
  conflict_files: string | null
  created_at: number
  updated_at: number
}

/** Parse the stored JSON array, degrading to `[]` for null / malformed content. */
function parseConflictFiles(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

function toDeliveryPr(r: DeliveryPrRow): DeliveryPr {
  return {
    deliveryId: r.delivery_id,
    forge: (r.forge as IntentPrForge | null) ?? null,
    repo: r.repo,
    number: r.number,
    url: r.url,
    headBranch: r.head_branch,
    baseBranch: r.base_branch,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    status: r.status as DeliveryPr['status'],
    blockedReason: (r.blocked_reason as DeliveryPrBlockedReason | null) ?? null,
    conflictFiles: parseConflictFiles(r.conflict_files),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * The delivery's most recent delivery PR, or `null` when it never opened one.
 * Older rows stay as history — a superseded PR is a fact about what happened,
 * not garbage — and only this one is ever rendered.
 */
export function getLatestDeliveryPr(deliveryId: string): DeliveryPr | null {
  const d = db()
  if (!d) return null
  const row = d.get<DeliveryPrRow>(
    'SELECT * FROM delivery_prs WHERE delivery_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    deliveryId,
  )
  return row ? toDeliveryPr(row) : null
}

export interface UpsertDeliveryPrInput {
  deliveryId: string
  forge: IntentPrForge | null
  repo: string | null
  number: string
  url: string | null
  headBranch: string
  baseBranch: string
  baseSha: string
  headSha: string
  status: DeliveryPr['status']
}

/**
 * Land a delivery PR the forge just confirmed, keyed FIRST by the PR's real
 * identity `(forge, repo, number)` and only then by the idempotency triple
 * `(delivery_id, base_sha, head_sha)`.
 *
 * The identity lookup has to come first because a forge keeps ONE open PR per
 * `(head, base)` pair: pushing new commits to the delivery branch updates that
 * same PR rather than allowing a second one. Inserting a fresh row per SHA pair
 * would collide with `idx_delivery_pr_identity` on the very first re-sync; the
 * row is therefore refreshed in place, and the idempotency index keeps its role
 * as the concurrent-retry backstop.
 *
 * `blocked_reason` / `conflict_files` are deliberately NOT written here — they
 * are sync-time verdicts about a PR that already exists, and a create must never
 * silently clear a conflict list the last sync recorded.
 */
export function upsertDeliveryPr(input: UpsertDeliveryPrInput): DeliveryPr {
  const d = requireDb()
  const now = Date.now()
  return tx(d, () => {
    const byIdentity =
      input.forge && input.repo
        ? d.get<DeliveryPrRow>(
            'SELECT * FROM delivery_prs WHERE forge=? AND repo=? AND number=?',
            input.forge,
            input.repo,
            input.number,
          )
        : d.get<DeliveryPrRow>(
            'SELECT * FROM delivery_prs WHERE delivery_id=? AND number=?',
            input.deliveryId,
            input.number,
          )
    const existing =
      byIdentity ??
      d.get<DeliveryPrRow>(
        'SELECT * FROM delivery_prs WHERE delivery_id=? AND base_sha=? AND head_sha=?',
        input.deliveryId,
        input.baseSha,
        input.headSha,
      )
    if (existing) {
      d.run(
        `UPDATE delivery_prs
            SET delivery_id=?, forge=?, repo=?, number=?, url=?, head_branch=?, base_branch=?,
                base_sha=?, head_sha=?, status=?, updated_at=?
          WHERE id=?`,
        input.deliveryId,
        input.forge,
        input.repo,
        input.number,
        input.url,
        input.headBranch,
        input.baseBranch,
        input.baseSha,
        input.headSha,
        input.status,
        now,
        existing.id,
      )
      return toDeliveryPr(
        d.get<DeliveryPrRow>('SELECT * FROM delivery_prs WHERE id=?', existing.id)!,
      )
    }
    const id = randomUUID()
    d.run(
      `INSERT INTO delivery_prs
         (id, delivery_id, forge, repo, number, url, head_branch, base_branch,
          base_sha, head_sha, status, blocked_reason, conflict_files, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
      id,
      input.deliveryId,
      input.forge,
      input.repo,
      input.number,
      input.url,
      input.headBranch,
      input.baseBranch,
      input.baseSha,
      input.headSha,
      input.status,
      now,
      now,
    )
    return toDeliveryPr(d.get<DeliveryPrRow>('SELECT * FROM delivery_prs WHERE id=?', id)!)
  })
}

export interface DeliveryPrFactsInput {
  status: DeliveryPr['status']
  url?: string | null
  blockedReason: DeliveryPrBlockedReason | null
  /** Fresh SHA snapshot when the sync could resolve the refs; omit to keep the stored pair. */
  baseSha?: string | null
  headSha?: string | null
  /** Omit to keep whatever the last sync recorded; `[]` explicitly clears it. */
  conflictFiles?: string[]
}

/**
 * Write one sync's verdict onto the delivery's latest PR row. Returns the
 * refreshed row, or `null` when the delivery has no PR row to write onto.
 */
export function updateDeliveryPrFacts(
  deliveryId: string,
  facts: DeliveryPrFactsInput,
): DeliveryPr | null {
  const d = requireDb()
  const row = d.get<DeliveryPrRow>(
    'SELECT * FROM delivery_prs WHERE delivery_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    deliveryId,
  )
  if (!row) return null
  d.run(
    `UPDATE delivery_prs
        SET status=?, url=?, blocked_reason=?, base_sha=?, head_sha=?, conflict_files=?, updated_at=?
      WHERE id=?`,
    facts.status,
    facts.url === undefined ? row.url : facts.url,
    facts.blockedReason,
    facts.baseSha ?? row.base_sha,
    facts.headSha ?? row.head_sha,
    facts.conflictFiles === undefined ? row.conflict_files : JSON.stringify(facts.conflictFiles),
    Date.now(),
    row.id,
  )
  return toDeliveryPr(d.get<DeliveryPrRow>('SELECT * FROM delivery_prs WHERE id=?', row.id)!)
}

/** Append one delivery log line (append-only; never updated, never deleted). */
export function insertDeliveryLog(
  deliveryId: string,
  operationType: string,
  summary: string,
  actor: string,
): void {
  const d = requireDb()
  d.run(
    'INSERT INTO delivery_logs (id, delivery_id, operation_type, summary, actor, created_at) VALUES (?,?,?,?,?,?)',
    randomUUID(),
    deliveryId,
    operationType,
    summary,
    actor,
    Date.now(),
  )
}

/** One delivery's log lines, newest first. */
export function listDeliveryLogs(deliveryId: string): DeliveryLogEntry[] {
  const d = db()
  if (!d) return []
  return d.all<DeliveryLogEntry & { delivery_id: string }>(
    `SELECT id, operation_type AS operationType, summary, actor, created_at AS createdAt
       FROM delivery_logs WHERE delivery_id=? ORDER BY created_at DESC, rowid DESC`,
    deliveryId,
  )
}

/** One `delivery_logs` row, as readers consume it. */
export interface DeliveryLogEntry {
  id: string
  operationType: string
  summary: string
  actor: string
  createdAt: number
}

/**
 * The delivered write, as ONE unit: the status, the delivery log line and the PR
 * row's `merged` state land in a single transaction or none of them do. The
 * caller MUST have already passed `canTransitionDelivery` — this store never
 * re-derives the state machine.
 *
 * Everything that follows (`delivery:delivered`, the queue-gate recompute, the
 * broadcasts) deliberately sits OUTSIDE the transaction: they are consequences of
 * a fact that is already true, and failing to publish one must not un-deliver a
 * delivery whose code is in mainline. A repeat sync re-runs them idempotently.
 *
 * `markPrMerged` is false on the path where the delivery reached mainline WITHOUT
 * the recorded PR being the thing that merged (it was closed, or there is no row
 * at all): the delivery is delivered, but rewriting a closed PR row into `merged`
 * would forge a merge that never happened.
 */
export function commitDeliveryDelivered(
  deliveryId: string,
  summary: string,
  actor: string,
  markPrMerged = true,
): Delivery | null {
  const d = requireDb()
  return tx(d, () => {
    const prior = d.get<{ status: string }>('SELECT status FROM deliveries WHERE id=?', deliveryId)
    if (!prior) return null
    const now = Date.now()
    d.run('UPDATE deliveries SET status=?, updated_at=? WHERE id=?', 'delivered', now, deliveryId)
    // Only the LATEST row — a superseded PR that was genuinely closed must keep
    // saying so rather than be rewritten into history that never happened.
    if (markPrMerged) updateDeliveryPrFacts(deliveryId, { status: 'merged', blockedReason: null })
    insertDeliveryLog(deliveryId, 'delivered', summary, actor)
    return getDelivery(deliveryId)
  })
}

/**
 * The merge-conflict rollback, as ONE unit: `verified → verifying` plus its log
 * line plus the conflicting files / SHA snapshot on the PR row. Same contract as
 * {@link commitDeliveryDelivered} — the caller has already passed
 * `canTransitionDelivery` with `reason: 'merge_conflict'`.
 */
export function commitDeliveryMergeConflict(
  deliveryId: string,
  facts: DeliveryPrFactsInput,
  summary: string,
  actor: string,
): Delivery | null {
  const d = requireDb()
  return tx(d, () => {
    const prior = d.get<{ status: string }>('SELECT status FROM deliveries WHERE id=?', deliveryId)
    if (!prior) return null
    d.run(
      'UPDATE deliveries SET status=?, updated_at=? WHERE id=?',
      'verifying',
      Date.now(),
      deliveryId,
    )
    updateDeliveryPrFacts(deliveryId, facts)
    insertDeliveryLog(deliveryId, 'merge_conflict', summary, actor)
    return getDelivery(deliveryId)
  })
}

/** Whether `status` is a delivery status the ledger accepts (wire closed-set). */
export function isDeliveryStatus(status: string): status is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(status)
}
