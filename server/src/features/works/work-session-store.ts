/**
 * `work_session_metadata` projection store over the shared {@link Db} (c3.db).
 *
 * Owns the core-metadata projection table that becomes the daily read path for
 * `list_sessions`. Five columns of core metadata only — no transcript / prompt /
 * tool_use / tool_result content (ADR-0013 native-is-SoT; this store is a
 * rebuildable cache, not a second copy of session content). The table holds
 * two row variants (`kind`): a `pending` row written at `createSession` time
 * (the new home for the ADR-0015 "intent") and a `real` row written at
 * `bindPending` / `finalizeRun` / `rename` / delete time. The read path filters
 * by `workspace_path` at the SQL level; cold sessions stay visible.
 *
 * Pattern (mirrors `features/intents/store.ts` and
 * `features/discussions/store.ts`): lazy schema via a private `schemaReady`
 * flag, `ensureColumn` for idempotent backfill (we don't touch
 * `PRAGMA user_version` — the three stores would clobber each other; migrations
 * key off `PRAGMA table_info`). `requireDb` throws on writes; all public
 * write/read entry points guard with `isDbAvailable` so a missing db degrades
 * to no-op / empty (the wire path completes). A `setNow()` test hook injects
 * a clock for the janitor / lazy-validation tests (default `Date.now`).
 *
 * Failures from the janitor / lazy validation are logged, never thrown — the
 * bind / rename / delete / finalize paths MUST NOT break because the
 * projection is down (SR-R11 / AVAIL).
 */
import type { VendorId } from '@ccc/shared/protocol'
import { mintC3SessionId, type C3SessionId } from '../../kernel/agent/session/accessor.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

// ---- Schema ----

/**
 * The five lifecycle states (spec § Lifecycle states). Pinned by the runtime
 * column-whitelist test in `store.test.ts`; an unknown value in the column
 * falls back to `'born'` on read so a future state addition is non-fatal.
 */
export type WorkSessionState = 'born' | 'alive' | 'stale' | 'orphaned' | 'ghost'

/** A row variant. `'real'` = post-bind; `'pending'` = pre-bind (intent). */
export type WorkSessionKind = 'real' | 'pending'

/**
 * The column whitelist (spec § Schema). Mirrored by
 * `assertColumnWhitelist` (F-12 positive assertion). Any schema change must
 * update BOTH the SCHEMA and the whitelist — the test fails otherwise.
 */
const COLUMNS = [
  'c3_id',
  'workspace_path',
  'vendor',
  'vendor_session_id',
  'agent_id',
  'title',
  'last_modified',
  'state',
  'state_updated_at',
  'kind',
] as const

/** Default title for a freshly-bound row (no native title source at bind time). */
const DEFAULT_TITLE = 'New session'

/** Schema v1: create the table + two indexes. Migrations key off `table_info`. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_session_metadata (
  c3_id              TEXT PRIMARY KEY,
  workspace_path     TEXT NOT NULL,
  vendor             TEXT NOT NULL,
  vendor_session_id  TEXT,
  agent_id           TEXT NOT NULL,
  title              TEXT NOT NULL,
  last_modified      INTEGER,
  state              TEXT NOT NULL,
  state_updated_at   INTEGER NOT NULL,
  kind               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wsm_workspace_vendor
  ON work_session_metadata(workspace_path, vendor, vendor_session_id);
CREATE INDEX IF NOT EXISTS idx_wsm_state_age
  ON work_session_metadata(state, state_updated_at);
`

/** How long a row may sit without being re-validated before it goes `stale`. */
export const STALE_MS = 24 * 60 * 60 * 1000

/**
 * Janitor cadence = half the stale window, so a row that becomes `stale` on
 * one pass becomes `orphaned` on the next deterministic pass (a 12h gap).
 * A lazy read in between flips it back to `alive` — that is the correct
 * freshening behavior.
 */
export const JANITOR_INTERVAL_MS = STALE_MS / 2

const VALID_STATES: readonly WorkSessionState[] = ['born', 'alive', 'stale', 'orphaned', 'ghost']

let schemaReady = false
let nowFn: () => number = () => Date.now()

/** Test-only: inject a clock (default `Date.now`). Pair with `resetStoreForTests`. */
export function setNow(fn: () => number): void {
  nowFn = fn
}

function now(): number {
  return nowFn()
}

/** Idempotently add a column when missing — same shape as the sibling stores. */
function ensureColumn(d: Db, table: string, col: string, decl: string): void {
  const cols = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
}

/** Return the db with the schema ensured, or null if unavailable. The
 *  `schemaReady` flag is a per-process optimization — `CREATE TABLE IF
 *  NOT EXISTS` is idempotent and cheap, so the schema runs once per
 *  process. A test that swaps the underlying db (via `resetDbForTests`)
 *  must call {@link resetStoreForTests} to re-run the schema.
 *
 *  Migration: if the old `session_metadata` table exists but the new
 *  `work_session_metadata` does not, it is renamed in place (idempotent,
 *  zero DROP TABLE, roll-back-by-forward-fix). */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    // Migrate old table name (idempotent: no-op if already migrated or never existed).
    const oldTable = d.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_metadata'",
    )
    const newTable = d.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='work_session_metadata'",
    )
    if (oldTable.length > 0 && newTable.length === 0) {
      d.exec('ALTER TABLE session_metadata RENAME TO work_session_metadata')
    }
    ensureColumn(d, 'work_session_metadata', 'workspace_path', 'TEXT NOT NULL DEFAULT ""')
    // We deliberately do NOT write `PRAGMA user_version` — the three domain
    // stores would clobber each other (see discussions/store.ts:25-30).
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('work_session_metadata store unavailable (c3.db unavailable)')
  return d
}

/** Whether the store can be used (db opened). */
export function isStoreAvailable(): boolean {
  return isDbAvailable()
}

/** Test-only: forget the "schema ensured" flag (pair with `resetDbForTests`). */
export function resetStoreForTests(): void {
  schemaReady = false
  nowFn = () => Date.now()
}

/**
 * The full positive column-whitelist assertion (F-12). The runtime test opens
 * the db, ensures the schema, and reads `PRAGMA table_info(work_session_metadata)`;
 * the returned set MUST equal {@link COLUMNS} (in any order). Any extra or
 * missing column is a contract violation. This is the source of truth for the
 * "no content columns" claim — adding a `content` column would fail the test.
 */
export function assertColumnWhitelist(): { name: string }[] {
  const d = requireDb()
  return d.all<{ name: string }>('PRAGMA table_info(work_session_metadata)')
}

/** The whitelist itself, exported for the test's `expect(...).toEqual(...)`. */
export function columnWhitelist(): readonly string[] {
  return COLUMNS
}

// ---- Row shape (in-memory) ----

/** One row from `work_session_metadata`, typed for the in-memory shape. */
export interface WorkSessionRow {
  c3Id: C3SessionId
  workspacePath: string
  vendor: VendorId
  vendorSessionId: string | null
  agentId: string
  title: string
  lastModified: number | null
  state: WorkSessionState
  stateUpdatedAt: number
  kind: WorkSessionKind
}

interface RawRow {
  c3_id: string
  workspace_path: string
  vendor: string
  vendor_session_id: string | null
  agent_id: string
  title: string
  last_modified: number | null
  state: string
  state_updated_at: number
  kind: string
}

function narrowState(s: string): WorkSessionState {
  return VALID_STATES.includes(s as WorkSessionState) ? (s as WorkSessionState) : 'born'
}

function narrowKind(k: string): WorkSessionKind {
  return k === 'pending' ? 'pending' : 'real'
}

function toRow(r: RawRow): WorkSessionRow {
  return {
    c3Id: r.c3_id as C3SessionId,
    workspacePath: r.workspace_path,
    vendor: r.vendor as VendorId,
    vendorSessionId: r.vendor_session_id,
    agentId: r.agent_id,
    title: r.title,
    lastModified: r.last_modified,
    state: narrowState(r.state),
    stateUpdatedAt: r.state_updated_at,
    kind: narrowKind(r.kind),
  }
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

// ---- Write API ----

/**
 * Write a `pending` row (createSession path). The new home for what
 * `setPendingIntent` used to carry (ADR-0015's transitional intent map,
 * now folded into the projection as a row variant — F-11). `agentId`'s
 * vendor is stamped on the row so a future freeze has a known target;
 * the row's `vendor` is exactly the agent's vendor.
 *
 * Idempotent: writing the same `pendingId` a second time is a no-op (a
 * `createSession` retry hits this path).
 */
export function upsertPendingRow(input: {
  pendingId: string
  workspacePath: string
  vendor: VendorId
  agentId: string
}): void {
  const d = db()
  if (!d) return
  const t = now()
  d.run(
    `INSERT OR REPLACE INTO work_session_metadata
       (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
        last_modified, state, state_updated_at, kind)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    input.pendingId,
    input.workspacePath,
    input.vendor,
    null,
    input.agentId,
    DEFAULT_TITLE,
    null,
    'born',
    t,
    'pending',
  )
}

/**
 * Re-target a still-pending session's agent (setSessionAgent pending branch
 * — F-6). Updates the pending row's `agent_id` (and its `vendor`, which
 * follows the agent). No-op when the db is unavailable.
 */
export function updatePendingRowAgentId(input: {
  pendingId: string
  vendor: VendorId
  agentId: string
}): void {
  const d = db()
  if (!d) return
  d.run(
    `UPDATE work_session_metadata
       SET vendor=?, agent_id=?, state='born', state_updated_at=?
     WHERE c3_id=? AND kind='pending'`,
    input.vendor,
    input.agentId,
    now(),
    input.pendingId,
  )
}

/**
 * Single entry point for the bind hook (called from BOTH run paths via
 * `freezeSessionAgent`). Atomically drops the pending row + inserts the
 * real row in one transaction (F-5 idempotence — a retry-bind of an
 * already-bound realId is a no-op via `INSERT OR IGNORE` on the real
 * row's `c3_id` PK). The real row's `title` is the placeholder (no
 * native source at bind); `last_modified` is stamped to the BIND TIME
 * (`now()`) so a freshly-bound session sorts to the TOP of the list
 * immediately — a just-created/just-active session is, by definition, the
 * most recent. A null here would sink the row to the very bottom of the
 * list (`ORDER BY (last_modified IS NULL) …`), where the user never looks,
 * AND for Codex it would stay null forever (lazy validation skips Codex),
 * so a brand-new session would be permanently invisible at the top. The
 * next lazy validation refines `last_modified` to the native transcript
 * mtime. State starts at `born`; lazy validation flips it to `alive` when
 * the native store has been consulted.
 */
export function upsertForBind(input: {
  pendingId: string
  realId: string
  workspacePath: string
  vendor: VendorId
  agentId: string
}): { c3Id: C3SessionId } {
  const d = db()
  if (!d) return { c3Id: '' as C3SessionId }
  const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: input.realId })
  const t = now()
  tx(d, () => {
    d.run('DELETE FROM work_session_metadata WHERE c3_id=? AND kind=?', input.pendingId, 'pending')
    d.run(
      `INSERT OR IGNORE INTO work_session_metadata
         (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
          last_modified, state, state_updated_at, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      c3Id,
      input.workspacePath,
      input.vendor,
      input.realId,
      input.agentId,
      DEFAULT_TITLE,
      t,
      'born',
      t,
      'real',
    )
  })
  return { c3Id }
}

/**
 * Same-vendor agent swap (setSessionAgent real-id branch — F-6). Updates
 * the real row's `agent_id`; state flips to `alive` (the row is
 * authoritative again, the swap was a deliberate fact write).
 * Cross-vendor attempts are rejected upstream in `setSessionAgent` and
 * never reach this function.
 */
export function updateRealRowAgentId(realId: string, vendor: VendorId, agentId: string): void {
  const d = db()
  if (!d) return
  const c3Id = mintC3SessionId({ vendor, vendorSessionId: realId })
  d.run(
    `UPDATE work_session_metadata
       SET agent_id=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND kind='real'`,
    agentId,
    now(),
    c3Id,
  )
}

/**
 * Rename upsert (renameWorkspaceSession path — F-3). Updates the real
 * row's `title`; state flips to `alive` (the row is current again).
 */
export function updateRealRowTitle(realId: string, vendor: VendorId, title: string): void {
  const d = db()
  if (!d) return
  const c3Id = mintC3SessionId({ vendor, vendorSessionId: realId })
  d.run(
    `UPDATE work_session_metadata
       SET title=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND kind='real'`,
    title,
    now(),
    c3Id,
  )
}

/**
 * Run-end upsert (finalizeRun path — F-2). Single trigger for both run
 * paths (claude `run-lifecycle.ts` AND codex/opencode `run-via-driver.ts`
 * both call `finalizeRun` in their teardown). Updates `title`,
 * `last_modified`, and `agent_id` (the latter is a defensive re-stamp in
 * case the agent just swapped mid-run).
 */
export function touchOnRunEnd(input: {
  realId: string
  vendor: VendorId
  agentId: string
  title: string
  lastModified: number | null
}): void {
  const d = db()
  if (!d) return
  const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: input.realId })
  d.run(
    `UPDATE work_session_metadata
       SET title=?, last_modified=?, agent_id=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND kind='real'`,
    input.title,
    input.lastModified,
    input.agentId,
    now(),
    c3Id,
  )
}

/**
 * Delete the projection row for a real session (removeSession path —
 * F-4). Looks up by the c3 id; falls back to a `(vendor,
 * vendor_session_id)` scan when the c3 id is unknown (a freshly created
 * pending never run has no c3 id; this handles the "delete a pending I
 * just made" UX edge case).
 */
export function deleteByVendorId(vendor: VendorId, vendorSessionId: string): void {
  const d = db()
  if (!d) return
  const c3Id = mintC3SessionId({ vendor, vendorSessionId })
  d.run('DELETE FROM work_session_metadata WHERE c3_id=? OR c3_id=?', c3Id, vendorSessionId)
}

/** Delete by the raw pending id (used by `deleteSession` for a pending never run). */
export function deleteByPendingId(pendingId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM work_session_metadata WHERE c3_id=? AND kind=?', pendingId, 'pending')
}

// ---- Read API ----

/** Look up one row by its c3 id, or null if absent. */
export function getByC3Id(c3Id: string): WorkSessionRow | null {
  const d = db()
  if (!d) return null
  const row = d.get<RawRow>('SELECT * FROM work_session_metadata WHERE c3_id=?', c3Id)
  return row ? toRow(row) : null
}

/**
 * The pending intent for a pending id, or null (used by
 * `getSessionAgentId`'s read-through after the v2→v3 migration — F-11).
 */
export function getPendingIntent(pendingId: string): { agentId: string } | null {
  const d = db()
  if (!d) return null
  const row = d.get<{ agent_id: string }>(
    "SELECT agent_id FROM work_session_metadata WHERE c3_id=? AND kind='pending'",
    pendingId,
  )
  return row ? { agentId: row.agent_id } : null
}

/**
 * The full table, sorted newest-first. The daily read path filters by
 * `workspace_path` at the SQL level (this returns everything for callers
 * that want the whole c3 — e.g. the rebuild path / debugging).
 */
export function listAll(): WorkSessionRow[] {
  const d = db()
  if (!d) return []
  return d
    .all<RawRow>('SELECT * FROM work_session_metadata ORDER BY state_updated_at DESC')
    .map(toRow)
}

/**
 * The read path: every real row for a workspace (pending rows are
 * excluded — they have no transcript yet, the wire filter is the
 * per-connection "viewed session" badge, not a list entry). Newest-first
 * by `last_modified` desc, with nulls (Codex bind-time) at the end. The
 * wire filter (isHiddenSession + isToolSessionRecorded) is applied
 * downstream in `listSessionsVia`; this returns the raw list.
 */
export function listForWorkspace(workspacePath: string): WorkSessionRow[] {
  const d = db()
  if (!d) return []
  return d
    .all<RawRow>(
      `SELECT * FROM work_session_metadata
         WHERE workspace_path=? AND kind='real'
         ORDER BY (last_modified IS NULL), last_modified DESC, state_updated_at DESC`,
      workspacePath,
    )
    .map(toRow)
}

/**
 * Count a workspace's real (post-bind) session projection rows, optionally
 * restricted to rows whose `last_modified` falls in `[startTime, endTime]`
 * (ms epoch; either bound may be omitted). When a bound is given, rows with a
 * null `last_modified` are excluded (they have no transcript time to compare);
 * with no bounds, every real row counts. Returns 0 when the db is unavailable.
 */
export function countRealInRange(
  workspacePath: string,
  startTime?: number,
  endTime?: number,
): number {
  const d = db()
  if (!d) return 0
  const where: string[] = ['workspace_path=?', "kind='real'"]
  const params: (string | number)[] = [workspacePath]
  if (startTime != null) {
    where.push('last_modified IS NOT NULL AND last_modified >= ?')
    params.push(startTime)
  }
  if (endTime != null) {
    where.push('last_modified IS NOT NULL AND last_modified <= ?')
    params.push(endTime)
  }
  const row = d.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM work_session_metadata WHERE ${where.join(' AND ')}`,
    ...params,
  )
  return row?.count ?? 0
}

// ---- Lazy validation (F-8) ----

/**
 * The re-validation hook fired at the end of `selectSession` /
 * `sendSessions` (fire-and-forget; never awaited on the wire path).
 * **Codex rows are explicitly skipped** (per the plan's #5 — Codex's
 * thread items are the canonical "lazy" source, never re-read on every
 * list). Other rows whose `state_updated_at` is older than
 * `LAZY_VALIDATE_MS` (= `STALE_MS`) are looked up against the native
 * store via the supplied `nativeList` callback; a mismatch rewrites
 * the row's `title` / `last_modified` / `state='alive'`.
 *
 * The callback signature is intentionally narrow: it takes
 * `(vendor, workspacePath)` and returns the vendor's listed sessions
 * for that workspace, or `null` on error (which flips the row to
 * `ghost`). Errors are logged, never thrown.
 */
export type NativeListFn = (
  vendor: VendorId,
  workspacePath: string,
) => Promise<{
  sessions: { vendorSessionId: string; title: string; lastModified: number | null }[]
} | null>

export const LAZY_VALIDATE_MS = STALE_MS

export interface ValidateLazyResult {
  checked: number
  rewritten: number
  ghosted: number
  skipped: number
}

/**
 * Fire-and-forget validation. `workspacePath` scopes the lookup; the
 * function only validates rows in that workspace. Designed to be
 * invoked with `void` at the end of the wire handler so the wire reply
 * is not blocked.
 */
export async function validateLazy(input: {
  workspacePath: string
  nativeList: NativeListFn
}): Promise<ValidateLazyResult> {
  const d = db()
  if (!d) return { checked: 0, rewritten: 0, ghosted: 0, skipped: 0 }
  const t = now()
  const rows = d.all<RawRow>(
    `SELECT * FROM work_session_metadata
       WHERE workspace_path=? AND kind='real'
         AND (state_updated_at IS NULL OR ? - state_updated_at >= ?)`,
    input.workspacePath,
    t,
    LAZY_VALIDATE_MS,
  )
  let checked = 0
  let rewritten = 0
  let ghosted = 0
  let skipped = 0
  // Group rows by vendor so we do one native list per vendor.
  const byVendor = new Map<VendorId, RawRow[]>()
  for (const r of rows) {
    if (r.vendor === 'codex') {
      // Codex is explicitly skipped — its thread items are the canonical
      // source, not the per-list re-read. A future lazy re-read for Codex
      // can call the thread-items API; not in this cycle.
      skipped++
      continue
    }
    checked++
    const arr = byVendor.get(r.vendor as VendorId) ?? []
    arr.push(r)
    byVendor.set(r.vendor as VendorId, arr)
  }
  for (const [vendor, vendorRows] of byVendor) {
    let native: Awaited<ReturnType<NativeListFn>> = null
    try {
      native = await input.nativeList(vendor, input.workspacePath)
    } catch (err) {
      console.error(`[c3] validateLazy: native list failed for ${vendor}:`, err)
    }
    if (native === null) {
      for (const r of vendorRows) {
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'ghost',
          t,
          r.c3_id,
        )
        ghosted++
      }
      continue
    }
    const byNative = new Map(native.sessions.map((s) => [s.vendorSessionId, s]))
    for (const r of vendorRows) {
      const hit = byNative.get(r.vendor_session_id ?? '')
      if (!hit) {
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'orphaned',
          t,
          r.c3_id,
        )
      } else if (hit.title !== r.title || hit.lastModified !== r.last_modified) {
        d.run(
          `UPDATE work_session_metadata
             SET title=?, last_modified=?, state='alive', state_updated_at=?
           WHERE c3_id=?`,
          hit.title,
          hit.lastModified,
          t,
          r.c3_id,
        )
        rewritten++
      } else {
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'alive',
          t,
          r.c3_id,
        )
      }
    }
  }
  return { checked, rewritten, ghosted, skipped }
}

// ---- Janitor (F-9) ----

export interface JanitorResult {
  stale: number
  orphaned: number
  ghosted: number
  refreshed: number
  observed: number
}

/**
 * The warmup-day janitor (F-9). Sweeps every row:
 *  - `born` / `alive` rows older than `STALE_MS` ⇒ `stale` (one pass only).
 *  - `stale` rows: the next native list (per vendor, per workspace) decides
 *    `alive` (still there, matches) / `stale` (still there, no match — wait
 *    one more pass) / `orphaned` (this pass observes `stale` for the second
 *    time, meaning the warmup is complete) / `ghost` (native errored).
 *  - `orphaned` / `ghost` rows: a successful native match ⇒ `alive`.
 *
 * The warmup is deterministic: a `stale` row that wasn't seen in the
 * prior pass is recorded via a side `state_updated_at` (the
 * `state_updated_at` from the previous sweep is what we compare against;
 * the row's `state` only flips to `orphaned` if `now - last_state_at >=
 * 2 * JANITOR_INTERVAL_MS`).
 */
export async function janitor(input: {
  nativeList: NativeListFn
  workspaces: readonly string[]
}): Promise<JanitorResult> {
  const d = db()
  if (!d) return { stale: 0, orphaned: 0, ghosted: 0, refreshed: 0, observed: 0 }
  const t = now()
  let stale = 0
  let orphaned = 0
  let ghosted = 0
  let refreshed = 0
  let observed = 0
  // Group live rows by (workspace, vendor) for one native call per pair.
  const buckets = new Map<string, { workspacePath: string; vendor: VendorId; rowIds: string[] }>()
  const allRows = d.all<RawRow>('SELECT * FROM work_session_metadata WHERE kind=?', 'real')
  for (const r of allRows) {
    if (r.state === 'ghost' || r.state === 'orphaned') {
      // Still eligible for `alive` refresh on a successful native match.
    }
    const age = t - r.state_updated_at
    if (r.state === 'alive' || r.state === 'born') {
      if (age >= STALE_MS) {
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'stale',
          t,
          r.c3_id,
        )
        stale++
      }
      continue
    }
    // Stale / orphaned / ghost: re-check.
    const key = `${r.workspace_path} ${r.vendor}`
    const b = buckets.get(key) ?? {
      workspacePath: r.workspace_path,
      vendor: r.vendor as VendorId,
      rowIds: [],
    }
    b.rowIds.push(r.c3_id)
    buckets.set(key, b)
  }
  for (const b of buckets.values()) {
    if (b.vendor === 'codex') {
      // Codex rows are explicitly not janitored (the thread items are the
      // canonical source; the janitor's native list wouldn't find them
      // anyway — Codex is not enumerable per SR-R4).
      observed += b.rowIds.length
      continue
    }
    let native: Awaited<ReturnType<NativeListFn>> = null
    try {
      native = await input.nativeList(b.vendor, b.workspacePath)
    } catch (err) {
      console.error(`[c3] janitor: native list failed for ${b.vendor}:`, err)
    }
    if (native === null) {
      for (const id of b.rowIds) {
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'ghost',
          t,
          id,
        )
        ghosted++
      }
      continue
    }
    const byNative = new Map(native.sessions.map((s) => [s.vendorSessionId, s]))
    for (const id of b.rowIds) {
      const r = d.get<RawRow>('SELECT * FROM work_session_metadata WHERE c3_id=?', id)
      if (!r) continue
      const hit = byNative.get(r.vendor_session_id ?? '')
      if (hit) {
        // Successful match ⇒ flip back to `alive` (or stay if already alive).
        d.run(
          `UPDATE work_session_metadata
             SET state='alive', title=?, last_modified=?, state_updated_at=?
           WHERE c3_id=?`,
          hit.title,
          hit.lastModified,
          t,
          id,
        )
        refreshed++
      } else if (r.state === 'stale' && t - r.state_updated_at >= JANITOR_INTERVAL_MS) {
        // Warmup complete: `stale` for two consecutive sweeps ⇒ `orphaned`.
        d.run(
          'UPDATE work_session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'orphaned',
          t,
          id,
        )
        orphaned++
      } else if (r.state === 'stale') {
        // First observation of `stale`; keep the state, just record the
        // sweep time so the next pass can transition to `orphaned`.
        d.run('UPDATE work_session_metadata SET state_updated_at=? WHERE c3_id=?', t, id)
        observed++
      } else {
        // `orphaned` / `ghost` row that didn't re-match this pass: hold state.
        observed++
      }
    }
  }
  return { stale, orphaned, ghosted, refreshed, observed }
}

// ---- Rebuild (F-10) ----

/**
 * Targeted rebuild for one (workspace, vendor) pair — used by the read
 * path when the projection is empty for a workspace but the native
 * store has rows. Upserts one row per native entry.
 *
 * `agentIdFor` resolves the agent for a native session id. The rebuild
 * source for the bind-time data is the `sessionAgents` fact list
 * (state.json), so the caller passes a closure that reads from the
 * kernel-config store. The Codex rebuild is the caller's job — Codex
 * is not enumerable, and the caller iterates the fact list to call
 * `upsertForBind` for each.
 */
export async function rebuildOne(input: {
  workspacePath: string
  vendor: VendorId
  agentIdFor: (vendorSessionId: string) => string | null
  nativeList: NativeListFn
}): Promise<number> {
  const d = db()
  if (!d) return 0
  if (input.vendor === 'codex') return 0
  const t = now()
  let count = 0
  let native: Awaited<ReturnType<NativeListFn>>
  try {
    native = await input.nativeList(input.vendor, input.workspacePath)
  } catch (err) {
    console.error(`[c3] rebuildOne: native list failed for ${input.vendor}:`, err)
    return 0
  }
  if (native === null) return 0
  for (const s of native.sessions) {
    const agentId = input.agentIdFor(s.vendorSessionId)
    if (!agentId) continue
    const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: s.vendorSessionId })
    d.run(
      `INSERT OR REPLACE INTO work_session_metadata
         (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
          last_modified, state, state_updated_at, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      c3Id,
      input.workspacePath,
      input.vendor,
      s.vendorSessionId,
      agentId,
      s.title,
      s.lastModified,
      'alive',
      t,
      'real',
    )
    count++
  }
  return count
}

// ---- Wire projection (read path) ----
//
// The wire mapping (row → SessionInfo) lives in `list-sessions.ts` next to
// the filter parity work, NOT in this store. The store only deals with rows;
// the wire layer adds the `mode` lookup from `state.ts`, the
// `isToolSession`/`isHiddenSession` filters, and the additive `state` field.
