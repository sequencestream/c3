/**
 * `session_metadata` projection store over the shared {@link Db} (c3.db).
 *
 * Owns the metadata projection table that becomes the daily read path for
 * `list_sessions` and running counts. Metadata only — no transcript / prompt /
 * tool_use / tool_result content (ADR-0013 native-is-SoT; this store is a
 * rebuildable cache, not a second copy of session content). The table is
 * generalized by `session_kind` and optional owner fields. `bound=0` is the
 * work-only pending placeholder written at create time; `bound=1` rows are real
 * bound sessions. The legacy `kind` column is retained for compatibility but is
 * not the read-path discriminator.
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
import type { SessionKind, VendorId } from '@ccc/shared/protocol'
import type { Schedule } from '@ccc/shared/protocol'
import { mintC3SessionId, type C3SessionId } from '../../kernel/agent/session/accessor.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

// ---- Schema ----

/**
 * The five lifecycle states (spec § Lifecycle states). Pinned by the runtime
 * column-whitelist test in `store.test.ts`; an unknown value in the column
 * falls back to `'born'` on read so a future state addition is non-fatal.
 */
export type SessionMetadataState = 'born' | 'alive' | 'stale' | 'orphaned' | 'ghost'

/** A row variant. `'real'` = post-bind; `'pending'` = pre-bind (intent). */
export type SessionMetadataBindingKind = 'real' | 'pending'
export type SessionOwnerKind = 'intent' | 'discussion' | 'schedule'

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
  'session_kind',
  'owner_kind',
  'owner_id',
  'bound',
] as const

/** Default title for a freshly-bound row (no native title source at bind time). */
const DEFAULT_TITLE = 'New session'
const PLACEHOLDER_TITLES = new Set([DEFAULT_TITLE, 'Untitled session'])

/** Schema v1: create the table + two indexes. Migrations key off `table_info`. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_metadata (
  c3_id              TEXT PRIMARY KEY,
  workspace_path     TEXT NOT NULL,
  vendor             TEXT NOT NULL,
  vendor_session_id  TEXT,
  agent_id           TEXT NOT NULL,
  title              TEXT NOT NULL,
  last_modified      INTEGER,
  state              TEXT NOT NULL,
  state_updated_at   INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  session_kind       TEXT NOT NULL DEFAULT 'work',
  owner_kind         TEXT,
  owner_id           TEXT,
  bound              INTEGER NOT NULL DEFAULT 1
);
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

const VALID_STATES: readonly SessionMetadataState[] = [
  'born',
  'alive',
  'stale',
  'orphaned',
  'ghost',
]

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

function tableExists(d: Db, table: string): boolean {
  return (
    d.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      table,
    ) != null
  )
}

/** Date stamp `yyyymmdd` from the (injectable) clock, used for backup table names. */
function dateStamp(): string {
  const dt = new Date(now())
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** Find a free `session_metadata_<stamp>` name, appending `_N` on same-day collisions. */
function freeBackupName(d: Db): string {
  const base = `session_metadata_${dateStamp()}`
  if (!tableExists(d, base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`
    if (!tableExists(d, candidate)) return candidate
  }
}

function ensureSchema(d: Db): void {
  const hasOld = tableExists(d, 'work_session_metadata')
  const hasNew = tableExists(d, 'session_metadata')
  if (hasOld && hasNew) {
    // Both tables present: the legacy `work_session_metadata` holds the real
    // data, while `session_metadata` is a stray/partial table from a prior
    // run. Back up the stray to a dated name (no data loss), then promote the
    // legacy table into place. Wrapped in a transaction so a failure rolls
    // back rather than leaving a half-renamed schema.
    const backup = freeBackupName(d)
    tx(d, () => {
      d.exec(`ALTER TABLE session_metadata RENAME TO ${backup}`)
      d.exec('ALTER TABLE work_session_metadata RENAME TO session_metadata')
    })
    console.warn(
      `[c3] session_metadata migration: backed up existing session_metadata to ${backup} and promoted work_session_metadata`,
    )
  } else if (hasOld) {
    d.exec('ALTER TABLE work_session_metadata RENAME TO session_metadata')
  }
  d.exec(SCHEMA)
  ensureColumn(d, 'session_metadata', 'workspace_path', 'TEXT NOT NULL DEFAULT ""')
  ensureColumn(d, 'session_metadata', 'session_kind', "TEXT NOT NULL DEFAULT 'work'")
  ensureColumn(d, 'session_metadata', 'owner_kind', 'TEXT')
  ensureColumn(d, 'session_metadata', 'owner_id', 'TEXT')
  ensureColumn(d, 'session_metadata', 'bound', 'INTEGER NOT NULL DEFAULT 1')
  d.run(
    "UPDATE session_metadata SET session_kind='work' WHERE session_kind IS NULL OR session_kind=''",
  )
  d.run("UPDATE session_metadata SET bound=0 WHERE kind='pending' AND bound IS NOT 0")
  d.run(
    "UPDATE session_metadata SET bound=1 WHERE (kind IS NULL OR kind!='pending') AND bound IS NOT 1",
  )
  d.exec(`
CREATE INDEX IF NOT EXISTS idx_sm_workspace_kind_updated
  ON session_metadata(workspace_path, session_kind, bound, last_modified DESC, state_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sm_workspace_vendor
  ON session_metadata(workspace_path, vendor, vendor_session_id);
CREATE INDEX IF NOT EXISTS idx_sm_state_age
  ON session_metadata(state, state_updated_at);
`)
}

/** Return the db with the schema ensured, or null if unavailable. The
 *  `schemaReady` flag is a per-process optimization — `CREATE TABLE IF
 *  NOT EXISTS` is idempotent and cheap, so the schema runs once per
 *  process. A test that swaps the underlying db (via `resetDbForTests`)
 *  must call {@link resetStoreForTests} to re-run the schema.
 *
 *  Migration: if the old `work_session_metadata` table exists but the new
 *  `session_metadata` does not, it is renamed in place (idempotent,
 *  zero DROP TABLE, roll-back-by-forward-fix). */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    ensureSchema(d)
    // We deliberately do NOT write `PRAGMA user_version` — the three domain
    // stores would clobber each other (see discussions/store.ts:25-30).
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('session_metadata store unavailable (c3.db unavailable)')
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
 * the db, ensures the schema, and reads `PRAGMA table_info(session_metadata)`;
 * the returned set MUST equal {@link COLUMNS} (in any order). Any extra or
 * missing column is a contract violation. This is the source of truth for the
 * "no content columns" claim — adding a `content` column would fail the test.
 */
export function assertColumnWhitelist(): { name: string }[] {
  const d = requireDb()
  return d.all<{ name: string }>('PRAGMA table_info(session_metadata)')
}

/** The whitelist itself, exported for the test's `expect(...).toEqual(...)`. */
export function columnWhitelist(): readonly string[] {
  return COLUMNS
}

// ---- Row shape (in-memory) ----

/** One row from `session_metadata`, typed for the in-memory shape. */
export interface SessionMetadataRow {
  c3Id: C3SessionId
  workspacePath: string
  vendor: VendorId
  vendorSessionId: string | null
  agentId: string
  title: string
  lastModified: number | null
  state: SessionMetadataState
  stateUpdatedAt: number
  kind: SessionMetadataBindingKind
  sessionKind: SessionKind
  ownerKind: SessionOwnerKind | null
  ownerId: string | null
  bound: boolean
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
  session_kind: string
  owner_kind: string | null
  owner_id: string | null
  bound: number
}

function narrowState(s: string): SessionMetadataState {
  return VALID_STATES.includes(s as SessionMetadataState) ? (s as SessionMetadataState) : 'born'
}

function narrowKind(k: string): SessionMetadataBindingKind {
  return k === 'pending' ? 'pending' : 'real'
}

function narrowSessionKind(k: string): SessionKind {
  switch (k) {
    case 'intent':
    case 'discussion':
    case 'schedule':
    case 'consensus':
    case 'tool':
    case 'spec':
      return k
    default:
      return 'work'
  }
}

function narrowOwnerKind(k: string | null): SessionOwnerKind | null {
  return k === 'intent' || k === 'discussion' || k === 'schedule' ? k : null
}

function toRow(r: RawRow): SessionMetadataRow {
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
    sessionKind: narrowSessionKind(r.session_kind),
    ownerKind: narrowOwnerKind(r.owner_kind),
    ownerId: r.owner_id,
    bound: r.bound === 1,
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
  title?: string
  ownerKind?: SessionOwnerKind | null
  ownerId?: string | null
}): void {
  const d = db()
  if (!d) return
  const t = now()
  d.run(
    `INSERT OR REPLACE INTO session_metadata
       (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
        last_modified, state, state_updated_at, kind, session_kind, owner_kind, owner_id, bound)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.pendingId,
    input.workspacePath,
    input.vendor,
    null,
    input.agentId,
    input.title ?? DEFAULT_TITLE,
    null,
    'born',
    t,
    'pending',
    'work',
    input.ownerKind ?? null,
    input.ownerId ?? null,
    0,
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
    `UPDATE session_metadata
       SET vendor=?, agent_id=?, state='born', state_updated_at=?
     WHERE c3_id=? AND bound=0`,
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
 * row's `c3_id` PK). The real row's `title` starts from the pending row
 * when it carries a non-placeholder title; otherwise it uses the placeholder
 * (no native source at bind). `last_modified` is stamped to the BIND TIME
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
  sessionKind?: SessionKind
  ownerKind?: SessionOwnerKind | null
  ownerId?: string | null
}): { c3Id: C3SessionId } {
  const d = db()
  if (!d) return { c3Id: '' as C3SessionId }
  const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: input.realId })
  const t = now()
  tx(d, () => {
    const pending = d.get<{ title: string; owner_kind: string | null; owner_id: string | null }>(
      'SELECT title, owner_kind, owner_id FROM session_metadata WHERE c3_id=? AND bound=0',
      input.pendingId,
    )
    const title =
      pending?.title && !PLACEHOLDER_TITLES.has(pending.title) ? pending.title : DEFAULT_TITLE
    d.run('DELETE FROM session_metadata WHERE c3_id=? AND bound=?', input.pendingId, 0)
    d.run(
      `INSERT OR IGNORE INTO session_metadata
         (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
          last_modified, state, state_updated_at, kind, session_kind, owner_kind, owner_id, bound)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c3Id,
      input.workspacePath,
      input.vendor,
      input.realId,
      input.agentId,
      title,
      t,
      'born',
      t,
      'real',
      input.sessionKind ?? 'work',
      input.ownerKind ?? narrowOwnerKind(pending?.owner_kind ?? null),
      input.ownerId ?? pending?.owner_id ?? null,
      1,
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
    `UPDATE session_metadata
       SET agent_id=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND bound=1`,
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
    `UPDATE session_metadata
       SET title=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND bound=1`,
    title,
    now(),
    c3Id,
  )
}

export function updateRowOwner(input: {
  sessionId: string
  vendor: VendorId
  ownerKind: SessionOwnerKind | null
  ownerId: string | null
}): void {
  const d = db()
  if (!d) return
  const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: input.sessionId })
  d.run(
    `UPDATE session_metadata
       SET owner_kind=?, owner_id=?, state_updated_at=?
     WHERE c3_id=? AND bound=1`,
    input.ownerKind,
    input.ownerId,
    now(),
    c3Id,
  )
}

export function upsertBoundRow(input: {
  sessionId: string
  workspacePath: string
  vendor: VendorId
  agentId: string
  title: string
  lastModified?: number | null
  sessionKind: SessionKind
  ownerKind?: SessionOwnerKind | null
  ownerId?: string | null
}): void {
  const d = db()
  if (!d) return
  const t = now()
  const c3Id = mintC3SessionId({ vendor: input.vendor, vendorSessionId: input.sessionId })
  d.run(
    `INSERT INTO session_metadata
       (c3_id, workspace_path, vendor, vendor_session_id, agent_id, title,
        last_modified, state, state_updated_at, kind, session_kind, owner_kind, owner_id, bound)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(c3_id) DO UPDATE SET
       workspace_path=excluded.workspace_path,
       vendor=excluded.vendor,
       vendor_session_id=excluded.vendor_session_id,
       agent_id=excluded.agent_id,
       title=excluded.title,
       last_modified=excluded.last_modified,
       state='alive',
       state_updated_at=excluded.state_updated_at,
       session_kind=excluded.session_kind,
       owner_kind=excluded.owner_kind,
       owner_id=excluded.owner_id,
       bound=1`,
    c3Id,
    input.workspacePath,
    input.vendor,
    input.sessionId,
    input.agentId,
    input.title,
    input.lastModified ?? t,
    'alive',
    t,
    'real',
    input.sessionKind,
    input.ownerKind ?? null,
    input.ownerId ?? null,
    1,
  )
}

function scheduleProjectionTitle(schedule: Schedule): string {
  const config = schedule.config
  if (config && typeof config === 'object') {
    const name = (config as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return `Schedule: ${name.trim()}`
  }
  return `Schedule execution ${schedule.id}`
}

export function upsertScheduleExecutionRow(input: {
  schedule: Schedule
  sessionId: string
  workspacePath: string
}): void {
  if (!input.sessionId) return
  upsertBoundRow({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    vendor: input.schedule.vendor,
    agentId: input.schedule.agentId ?? '',
    title: scheduleProjectionTitle(input.schedule),
    sessionKind: 'schedule',
    ownerKind: 'schedule',
    ownerId: input.schedule.id,
  })
}

/**
 * Run-end upsert (finalizeRun path — F-2). Single trigger for both run
 * paths (claude `run-lifecycle.ts` AND codex/opencode `run-via-driver.ts`
 * both call `finalizeRun` in their teardown). Updates `title`,
 * `last_modified`, and `agent_id` (the latter is a defensive re-stamp in
 * case the agent just swapped mid-run). A default placeholder title must not
 * overwrite an existing real title: Codex intent sessions can bind with the
 * intent title before the native JSONL title is readable at first run-end.
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
    `UPDATE session_metadata
       SET title=CASE
             WHEN ? IN ('New session', 'Untitled session')
              AND title NOT IN ('New session', 'Untitled session')
             THEN title
             ELSE ?
           END,
           last_modified=?, agent_id=?, state='alive', state_updated_at=?
     WHERE c3_id=? AND bound=1`,
    input.title,
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
  d.run('DELETE FROM session_metadata WHERE c3_id=? OR c3_id=?', c3Id, vendorSessionId)
}

export function deleteByOwner(ownerKind: SessionOwnerKind, ownerId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM session_metadata WHERE owner_kind=? AND owner_id=?', ownerKind, ownerId)
}

/** Delete by the raw pending id (used by `deleteSession` for a pending never run). */
export function deleteByPendingId(pendingId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM session_metadata WHERE c3_id=? AND bound=?', pendingId, 0)
}

// ---- Read API ----

/** Look up one row by its c3 id, or null if absent. */
export function getByC3Id(c3Id: string): SessionMetadataRow | null {
  const d = db()
  if (!d) return null
  const row = d.get<RawRow>('SELECT * FROM session_metadata WHERE c3_id=?', c3Id)
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
    'SELECT agent_id FROM session_metadata WHERE c3_id=? AND bound=0',
    pendingId,
  )
  return row ? { agentId: row.agent_id } : null
}

/**
 * The full table, sorted newest-first. The daily read path filters by
 * `workspace_path` at the SQL level (this returns everything for callers
 * that want the whole c3 — e.g. the rebuild path / debugging).
 */
export function listAll(): SessionMetadataRow[] {
  const d = db()
  if (!d) return []
  return d.all<RawRow>('SELECT * FROM session_metadata ORDER BY state_updated_at DESC').map(toRow)
}

/**
 * The read path: every real row for a workspace (pending rows are
 * excluded — they have no transcript yet, the wire filter is the
 * per-connection "viewed session" badge, not a list entry). Newest-first
 * by `last_modified` desc, with nulls (Codex bind-time) at the end. The
 * wire filter (isHiddenSession + isToolSessionRecorded) is applied
 * downstream in `listSessionsVia`; this returns the raw list.
 */
export function listForWorkspace(
  workspacePath: string,
  sessionKind: SessionKind = 'work',
): SessionMetadataRow[] {
  const d = db()
  if (!d) return []
  return d
    .all<RawRow>(
      `SELECT * FROM session_metadata
         WHERE workspace_path=? AND session_kind=? AND bound=1
         ORDER BY (last_modified IS NULL), last_modified DESC, state_updated_at DESC`,
      workspacePath,
      sessionKind,
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
  const where: string[] = ['workspace_path=?', 'bound=1', "session_kind='work'"]
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
    `SELECT COUNT(*) AS count FROM session_metadata WHERE ${where.join(' AND ')}`,
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
    `SELECT * FROM session_metadata
       WHERE workspace_path=? AND bound=1
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
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
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
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'orphaned',
          t,
          r.c3_id,
        )
      } else if (hit.title !== r.title || hit.lastModified !== r.last_modified) {
        d.run(
          `UPDATE session_metadata
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
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
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
  const allRows = d.all<RawRow>('SELECT * FROM session_metadata WHERE bound=?', 1)
  for (const r of allRows) {
    if (r.state === 'ghost' || r.state === 'orphaned') {
      // Still eligible for `alive` refresh on a successful native match.
    }
    const age = t - r.state_updated_at
    if (r.state === 'alive' || r.state === 'born') {
      if (age >= STALE_MS) {
        d.run(
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'stale',
          t,
          r.c3_id,
        )
        stale++
      }
      continue
    }
    // Stale / orphaned / ghost: re-check.
    const key = `${r.workspace_path}${r.vendor}`
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
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
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
      const r = d.get<RawRow>('SELECT * FROM session_metadata WHERE c3_id=?', id)
      if (!r) continue
      const hit = byNative.get(r.vendor_session_id ?? '')
      if (hit) {
        // Successful match ⇒ flip back to `alive` (or stay if already alive).
        d.run(
          `UPDATE session_metadata
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
          'UPDATE session_metadata SET state=?, state_updated_at=? WHERE c3_id=?',
          'orphaned',
          t,
          id,
        )
        orphaned++
      } else if (r.state === 'stale') {
        // First observation of `stale`; keep the state, just record the
        // sweep time so the next pass can transition to `orphaned`.
        d.run('UPDATE session_metadata SET state_updated_at=? WHERE c3_id=?', t, id)
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
      `INSERT OR REPLACE INTO session_metadata
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
