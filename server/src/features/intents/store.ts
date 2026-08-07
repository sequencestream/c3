/**
 * Intent-management domain store over {@link Db}.
 *
 * Owns the schema (created lazily, versioned via `PRAGMA user_version`) and all
 * intent / dependency / communication-session operations. Every
 * `workspacePath` is `resolve()`d so it matches the workspace registry key, the
 * runtime `workspacePath`, and the SDK `cwd` (otherwise lookups and the
 * hidden-session filter silently miss).
 *
 * Degradation: when the db is unavailable, reads return empty and writes throw
 * (callers surface an error or skip), so c3 keeps running without intents.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  DependencyInfo,
  DepType,
  IntentDeliveryRef,
  IntentDevSession,
  IntentDevSessionExitCode,
  IntentLog,
  IntentLogOperation,
  IntentPr,
  IntentPrForge,
  IntentSessionInfo,
  ProposedIntent,
  Intent,
  IntentPrStatus,
  IntentRunStatus,
  IntentStatus,
  IntentSpecMode,
  SpecReviewVerdict,
  SpecStatus,
} from '@ccc/shared/protocol'
import { INTENT_PR_STATUSES, SPEC_REVIEW_VERDICTS, SPEC_STATUSES } from '@ccc/shared/protocol'
import { pathToId } from '../../state.js'
import {
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../../kernel/infra/db.js'
import { getSddEnabled } from '../../kernel/config/index.js'
import { parsePrIdentity } from './pr-identity.js'
import { isIntentSpecMode, resolveEffectiveSpecMode } from './spec-mode.js'

const SCHEMA_VERSION = 20

/** Max persisted length of `short_en_title` (doc says VARCHAR(128); SQLite is TEXT). */
const SHORT_EN_TITLE_MAX = 128

/** Clamp a short English title to the persisted max length before writing. */
function truncateShortEnTitle(s: string): string {
  return s.length > SHORT_EN_TITLE_MAX ? s.slice(0, SHORT_EN_TITLE_MAX) : s
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  id              TEXT PRIMARY KEY,
  workspace_path    TEXT NOT NULL,
  title           TEXT NOT NULL,
  short_en_title  TEXT,
  content         TEXT NOT NULL,
  priority        TEXT NOT NULL,
  status          TEXT NOT NULL,
  module          TEXT NOT NULL DEFAULT '',
  last_work_session_id TEXT,
  automate        INTEGER NOT NULL DEFAULT 0,
  branch_name     TEXT,
  latest_commit_hash TEXT,
  pr_id           TEXT,
  pr_status       TEXT,
  spec_path         TEXT,
  spec_status       TEXT NOT NULL DEFAULT 'raw' CHECK(spec_status IN ('raw','pending','approved')),
  spec_mode         TEXT CHECK(spec_mode IN ('sdd','fast')),
  spec_approved     INTEGER NOT NULL DEFAULT 0,
  spec_approve_user TEXT,
  spec_session_id   TEXT,
  spec_review_session_id TEXT,
  spec_review_verdict    TEXT,
  spec_review_reason     TEXT,
  spec_review_at         INTEGER,
  spec_review_fingerprint TEXT,
  spec_review_rework_rounds INTEGER NOT NULL DEFAULT 0,
  spec_review_machine_blocked INTEGER NOT NULL DEFAULT 0,
  intent_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);

CREATE TABLE IF NOT EXISTS intent_deps (
  intent_id       TEXT NOT NULL,
  depends_on_id   TEXT NOT NULL,
  dep_type        TEXT NOT NULL DEFAULT 'blocks' CHECK(dep_type IN ('blocks','informs','soft_after')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (intent_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS intent_chats (
  session_id    TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  is_current    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_project ON intent_chats(workspace_path);

CREATE TABLE IF NOT EXISTS tool_sessions (
  session_id    TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  vendor        TEXT NOT NULL,
  summary       TEXT,
  start_at      INTEGER,
  end_at        INTEGER,
  exit_code     TEXT CHECK(exit_code IN ('success','failure','cancelled')),
  agent_id      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_session_intent ON intent_sessions(intent_id);

CREATE TABLE IF NOT EXISTS intent_logs (
  id              TEXT PRIMARY KEY,
  intent_id       TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_log_intent_created ON intent_logs(intent_id, created_at DESC);

-- Per-turn fast-spec settlement record: the baseline a fast-mode work turn
-- started from, plus the idempotency marker that stops a replayed settled event
-- (or a restart) from regenerating a reverse spec. One row per work session;
-- settled_at/outcome are null until the settle is processed, so the record
-- doubles as the launch→settle handshake.
CREATE TABLE IF NOT EXISTS intent_fast_turns (
  session_id     TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  baseline       TEXT NOT NULL,  -- JSON: repo path → HEAD commit (may be null per repo)
  settled_at     INTEGER,        -- null until this turn's settle is processed
  outcome        TEXT,           -- null until processed: 'no_change'|'small'|'over'|'failed'
  spec_path      TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_fast_turn_intent ON intent_fast_turns(intent_id);

-- One PR / Merge Request per row, replacing the intents.pr_id/pr_url/pr_status
-- trio (frozen, never dropped — they are the rollback script's landing site).
-- forge/repo are nullable so a backfilled row whose URL was missing or
-- unparseable can still exist as "origin unknown"; such a row does not
-- participate in the identity key and gets filled in by the next upsert.
CREATE TABLE IF NOT EXISTS intent_prs (
  id            TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL,
  delivery_id   TEXT,
  forge         TEXT,
  repo          TEXT,
  number        TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL,
  head_branch   TEXT,
  base_branch   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- One real PR, one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_identity ON intent_prs(forge, repo, number);
-- One PR per intent per delivery.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_delivery ON intent_prs(intent_id, delivery_id);
-- SQLite (like standard SQL) treats NULLs as distinct inside a unique index, so
-- while delivery_id is always NULL the index above constrains NOTHING. This
-- partial index is what actually enforces "at most one PR per intent" today.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_intent_nodelivery
  ON intent_prs(intent_id) WHERE delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_intent_pr_intent ON intent_prs(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_pr_status ON intent_prs(status);

-- 意图 ↔ 交付关联边。表由 delivery 域拥有 (写入唯一经 deliveries/store.ts);这里
-- 重复声明同一 DDL 是有意的:删除意图要在同一事务里清掉这些边,而一个从未打开过
-- 交付页的库里 delivery store 的 schema ensure 还没跑过,DELETE 会撞 "no such
-- table"。两处都是 IF NOT EXISTS, 先初始化的那个建表, 互不冲突。
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
`

/** Marker id for the one-shot legacy-columns → `intent_prs` backfill. */
const BACKFILL_INTENT_PRS_MIGRATION = 'intents.backfill_intent_prs.v1'

let schemaReady = false

/**
 * Idempotently add a column to an existing table when it's missing. Used for
 * backward-compatible migrations: a fresh db already has the column via SCHEMA,
 * so we check `PRAGMA table_info` rather than relying on `user_version` history.
 * Works on both `node:sqlite` and `bun:sqlite` (only `exec`/`all`).
 */
function ensureColumn(d: Db, table: string, col: string, decl: string): boolean {
  const cols = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (cols.some((c) => c.name === col)) return false
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  return true
}

function tableExists(d: Db, name: string): boolean {
  return !!d.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name)
}

function columnExists(d: Db, table: string, col: string): boolean {
  return d.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === col)
}

function indexExists(d: Db, name: string): boolean {
  return !!d.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", name)
}

/**
 * v5 → v6: rename the LEGACY `requirement*` tables / column / index to `intent*`
 * IN PLACE (zero data movement — the product renamed the concept "requirement" to
 * "intent"). The `requirement*` string literals below are the v5 ON-DISK names of
 * legacy databases; they MUST stay literal to be detected and migrated, so they are
 * exempt from the requirements→intents source rename (the one place old names live).
 *
 * MUST run BEFORE `exec(SCHEMA)`: SCHEMA now declares `CREATE TABLE IF NOT EXISTS
 * intents …`, so running it first on a legacy db would create an EMPTY `intents`
 * and strand the data under `requirements` (the later RENAME would then no-op).
 *
 * Idempotent and re-entrant on a PARTIAL-migration db: every step is independently
 * guarded via `sqlite_master` / `PRAGMA table_info`, so a db interrupted mid-rename
 * converges to the `intent*` terminal state on any re-run. Per the project DB
 * migration discipline, this NEVER drops a table — table renames use `ALTER … RENAME
 * TO`; the index rename uses `DROP INDEX` (an index, not a table) and lets SCHEMA's
 * `CREATE INDEX IF NOT EXISTS` rebuild it. Rollback is forward-fix only.
 */
function migrateLegacyTablesToIntents(d: Db): void {
  // Tables: rename only when the legacy name exists and the new one doesn't yet.
  if (tableExists(d, 'requirements') && !tableExists(d, 'intents')) {
    d.exec('ALTER TABLE requirements RENAME TO intents')
  }
  if (tableExists(d, 'requirement_deps') && !tableExists(d, 'intent_deps')) {
    d.exec('ALTER TABLE requirement_deps RENAME TO intent_deps')
  }
  if (tableExists(d, 'requirement_chats') && !tableExists(d, 'intent_chats')) {
    d.exec('ALTER TABLE requirement_chats RENAME TO intent_chats')
  }
  // Column: the lone legacy-named column lives on (the now-renamed) intent_deps.
  if (tableExists(d, 'intent_deps') && columnExists(d, 'intent_deps', 'requirement_id')) {
    d.exec('ALTER TABLE intent_deps RENAME COLUMN requirement_id TO intent_id')
  }
  // Index: SQLite has no RENAME INDEX — drop the old (the table rename re-pointed it
  // at `intents`) and let SCHEMA recreate `idx_intent_workspace_status`.
  if (indexExists(d, 'idx_req_project_status')) {
    d.exec('DROP INDEX idx_req_project_status')
  }
}

/**
 * v10 → v11: rename the workspace-key column `project_path` → `workspace_path` IN
 * PLACE on `intents` and `intent_chats` (zero data movement — the product renamed
 * the term "project" to "workspace" at the DB layer). DELIBERATELY DIVERGES from the
 * `projectConfigs` settings.json key, which keeps its legacy name for back-compat —
 * here the user chose to rename the DB columns through; see the 012 migration record.
 *
 * MUST run BEFORE `exec(SCHEMA)`: SCHEMA now declares `workspace_path` and the index
 * `idx_intent_workspace_status` on it, so creating the index before the rename would
 * reference a missing column. Order in db(): legacy rename → THIS → exec(SCHEMA).
 *
 * Idempotent + re-entrant: every step guards on `PRAGMA table_info` / `sqlite_master`,
 * so a db interrupted mid-rename converges on re-run. NEVER drops a table — columns use
 * `ALTER … RENAME COLUMN`; the composite index uses `DROP INDEX` (an index, not a table)
 * and lets SCHEMA's `CREATE INDEX IF NOT EXISTS` rebuild it under the new name. The
 * single-column `idx_chat_project` keeps its name — SQLite's RENAME COLUMN auto-updates
 * its column reference, so no drop/rebuild is needed.
 */
function migrateProjectPathToWorkspacePath(d: Db): void {
  for (const table of ['intents', 'intent_chats']) {
    if (
      tableExists(d, table) &&
      columnExists(d, table, 'project_path') &&
      !columnExists(d, table, 'workspace_path')
    ) {
      d.exec(`ALTER TABLE ${table} RENAME COLUMN project_path TO workspace_path`)
    }
  }
  // Composite index renamed (project_status → workspace_status): drop old, SCHEMA rebuilds.
  if (indexExists(d, 'idx_intent_project_status')) {
    d.exec('DROP INDEX idx_intent_project_status')
  }
}

/**
 * v14 → v15: rename the latest intent-launched execution session pointer from
 * `last_dev_session_id` to `last_work_session_id`.
 *
 * Fresh databases create only the new column. Existing databases converge before
 * SCHEMA runs: a pure old column is renamed in place; a partial migration with both
 * columns keeps the new value when present and backfills it from the old value only
 * when new is null. The old column may remain on such partial databases, but runtime
 * code reads and writes only `last_work_session_id`.
 */
function migrateLastDevSessionToLastWorkSession(d: Db): void {
  if (!tableExists(d, 'intents')) return
  const hasOld = columnExists(d, 'intents', 'last_dev_session_id')
  const hasNew = columnExists(d, 'intents', 'last_work_session_id')
  if (hasOld && !hasNew) {
    d.exec('ALTER TABLE intents RENAME COLUMN last_dev_session_id TO last_work_session_id')
    return
  }
  if (hasOld && hasNew) {
    d.run(
      `UPDATE intents
          SET last_work_session_id = last_dev_session_id
        WHERE last_work_session_id IS NULL
          AND last_dev_session_id IS NOT NULL`,
    )
  }
}

/**
 * v17 → v18: seed `spec_status` for rows that existed before the column did.
 * Runs EXACTLY once — the caller only invokes it in the pass that added the
 * column — so a later manual status change can never be overwritten by a restart.
 *
 * Deliberately conservative. An existing placeholder file cannot be told apart
 * from a genuinely authored one after the fact (and the seed's wording is not
 * evidence — a real spec may contain it), so every row that has a path but no
 * approval keeps its historic "awaiting approval" meaning as `pending`. The
 * `raw` fix therefore applies to specs authored from here on, not retroactively.
 */
function backfillSpecStatus(d: Db): void {
  d.run(
    `UPDATE intents
        SET spec_status = CASE
              WHEN spec_approved = 1 THEN 'approved'
              WHEN spec_path IS NOT NULL THEN 'pending'
              ELSE 'raw'
            END`,
  )
}

/**
 * Normalize a persisted timestamp to epoch-MILLIseconds. A handful of legacy rows
 * carry 10-digit epoch-SECONDS (see ADR-0034); anything below this bound cannot be
 * a plausible epoch-ms date and is scaled up.
 */
const EPOCH_MS_LOWER_BOUND = 100_000_000_000

function toEpochMs(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return Date.now()
  return value < EPOCH_MS_LOWER_BOUND ? value * 1000 : value
}

/** Narrow a persisted PR status; unknown/empty reads as the syncable non-terminal state. */
function narrowPrStatus(v: string | null | undefined): IntentPrStatus {
  return v !== null && v !== undefined && (INTENT_PR_STATUSES as readonly string[]).includes(v)
    ? (v as IntentPrStatus)
    : 'reviewing'
}

/**
 * v19 → v20: lift the legacy `pr_id` / `pr_url` / `pr_status` trio into `intent_prs`,
 * ONCE. Guarded by a `schema_migrations` marker rather than a column check: the
 * table's existence says nothing about whether its backfill finished, and this
 * migration must never run a second time (a re-run would collide with the identity
 * index, or worse, resurrect rows a later close had legitimately changed).
 *
 * The whole pass — inserts plus the marker — runs in ONE transaction, so a
 * non-constraint failure rolls back the rows AND the marker together and the next
 * start retries cleanly. There is no "backfilled halfway and marked done" state
 * to recover from.
 *
 * A row whose real-world identity `(forge, repo, number)` collides with one
 * already inserted is DEGRADED per row rather than fatal: legacy data does hold
 * two intents pointing at the same PR, and letting that duplicate take down the
 * whole transaction would leave the marker unwritten, so every subsequent start
 * re-runs the pass and fails again — the store never initializes. The colliding
 * row is skipped with a warning; every other row and the marker still land. The
 * first row to claim an identity wins (which intent that is follows the SELECT
 * order, so the loser is "the later duplicate").
 *
 * Row selection is `pr_id` non-empty: a row with `pr_status='merged'` but no
 * `pr_id` (these exist) has no PR identity to carry over. Those rows already
 * render as "no PR" in the UI, which keys off `prId`, so dropping them changes
 * nothing a user can see.
 *
 * `forge` / `repo` come from the URL (the only artefact that ever carried them);
 * an unparseable or absent URL leaves both null — "origin unknown" — which simply
 * opts that row out of the identity key until its next write.
 */
function backfillIntentPrs(d: Db): void {
  if (hasMigration(d, BACKFILL_INTENT_PRS_MIGRATION)) return
  const rows = d.all<{
    id: string
    pr_id: string | null
    pr_url: string | null
    pr_status: string | null
    branch_name: string | null
    updated_at: number | null
  }>(
    `SELECT id, pr_id, pr_url, pr_status, branch_name, updated_at
       FROM intents
      WHERE pr_id IS NOT NULL AND TRIM(pr_id) <> ''`,
  )
  tx(d, () => {
    for (const r of rows) {
      const { forge, repo } = parsePrIdentity(r.pr_url)
      const at = toEpochMs(r.updated_at)
      try {
        d.run(
          `INSERT INTO intent_prs
             (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(),
          r.id,
          null,
          forge,
          repo,
          (r.pr_id as string).trim(),
          r.pr_url,
          narrowPrStatus(r.pr_status),
          r.branch_name,
          // Every legacy PR targeted a literal `main` (ADR-0034); the column exists
          // so future rows can say otherwise, not so this one can guess.
          'main',
          at,
          at,
        )
      } catch (err) {
        // A duplicate PR identity is the one expected conflict here (the legacy
        // model could not express "same PR, two intents" and merely stored both).
        // Skip the row and keep the migration moving; any other error is real and
        // rolls the transaction back for the next start to retry.
        if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
          console.warn(
            `[c3:intents] backfill skipped intent ${r.id}: PR ${
              forge ?? 'unknown-forge'
            }/${repo ?? 'unknown-repo'}#${(r.pr_id as string).trim()} already carried by an earlier row`,
          )
          continue
        }
        throw err
      }
    }
    markMigration(d, BACKFILL_INTENT_PRS_MIGRATION)
  })
}

/** Return the db with the schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    // v5 → v6 rename MUST precede SCHEMA (see migrateLegacyTablesToIntents docstring).
    migrateLegacyTablesToIntents(d)
    // v10 → v11 project_path → workspace_path; MUST also precede SCHEMA (see docstring).
    migrateProjectPathToWorkspacePath(d)
    // v14 → v15 latest work-session pointer → work-session pointer; precedes SCHEMA so
    // fresh creation and legacy upgrades converge on the same runtime column.
    migrateLastDevSessionToLastWorkSession(d)
    d.exec(SCHEMA)
    // v1 → v2: add `module` to pre-existing intents tables (historic rows default to '').
    ensureColumn(d, 'intents', 'module', "TEXT NOT NULL DEFAULT ''")
    // v2 → v3: add nullable `completed_at` (historic rows stay null until re-marked done).
    ensureColumn(d, 'intents', 'completed_at', 'INTEGER')
    // v3 → v4: add `automate` (historic rows default to 0 — opt-in to automation).
    ensureColumn(d, 'intents', 'automate', 'INTEGER NOT NULL DEFAULT 0')
    // v7 → v8: add git tracking fields (nullable — historic rows stay null).
    ensureColumn(d, 'intents', 'branch_name', 'TEXT')
    ensureColumn(d, 'intents', 'latest_commit_hash', 'TEXT')
    ensureColumn(d, 'intents', 'pr_id', 'TEXT')
    ensureColumn(d, 'intents', 'pr_status', 'TEXT')
    // v6 → v7: add `title` to intent_chats (nullable — fallback to 'New Intent' or first-prompt derivation on the client).
    ensureColumn(d, 'intent_chats', 'title', 'TEXT')
    // v8 → v9: add dep_type + created_at to intent_deps (historic rows get defaults 'blocks' / 0).
    ensureColumn(d, 'intent_deps', 'dep_type', "TEXT NOT NULL DEFAULT 'blocks'")
    ensureColumn(d, 'intent_deps', 'created_at', 'INTEGER NOT NULL DEFAULT 0')
    // v11 → v12: add short_en_title (nullable — historic rows stay null until refined; used as the
    // stable ASCII source for deriving branch / worktree names).
    ensureColumn(d, 'intents', 'short_en_title', 'TEXT')
    // v12 → v13: add spec quality-gate + session fields (nullable, except spec_approved which
    // defaults 0). Persisted so approval state, spec path, and the spec/refine session ids
    // survive reconnect / refresh. Historic rows: spec_approved=0, the rest null.
    ensureColumn(d, 'intents', 'spec_path', 'TEXT')
    ensureColumn(d, 'intents', 'spec_approved', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(d, 'intents', 'spec_approve_user', 'TEXT')
    ensureColumn(d, 'intents', 'spec_session_id', 'TEXT')
    ensureColumn(d, 'intents', 'intent_session_id', 'TEXT')
    // v13 → v14: add pr_url (clickable PR link; nullable — historic rows stay null).
    // Distinct from latest_commit_hash; carries the PR's web URL alongside pr_id.
    ensureColumn(d, 'intents', 'pr_url', 'TEXT')
    // v14 → v15: latest intent-launched work-session pointer.
    ensureColumn(d, 'intents', 'last_work_session_id', 'TEXT')
    // v16 → v17: spec-review facts. The conclusion is bound to the spec content
    // fingerprint it was produced against, so editing the spec invalidates it
    // without any explicit clean-up pass. Historic rows read as "no conclusion,
    // 0 rework rounds, machine approval not suppressed" — no backfill needed.
    ensureColumn(d, 'intents', 'spec_review_session_id', 'TEXT')
    ensureColumn(d, 'intents', 'spec_review_verdict', 'TEXT')
    ensureColumn(d, 'intents', 'spec_review_reason', 'TEXT')
    ensureColumn(d, 'intents', 'spec_review_at', 'INTEGER')
    ensureColumn(d, 'intents', 'spec_review_fingerprint', 'TEXT')
    ensureColumn(d, 'intents', 'spec_review_rework_rounds', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(d, 'intents', 'spec_review_machine_blocked', 'INTEGER NOT NULL DEFAULT 0')
    // v17 → v18: spec_status — the tri-state that separates "not authored yet"
    // from "awaiting approval". A pre-existing db is backfilled ONCE, at the
    // moment the column appears, from the only facts it still has (see
    // `backfillSpecStatus`); a fresh db creates the column via SCHEMA and needs
    // no backfill (every row is inserted at the `raw` default).
    if (
      ensureColumn(
        d,
        'intents',
        'spec_status',
        "TEXT NOT NULL DEFAULT 'raw' CHECK(spec_status IN ('raw','pending','approved'))",
      )
    ) {
      backfillSpecStatus(d)
    }
    // v18 → v19: per-intent spec-mode override (nullable three-state). Historic
    // rows stay NULL and inherit the workspace's `sddEnabled`; a NULL passes the
    // CHECK (SQLite treats NULL as "not violating"), so explicit `sdd`/`fast`
    // and inheritance all coexist in one column. No backfill — old intents
    // continue to derive their mode exactly as before.
    ensureColumn(d, 'intents', 'spec_mode', "TEXT CHECK(spec_mode IN ('sdd','fast'))")
    // v19 → v20: PR facts move out of the intents row into `intent_prs`. The
    // legacy trio above is FROZEN, not dropped — runtime never reads or writes it
    // again, and it stays as the rollback script's landing site.
    backfillIntentPrs(d)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('需求库不可用 (c3.db unavailable)')
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

interface Row {
  id: string
  workspace_path: string
  title: string
  short_en_title: string | null
  content: string
  priority: string
  status: string
  module: string
  last_work_session_id: string | null
  automate: number
  branch_name: string | null
  latest_commit_hash: string | null
  // pr_id / pr_url / pr_status are deliberately ABSENT: the columns still exist on
  // disk (frozen, never dropped, the rollback script's landing site) but nothing in
  // the read model may see them. `SELECT *` still returns them; leaving them off
  // this interface is what makes a stray read a compile error.
  spec_path: string | null
  spec_status: string
  spec_mode: string | null
  spec_approved: number
  spec_approve_user: string | null
  spec_session_id: string | null
  spec_review_session_id: string | null
  spec_review_verdict: string | null
  spec_review_reason: string | null
  spec_review_at: number | null
  spec_review_fingerprint: string | null
  spec_review_rework_rounds: number
  spec_review_machine_blocked: number
  intent_session_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

/**
 * Narrow a persisted review verdict. An unknown / legacy value reads as "no
 * conclusion" rather than being surfaced verbatim — a conclusion the code cannot
 * interpret must never be treated as a pass.
 */
function narrowSpecReviewVerdict(v: string | null): SpecReviewVerdict | null {
  return v !== null && (SPEC_REVIEW_VERDICTS as readonly string[]).includes(v)
    ? (v as SpecReviewVerdict)
    : null
}

/**
 * Narrow a persisted spec status. An unknown / missing value fails CLOSED to
 * `raw`: an uninterpretable status must never admit development, start a review
 * or offer an approval. The compatibility boolean is deliberately NOT consulted
 * here — letting it repair the status would recreate the second admission path
 * this column exists to remove.
 */
function narrowSpecStatus(v: string | null): SpecStatus {
  return v !== null && (SPEC_STATUSES as readonly string[]).includes(v) ? (v as SpecStatus) : 'raw'
}

/**
 * Narrow a persisted spec mode. An unknown / missing value reads as unset
 * (`null` ⇒ inherit the workspace). Fail-closed direction: an uninterpretable
 * value must never be treated as `fast` by accident — it inherits, and the
 * workspace SDD switch decides.
 */
function narrowSpecMode(v: string | null): IntentSpecMode | null {
  return v !== null && isIntentSpecMode(v) ? v : null
}

/**
 * The deliveries each intent is linked to, keyed by intent id, in link order.
 *
 * Reads the delivery domain's `deliveries` table for the titles — a read-only
 * projection so the intent detail can render "关联交付" (writing the edge stays
 * a delivery-domain action). `deliveries` is created lazily by the delivery
 * store, so a workspace that never opened the delivery page degrades to "no
 * links" instead of throwing.
 */
function listLinkedDeliveriesByIntentIds(
  d: Db,
  intentIds: string[],
): Map<string, IntentDeliveryRef[]> {
  const out = new Map<string, IntentDeliveryRef[]>()
  if (intentIds.length === 0) return out
  if (!tableExists(d, 'intent_deliveries') || !tableExists(d, 'deliveries')) return out
  const placeholders = intentIds.map(() => '?').join(',')
  const rows = d.all<{ intent_id: string; id: string; title: string }>(
    `SELECT e.intent_id AS intent_id, dl.id AS id, dl.title AS title
       FROM intent_deliveries e
       JOIN deliveries dl ON dl.id = e.delivery_id
      WHERE e.intent_id IN (${placeholders})
      ORDER BY e.created_at ASC, e.rowid ASC`,
    ...intentIds,
  )
  for (const r of rows) {
    const list = out.get(r.intent_id)
    if (list) list.push({ id: r.id, title: r.title })
    else out.set(r.intent_id, [{ id: r.id, title: r.title }])
  }
  return out
}

/**
 * Attach `dependsOn`, `dependsOnTypes`, `prs` and `linkedDeliveries` to a set of
 * rows, preserving row order. Deps, PRs and delivery links are each fetched in
 * ONE batched query for the whole set — a per-intent query would turn every list
 * broadcast into N round-trips.
 */
function hydrate(d: Db, rows: Row[]): Intent[] {
  if (rows.length === 0) return []
  const prsById = listIntentPrsByIntentIds(
    d,
    rows.map((r) => r.id),
  )
  const deliveriesById = listLinkedDeliveriesByIntentIds(
    d,
    rows.map((r) => r.id),
  )
  const byId = new Map<string, string[]>()
  const typesById = new Map<string, Record<string, DepType>>()
  for (const r of rows) {
    byId.set(r.id, [])
    typesById.set(r.id, {})
  }
  const placeholders = rows.map(() => '?').join(',')
  const deps = d.all<{ intent_id: string; depends_on_id: string; dep_type: string }>(
    `SELECT intent_id, depends_on_id, dep_type FROM intent_deps WHERE intent_id IN (${placeholders})`,
    ...rows.map((r) => r.id),
  )
  for (const dep of deps) {
    byId.get(dep.intent_id)?.push(dep.depends_on_id)
    const types = typesById.get(dep.intent_id)
    if (types) types[dep.depends_on_id] = dep.dep_type as DepType
  }
  return rows.map((r) => ({
    id: r.id,
    workspaceId: pathToId(r.workspace_path)!,
    title: r.title,
    shortEnTitle: r.short_en_title,
    content: r.content,
    priority: r.priority as Intent['priority'],
    module: r.module,
    status: r.status as IntentStatus,
    dependsOn: byId.get(r.id) ?? [],
    dependsOnTypes: typesById.get(r.id) ?? {},
    lastWorkSessionId: r.last_work_session_id,
    automate: r.automate === 1,
    branchName: r.branch_name,
    latestCommitHash: r.latest_commit_hash,
    prs: prsById.get(r.id) ?? [],
    linkedDeliveries: deliveriesById.get(r.id) ?? [],
    specPath: r.spec_path,
    specStatus: narrowSpecStatus(r.spec_status),
    specMode: narrowSpecMode(r.spec_mode),
    // The effective mode is resolved HERE — the single read-model boundary — so
    // the admission gate, the settle hook and every client read the SAME value
    // instead of re-deriving it against a possibly-stale setting snapshot.
    effectiveSpecMode: resolveEffectiveSpecMode(
      narrowSpecMode(r.spec_mode),
      getSddEnabled(r.workspace_path),
    ),
    specApproved: r.spec_approved === 1,
    specApproveUser: r.spec_approve_user,
    specSessionId: r.spec_session_id,
    specReviewSessionId: r.spec_review_session_id,
    specReviewVerdict: narrowSpecReviewVerdict(r.spec_review_verdict),
    specReviewReason: r.spec_review_reason,
    specReviewAt: r.spec_review_at,
    specReviewFingerprint: r.spec_review_fingerprint,
    specReviewReworkRounds: r.spec_review_rework_rounds ?? 0,
    specReviewMachineApprovalBlocked: r.spec_review_machine_blocked === 1,
    intentSessionId: r.intent_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    runStatus: 'idle' as IntentRunStatus,
    // Derived at send-time by enrichRunStatus from the live run registry.
    sessionActive: false,
    // Derived at send-time by enrichRunStatus from the recorded vendor-block facts.
    actionDescriptor: null,
  }))
}

// ---- Intents ----

/** A project's intents (optionally status-filtered), priority then recency. */
export function listIntents(workspacePath: string, status?: IntentStatus): Intent[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  const rows = status
    ? d.all<Row>(
        'SELECT * FROM intents WHERE workspace_path=? AND status=? ORDER BY priority ASC, updated_at DESC',
        proj,
        status,
      )
    : d.all<Row>(
        'SELECT * FROM intents WHERE workspace_path=? ORDER BY priority ASC, updated_at DESC',
        proj,
      )
  return hydrate(d, rows)
}

/**
 * Status → count for a project's intents, optionally restricted to rows whose
 * `updated_at` falls in `[startTime, endTime]` (ms epoch; either bound may be
 * omitted). Statuses with no matching rows are absent from the map. Returns an
 * empty map when the db is unavailable (graceful degradation, never throws).
 */
export function countByStatusInRange(
  workspacePath: string,
  startTime?: number,
  endTime?: number,
): Record<string, number> {
  const d = db()
  if (!d) return {}
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
  const rows = d.all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM intents WHERE ${where.join(' AND ')} GROUP BY status`,
    ...params,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status] = r.count
  return out
}

export function getIntent(id: string): Intent | null {
  const d = db()
  if (!d) return null
  const row = d.get<Row>('SELECT * FROM intents WHERE id=?', id)
  return row ? hydrate(d, [row])[0] : null
}

/**
 * The intent whose spec-AUTHORING session is `sessionId`, or `null`. The reverse
 * of `spec_session_id`, for run-lifecycle handlers that only hold the settled
 * session id. `spec_session_id` is single-valued per intent, so at most one row
 * can match.
 */
export function getIntentBySpecSessionId(sessionId: string): Intent | null {
  const d = db()
  if (!d) return null
  const row = d.get<Row>('SELECT * FROM intents WHERE spec_session_id=?', sessionId)
  return row ? hydrate(d, [row])[0] : null
}

/** Delete an intent and every ledger row owned by or pointing at it atomically. */
export function deleteIntentRecords(intentId: string): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM intent_deps WHERE intent_id=? OR depends_on_id=?', intentId, intentId)
    d.run('DELETE FROM intent_sessions WHERE intent_id=?', intentId)
    d.run('DELETE FROM intent_logs WHERE intent_id=?', intentId)
    d.run('DELETE FROM intent_fast_turns WHERE intent_id=?', intentId)
    d.run('DELETE FROM intent_prs WHERE intent_id=?', intentId)
    // 关联边随意图消失,但远端 PR 不动 —— 与本函数其它清理一致:清本地台账/git/会话,
    // 从不代用户在 forge 上做不可逆的事。
    d.run('DELETE FROM intent_deliveries WHERE intent_id=?', intentId)
    d.run('DELETE FROM intents WHERE id=?', intentId)
  })
}

/** Escape LIKE wildcards so a keyword matches literally (paired with `ESCAPE '\'`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Search a project's intents for the read-only intent agent's
 * `find_intents` tool. Filters compose with AND; all are optional:
 *  - `keyword` — case-handled LIKE substring over `title` OR `content` (wildcards escaped).
 *  - `module` / `status` — exact-match column filters.
 * Same `(workspace_path)` scoping + `resolve()` as the rest of the store, so the
 * agent can never read another project's ledger. Ordered like `listIntents`
 * (priority asc, then recency). Returns `[]` when the db is unavailable.
 */
export function findIntents(
  workspacePath: string,
  filter: { keyword?: string; module?: string; status?: IntentStatus } = {},
): Intent[] {
  const d = db()
  if (!d) return []
  const where: string[] = ['workspace_path=?']
  const params: (string | number)[] = [resolve(workspacePath)]
  if (filter.keyword) {
    where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(filter.keyword)}%`
    params.push(like, like)
  }
  if (filter.module) {
    where.push('module=?')
    params.push(filter.module)
  }
  if (filter.status) {
    where.push('status=?')
    params.push(filter.status)
  }
  const rows = d.all<Row>(
    `SELECT * FROM intents WHERE ${where.join(' AND ')} ORDER BY priority ASC, updated_at DESC`,
    ...params,
  )
  return hydrate(d, rows)
}

/**
 * Resolve each item's effective dependency-id list for a batch insert (RM-R17),
 * given the ids freshly minted for the SAME batch (`ids[i]` belongs to `items[i]`).
 *
 * Two sources are merged & de-duplicated per item:
 *  - `dependsOn` — ids of intents that already exist in the ledger (unchanged).
 *  - `dependsOnIndexes` — 0-based indexes into THIS batch, resolved to the sibling's
 *    `ids[index]`. Lets a batch express its own先后关系 before any row has an id.
 *
 * Pure (items + ids in, id-lists out) so the validation is unit-testable without a
 * db. Throws — rejecting the WHOLE batch — when an index reference is out of range,
 * points at itself, or forms a cycle among the batch's intra-batch edges (existing-id
 * deps can't form a cycle with brand-new rows, so only index edges are checked).
 */
export function resolveBatchDependencies(
  items: Pick<ProposedIntent, 'dependsOn' | 'dependsOnIndexes'>[],
  ids: string[],
): string[][] {
  const n = items.length
  // Validate index references and collect the intra-batch edge list per item.
  const idxEdges: number[][] = items.map((it, i) => {
    const refs = it.dependsOnIndexes ?? []
    for (const j of refs) {
      if (!Number.isInteger(j) || j < 0 || j >= n) {
        throw new Error(`批内依赖下标越界:第 ${i} 条引用了不存在的下标 ${j}(有效范围 0..${n - 1})`)
      }
      if (j === i) {
        throw new Error(`批内依赖不能自引用:第 ${i} 条依赖了自身`)
      }
    }
    return refs
  })
  detectBatchCycle(idxEdges)
  // Merge existing-id deps with the resolved sibling ids, de-duplicated.
  return items.map((it, i) => {
    const merged = new Set<string>(it.dependsOn ?? [])
    for (const j of idxEdges[i]) merged.add(ids[j])
    return [...merged]
  })
}

/** Throw if the intra-batch index edges contain a cycle (3-colour DFS). */
function detectBatchCycle(edges: number[][]): void {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colour = new Array<number>(edges.length).fill(WHITE)
  const visit = (n: number): void => {
    colour[n] = GRAY
    for (const m of edges[n]) {
      if (colour[m] === GRAY) {
        throw new Error(`批内依赖成环:第 ${n} 条与第 ${m} 条互相依赖`)
      }
      if (colour[m] === WHITE) visit(m)
    }
    colour[n] = BLACK
  }
  for (let i = 0; i < edges.length; i++) {
    if (colour[i] === WHITE) visit(i)
  }
}

/**
 * Insert a batch of proposed intents in one transaction. New rows land as
 * `initialStatus` (default `todo`); the automation-only `save_intent_directly`
 * tool passes `draft` so unattended proposals wait for human review.
 */
export function insertIntents(
  workspacePath: string,
  items: ProposedIntent[],
  initialStatus: IntentStatus = 'todo',
): Intent[] {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  // Mint every id up front so intra-batch `dependsOnIndexes` can resolve to a real
  // sibling id; validate + resolve BEFORE any write so an invalid batch (out-of-range
  // / self / cyclic) rejects atomically with nothing persisted (RM-R17).
  const ids: string[] = items.map(() => randomUUID())
  const deps = resolveBatchDependencies(items, ids)
  tx(d, () => {
    items.forEach((it, i) => {
      // Stagger created_at by batch index so same-priority, dependency-free items keep
      // a stable, submission-order rank in the orchestrator's `createdAt` tiebreak —
      // a single shared `now` left them arbitrarily ordered (RM-A3).
      const createdAt = now + i
      d.run(
        `INSERT INTO intents
           (id, workspace_path, title, short_en_title, content, priority, status, module, last_work_session_id, created_at, updated_at, completed_at, branch_name, latest_commit_hash, spec_mode)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ids[i],
        proj,
        it.title,
        truncateShortEnTitle(it.shortEnTitle),
        it.content,
        it.priority,
        initialStatus,
        it.module ?? '',
        null,
        createdAt,
        createdAt,
        null,
        null,
        null,
        it.specMode ?? null,
      )
      for (const dep of deps[i]) {
        d.run(
          'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
          ids[i],
          dep,
          'blocks',
          createdAt,
        )
      }
    })
  })
  // Re-read so callers get fully-hydrated rows (incl. dependsOn).
  const placeholders = ids.map(() => '?').join(',')
  const rows = d.all<Row>(`SELECT * FROM intents WHERE id IN (${placeholders})`, ...ids)
  // Preserve insertion order.
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return hydrate(d, rows)
}

/**
 * Upsert a batch of proposed intents in ONE transaction (RM-R18).
 *
 * Each item is an INSERT (no `id`) or an UPDATE (carries `id`). All validation runs
 * BEFORE any write so the whole batch is atomic — any failure rejects it with nothing
 * persisted:
 *  - an UPDATE `id` must resolve to an intent in THIS project (else throw);
 *  - an UPDATE target in `in_progress` or `done` is immutable → throw (caller surfaces
 *    a "正在开发 / 已完成,不可修改" message);
 *  - `dependsOnIndexes` out-of-range / self / cyclic → throw (resolveBatchDependencies).
 *
 * Status rules on UPDATE: `draft`/`todo` keep their status; `cancelled` is reactivated
 * to `todo` (completed_at stays null per the updateStatus rule). New rows insert as
 * `todo`. Un-supplied optional fields are preserved: `module` keeps its prior value when
 * omitted, and deps are only rewritten when `dependsOn`/`dependsOnIndexes` is supplied.
 * `dependsOnIndexes` resolves against the FULL batch, so a new item can depend (by index)
 * on an updated sibling and vice-versa.
 *
 * An UPDATE whose `title` or `content` actually differs from the stored row is a NEW
 * requirement, so the approval that was granted for the OLD text stops counting: the
 * same statement clears `spec_approved` / `spec_approve_user` and vetoes the standing
 * review conclusion (`spec_review_machine_blocked=1`). The veto is what makes this
 * real — the spec FILE is untouched here, so its fingerprint still matches the stored
 * `pass`, and a machine-approval workspace would otherwise approve the rewritten intent
 * straight back on the next tick. Only a fresh conclusion (a rewritten spec) or a human
 * approval lifts it. Approval revocation is audited with a `spec_unapproved` entry, and
 * an already-unapproved intent produces no such entry. Metadata-only edits (priority,
 * module, deps, shortEnTitle, back-link, `cancelled` reactivation) leave approval alone.
 * The comparison is exact equality against the stored values — the caller cannot declare
 * or skip it, and no attempt is made to judge two texts "equivalent".
 *
 * `actor` feeds the lifecycle log (`intent_created` / `intent_updated` per item);
 * callers with no user context omit it and the entries land as `'system'`.
 */
export function upsertIntents(
  workspacePath: string,
  items: ProposedIntent[],
  actor?: string | null,
): Intent[] {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  // Single-intent comm back-link: write `intent_session_id` ONLY when the batch holds
  // exactly one item carrying it. A multi-item batch (>1) NEVER writes it — there is no
  // single source session for a batch — so the field is forced to null regardless of
  // what was supplied. This is the falling-back half of the double-guard (the schema
  // description is the other half). On UPDATE the column is COALESCE-protected so an
  // absent value preserves any existing back-link (e.g. the refine `run:bound` fill).
  const sessionIdParam = items.length === 1 ? (items[0].intentSessionId ?? null) : null
  // Resolve every item to a stable id up front: the existing id for updates, a fresh
  // uuid for inserts. dependsOnIndexes then resolves against THIS id array regardless of
  // whether the referenced sibling is brand-new or being updated.
  const ids: string[] = items.map((it) => it.id ?? randomUUID())
  // Pre-validate UPDATE targets (existence + project binding + status lock) BEFORE
  // resolving deps, so an immutable / foreign / unknown id rejects the batch atomically.
  const priors = items.map((it) => {
    if (it.id === undefined) return null
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', it.id)
    if (!row || row.workspace_path !== proj) {
      throw new Error(`无法更新意图 ${it.id}:它在本项目中不存在`)
    }
    if (row.status === 'in_progress' || row.status === 'done') {
      const why = row.status === 'in_progress' ? '正在开发' : '已完成'
      throw new Error(`意图 ${it.id}(${row.title})${why},不可修改`)
    }
    return row
  })
  // Validate + resolve intra-batch deps (out-of-range / self / cyclic throws here).
  const deps = resolveBatchDependencies(items, ids)
  tx(d, () => {
    items.forEach((it, i) => {
      const prior = priors[i]
      // Whether this item supplied its dependency set; only then do we rewrite deps.
      const depsSupplied = it.dependsOn !== undefined || it.dependsOnIndexes !== undefined
      if (prior) {
        // UPDATE: cancelled → todo (reactivate); else keep status. Neither outcome is
        // `done`, so completed_at is always cleared to null.
        const status: IntentStatus =
          prior.status === 'cancelled' ? 'todo' : (prior.status as IntentStatus)
        const module = it.module !== undefined ? it.module : prior.module
        // The requirement text itself changed → the old approval no longer applies.
        const requirementChanged = it.title !== prior.title || it.content !== prior.content
        // The status moves with the compatibility fields: an approved spec falls
        // back to `pending` (its content is still authored, it just no longer
        // has an approval), while a spec that was never approved keeps whatever
        // state it had — a rewritten intent does not make a seed look authored.
        const revokeApproval = requirementChanged
          ? `, spec_approved=0, spec_approve_user=NULL, spec_review_machine_blocked=1,
             spec_status=CASE WHEN spec_status='approved' THEN 'pending' ELSE spec_status END`
          : ''
        // Per-intent spec mode: three-state, deliberately distinct. An ABSENT
        // value preserves the current mode (a routine intent edit must not clear
        // or change it); an EXPLICIT `null` clears an override back to
        // inheritance; `'sdd'`/`'fast'` pins it. The CASE distinguishes absence
        // from explicit-null via a flag column so `NULL` alone never means both.
        const specModeSupplied = it.specMode !== undefined
        const specModeValue = it.specMode ?? null
        d.run(
          `UPDATE intents
             SET title=?, short_en_title=?, content=?, priority=?, module=?, status=?, intent_session_id=COALESCE(?, intent_session_id), updated_at=?, completed_at=?, spec_mode=CASE WHEN ?=1 THEN ? ELSE spec_mode END${revokeApproval}
           WHERE id=?`,
          it.title,
          truncateShortEnTitle(it.shortEnTitle),
          it.content,
          it.priority,
          module,
          status,
          sessionIdParam,
          now,
          null,
          specModeSupplied ? 1 : 0,
          specModeValue,
          ids[i],
        )
        // Audit the revocation in the SAME transaction as the rewrite, so a crash can
        // never leave "new content + old approval" — or a revoked approval with no
        // trace of why. Only an approval that actually existed is logged.
        if (requirementChanged && prior.spec_approved === 1) {
          safeInsertIntentLog(
            ids[i],
            'spec_unapproved',
            '意图标题/正文被更新后撤销 spec 批准',
            actor ?? 'system',
          )
        }
        if (depsSupplied) {
          d.run('DELETE FROM intent_deps WHERE intent_id=?', ids[i])
          for (const dep of deps[i]) {
            d.run(
              'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
              ids[i],
              dep,
              'blocks',
              now,
            )
          }
        }
      } else {
        // INSERT: stagger created_at by batch index for a stable submission-order rank.
        const createdAt = now + i
        d.run(
          `INSERT INTO intents
             (id, workspace_path, title, short_en_title, content, priority, status, module, last_work_session_id, created_at, updated_at, completed_at, branch_name, latest_commit_hash, intent_session_id, spec_mode)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ids[i],
          proj,
          it.title,
          truncateShortEnTitle(it.shortEnTitle),
          it.content,
          it.priority,
          'todo',
          it.module ?? '',
          null,
          createdAt,
          createdAt,
          null,
          null,
          null,
          sessionIdParam,
          it.specMode ?? null,
        )
        for (const dep of deps[i]) {
          d.run(
            'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
            ids[i],
            dep,
            'blocks',
            createdAt,
          )
        }
      }
    })
  })
  // Lifecycle log: one entry per item, INSERT vs UPDATE decided by the pre-read
  // `priors`. Outside the tx on purpose — a log failure must never roll back the
  // business write.
  items.forEach((it, i) => {
    const created = priors[i] === null
    safeInsertIntentLog(
      ids[i],
      created ? 'intent_created' : 'intent_updated',
      created ? `创建意图: ${it.title}` : `更新意图: ${it.title}`,
      actor ?? 'system',
    )
  })
  // Re-read so callers get fully-hydrated rows (incl. dependsOn), in batch order.
  const placeholders = ids.map(() => '?').join(',')
  const rows = d.all<Row>(`SELECT * FROM intents WHERE id IN (${placeholders})`, ...ids)
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return hydrate(d, rows)
}

/** Create the lightweight, human-registered placeholder intent in one transaction. */
export function createEmptyIntent(workspacePath: string, actor?: string | null): Intent {
  const d = requireDb()
  const id = randomUUID()
  const proj = resolve(workspacePath)
  const now = Date.now()
  tx(d, () => {
    d.run(
      `INSERT INTO intents
         (id, workspace_path, title, short_en_title, content, priority, status, module,
          last_work_session_id, automate, branch_name, latest_commit_hash,
          spec_path, spec_approved, spec_approve_user, spec_session_id, intent_session_id,
          created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      proj,
      'new intent',
      null,
      '',
      'P2',
      'draft',
      '',
      null,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      now,
      now,
      null,
    )
    d.run(
      'INSERT INTO intent_logs (id, intent_id, operation_type, summary, actor, created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      id,
      'intent_created',
      '创建意图: new intent',
      actor ?? 'system',
      now,
    )
  })
  return getIntent(id)!
}

/** Delete only a draft that has no session/spec/work/git/PR downstream assets. */
export function deleteEmptyDraftIntent(id: string): void {
  const d = requireDb()
  const row = d.get<Row>('SELECT * FROM intents WHERE id=?', id)
  if (!row) throw new Error('intent not found')
  const guarded =
    row.status === 'draft' &&
    row.intent_session_id === null &&
    row.spec_session_id === null &&
    row.spec_path === null &&
    row.last_work_session_id === null &&
    row.branch_name === null &&
    row.latest_commit_hash === null &&
    !hasIntentPrs(id)
  if (!guarded) throw new Error('intent has downstream assets')
  tx(d, () => {
    d.run('DELETE FROM intent_deps WHERE intent_id=? OR depends_on_id=?', id, id)
    d.run('DELETE FROM intent_logs WHERE intent_id=?', id)
    d.run('DELETE FROM intents WHERE id=?', id)
  })
}

/**
 * Guard: is the `from → to` status transition legal?
 *
 * Transition graph (7-state):
 * ```
 * draft ⇄ todo ──→ in_progress ──→ failed ──→ todo
 *   │        │            │            │
 *   │        │            └──→ blocked ──→ todo
 *   │        │                 │
 *   │        └──→ cancelled    └──→ cancelled
 *   │
 *   └──→ blocked
 *   └──→ cancelled
 *
 *              in_progress ──→ done
 * ```
 * `draft ⇄ todo` is bidirectional: `draft → todo` is the normal promotion, and
 * `todo → draft` is a manual revert (the only backward edge into a non-terminal
 * earlier state, exposed by the intent detail title-bar buttons).
 * Terminal states (`done`, `cancelled`) have no outgoing edges.
 * Same-state transitions are always allowed (no-op).
 */
export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  if (from === to) return true
  const ALLOWED: Record<IntentStatus, readonly IntentStatus[]> = {
    draft: ['todo', 'cancelled', 'blocked'],
    todo: ['draft', 'in_progress', 'cancelled', 'blocked'],
    in_progress: ['done', 'cancelled', 'blocked', 'failed'],
    done: [],
    cancelled: [],
    blocked: ['todo', 'cancelled'],
    failed: ['todo', 'cancelled'],
  }
  return (ALLOWED[from] as readonly IntentStatus[]).includes(to)
}

/**
 * Update an intent's work status. `actor` feeds the lifecycle log's
 * `status_changed` entry: handlers pass the login subject; callers with no user
 * context (reconcile, orchestrator, PR reconciliation tools) omit it and the
 * entry lands as `'automation'`. A same-status write logs nothing.
 */
export function updateStatus(id: string, status: IntentStatus, actor?: string | null): void {
  const d = requireDb()
  const prior = d.get<{ status: string }>('SELECT status FROM intents WHERE id=?', id)
  const now = Date.now()
  // `done` stamps the completion time; any other status clears it (covers reverting from done).
  const completedAt = status === 'done' ? now : null
  d.run(
    'UPDATE intents SET status=?, updated_at=?, completed_at=? WHERE id=?',
    status,
    now,
    completedAt,
    id,
  )
  if (prior && prior.status !== status) {
    safeInsertIntentLog(
      id,
      'status_changed',
      `状态变更: ${prior.status} → ${status}`,
      actor ?? 'automation',
    )
  }
}

/** Toggle a intent's automation flag (whether the orchestrator may pick it). */
export function setAutomate(id: string, automate: boolean): void {
  const d = requireDb()
  d.run('UPDATE intents SET automate=?, updated_at=? WHERE id=?', automate ? 1 : 0, Date.now(), id)
}

export function setLastWorkSession(id: string, sessionId: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET last_work_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/** Set the git branch name for an intent (called after work session launch). */
export function setBranchName(id: string, branchName: string): void {
  const d = requireDb()
  d.run('UPDATE intents SET branch_name=?, updated_at=? WHERE id=?', branchName, Date.now(), id)
}

/** Set the latest known commit hash for an intent's dev branch. */
export function setLatestCommitHash(id: string, commitHash: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET latest_commit_hash=?, updated_at=? WHERE id=?',
    commitHash,
    Date.now(),
    id,
  )
}

// ---------------------------------------------------------------------------
// intent_prs — the single PR write entry point plus its read surface
// ---------------------------------------------------------------------------

interface PrRow {
  id: string
  intent_id: string
  delivery_id: string | null
  forge: string | null
  repo: string | null
  number: string
  url: string | null
  status: string
  head_branch: string | null
  base_branch: string | null
  created_at: number
  updated_at: number
}

function toIntentPr(r: PrRow): IntentPr {
  return {
    id: r.id,
    intentId: r.intent_id,
    deliveryId: r.delivery_id,
    forge: r.forge === 'github' || r.forge === 'gitlab' ? r.forge : null,
    repo: r.repo,
    number: r.number,
    url: r.url,
    status: narrowPrStatus(r.status),
    headBranch: r.head_branch,
    baseBranch: r.base_branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Stable PR ordering: oldest first, ties broken by number so it never flickers. */
const PR_ORDER_BY = 'ORDER BY created_at ASC, number ASC'

export interface UpsertIntentPrInput {
  intentId: string
  /** Delivery binding; omitted / null means "no delivery". */
  deliveryId?: string | null
  /** In-repo PR / MR number — required, it is half the PR's identity. */
  number: string
  status: IntentPrStatus
  /**
   * Fields that are only overwritten when explicitly supplied. `undefined` leaves
   * the stored value alone (a status-only update must not blank out a known URL);
   * an explicit `null` clears it.
   */
  forge?: IntentPrForge | null
  repo?: string | null
  url?: string | null
  headBranch?: string | null
  baseBranch?: string | null
}

/**
 * The ONE way PR facts are written. Nothing else may `UPDATE intent_prs` — a
 * second write path is how the two unique keys below start disagreeing with
 * reality.
 *
 * A transactional look-up-then-write rather than `ON CONFLICT`: the table has TWO
 * unique keys (PR identity and intent+delivery) and a single upsert statement can
 * only name one conflict target.
 *
 * 1. Match on `(forge, repo, number)`. A hit belonging to a DIFFERENT intent
 *    throws: one real PR cannot be re-hung on another intent, and doing it
 *    silently would be a data incident, not a convenience.
 * 2. Otherwise match on `(intent_id, delivery_id)` — this is what carries "the
 *    intent replaced its PR" and every status advance. The delivery comparison
 *    MUST branch on NULL (`IS NULL` vs `= ?`): with `delivery_id` null, `=` never
 *    matches, the lookup would fall through to an insert, and the partial unique
 *    index would reject it. Same NULL trap as the index, seen from the other side.
 * 3. No match ⇒ insert.
 *
 * Updates touch only the supplied fields and refresh `updated_at`; `created_at`
 * never moves.
 */
export function upsertIntentPr(input: UpsertIntentPrInput): IntentPr {
  const d = requireDb()
  const deliveryId = input.deliveryId ?? null
  const number = input.number.trim()
  if (!number) throw new Error('PR 编号不能为空')

  return tx(d, () => {
    let existing: PrRow | undefined
    if (input.forge && input.repo) {
      existing = d.get<PrRow>(
        'SELECT * FROM intent_prs WHERE forge=? AND repo=? AND number=?',
        input.forge,
        input.repo,
        number,
      )
      if (existing && existing.intent_id !== input.intentId) {
        throw new Error(
          `PR ${input.forge}:${input.repo}#${number} 已归属意图 ${existing.intent_id},不能改挂到 ${input.intentId}`,
        )
      }
    }
    if (!existing) {
      existing =
        deliveryId === null
          ? d.get<PrRow>(
              'SELECT * FROM intent_prs WHERE intent_id=? AND delivery_id IS NULL',
              input.intentId,
            )
          : d.get<PrRow>(
              'SELECT * FROM intent_prs WHERE intent_id=? AND delivery_id=?',
              input.intentId,
              deliveryId,
            )
    }

    const now = Date.now()
    if (existing) {
      const next: PrRow = {
        ...existing,
        number,
        status: input.status,
        forge: input.forge !== undefined ? input.forge : existing.forge,
        repo: input.repo !== undefined ? input.repo : existing.repo,
        url: input.url !== undefined ? input.url : existing.url,
        head_branch: input.headBranch !== undefined ? input.headBranch : existing.head_branch,
        base_branch: input.baseBranch !== undefined ? input.baseBranch : existing.base_branch,
        updated_at: now,
      }
      d.run(
        `UPDATE intent_prs
            SET forge=?, repo=?, number=?, url=?, status=?, head_branch=?, base_branch=?, updated_at=?
          WHERE id=?`,
        next.forge,
        next.repo,
        next.number,
        next.url,
        next.status,
        next.head_branch,
        next.base_branch,
        next.updated_at,
        next.id,
      )
      return toIntentPr(next)
    }

    const row: PrRow = {
      id: randomUUID(),
      intent_id: input.intentId,
      delivery_id: deliveryId,
      forge: input.forge ?? null,
      repo: input.repo ?? null,
      number,
      url: input.url ?? null,
      status: input.status,
      head_branch: input.headBranch ?? null,
      base_branch: input.baseBranch ?? null,
      created_at: now,
      updated_at: now,
    }
    d.run(
      `INSERT INTO intent_prs
         (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.intent_id,
      row.delivery_id,
      row.forge,
      row.repo,
      row.number,
      row.url,
      row.status,
      row.head_branch,
      row.base_branch,
      row.created_at,
      row.updated_at,
    )
    return toIntentPr(row)
  })
}

/** Every PR one intent owns, oldest first. Empty when the store is unavailable. */
export function listIntentPrs(intentId: string): IntentPr[] {
  const d = db()
  if (!d) return []
  return d
    .all<PrRow>(`SELECT * FROM intent_prs WHERE intent_id=? ${PR_ORDER_BY}`, intentId)
    .map(toIntentPr)
}

/**
 * One intent's PRs that are still under review — the input to the status sync and
 * to the dependency back-fill probe. Read off the PR ROWS, never off the intent's
 * own status: a PR's lifecycle is its own.
 */
export function listReviewingIntentPrs(intentId: string): IntentPr[] {
  const d = db()
  if (!d) return []
  return d
    .all<PrRow>(
      `SELECT * FROM intent_prs WHERE intent_id=? AND status='reviewing' ${PR_ORDER_BY}`,
      intentId,
    )
    .map(toIntentPr)
}

/** Whether an intent owns any PR row at all (the delete guard's question). */
export function hasIntentPrs(intentId: string): boolean {
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM intent_prs WHERE intent_id=? LIMIT 1', intentId)
}

/** PRs for many intents at once, grouped by intent id — one query for a whole list. */
function listIntentPrsByIntentIds(d: Db, intentIds: string[]): Map<string, IntentPr[]> {
  const out = new Map<string, IntentPr[]>()
  for (const id of intentIds) out.set(id, [])
  if (intentIds.length === 0) return out
  const placeholders = intentIds.map(() => '?').join(',')
  const rows = d.all<PrRow>(
    `SELECT * FROM intent_prs WHERE intent_id IN (${placeholders}) ${PR_ORDER_BY}`,
    ...intentIds,
  )
  for (const r of rows) out.get(r.intent_id)?.push(toIntentPr(r))
  return out
}

/**
 * Seed the spec document: record its path and set the status to `raw`, in ONE
 * statement. Called when `write_spec` scaffolds the placeholder file — the path
 * and the "not authored yet" state are the same fact, and splitting them is
 * exactly how a seeded intent used to read as "awaiting approval" for the moment
 * in between.
 */
export function setSpecPath(id: string, specPath: string): void {
  const d = requireDb()
  d.run(
    "UPDATE intents SET spec_path=?, spec_status='raw', updated_at=? WHERE id=?",
    specPath,
    Date.now(),
    id,
  )
}

/**
 * Set the spec approval checkpoint state. `approved` and `approveUser` move
 * together: on approval pass the approving user; on un-approval
 * pass `approved=false` and `approveUser=null` to clear the recorded approver.
 *
 * `spec_status` is written in the SAME statement so the two can never disagree:
 * approving lands `approved`, un-approving lands `pending` (an un-approved
 * document has content — a human just edited it, or an approval was taken back).
 * Whether this transition is ALLOWED is decided by the caller's own guard
 * ({@link approveSpecIfPending} / {@link revokeSpecApproval}), not here.
 */
export function setSpecApproved(id: string, approved: boolean, approveUser: string | null): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET spec_approved=?, spec_approve_user=?, spec_status=?, updated_at=? WHERE id=?',
    approved ? 1 : 0,
    approveUser,
    approved ? 'approved' : 'pending',
    Date.now(),
    id,
  )
}

/**
 * Set an intent's persisted spec-mode override. `null` clears it back to
 * inheriting the workspace; `'sdd'` / `'fast'` pins it. Switching the mode never
 * changes `spec_status` on its own — flipping to `fast` does not revoke an
 * approved spec, and flipping to `sdd` does not fabricate a pending one.
 */
export function setSpecMode(id: string, mode: IntentSpecMode | null): void {
  const d = requireDb()
  d.run('UPDATE intents SET spec_mode=?, updated_at=? WHERE id=?', mode, Date.now(), id)
}

/**
 * Atomically pin a fast-mode intent back to explicit `sdd` after an
 * over-threshold settle. The WHERE guard keeps it from clobbering a concurrent
 * user action: it only applies while the persisted mode is still fast (unset =
 * fast-derived, or explicit `fast`) — an intent the user already pinned to `sdd`
 * in the meantime is left alone. Returns whether the update applied.
 */
export function switchFastIntentToSdd(intentId: string): boolean {
  const d = requireDb()
  let applied = false
  tx(d, () => {
    const row = d.get<{ spec_mode: string | null }>(
      'SELECT spec_mode FROM intents WHERE id=?',
      intentId,
    )
    if (!row || (row.spec_mode !== null && row.spec_mode !== 'fast')) return
    d.run("UPDATE intents SET spec_mode='sdd', updated_at=? WHERE id=?", Date.now(), intentId)
    applied = true
  })
  return applied
}

/**
 * Record a reverse-generated spec document at a controlled boundary: write the
 * NEW path, land the status directly on `pending` (the document carries real
 * content — the diff-driven draft — not a seed), and clear every review /
 * approval fact that belonged to the OLD document, so no stale conclusion or
 * approver survives the content swap. One statement, so a reader can never see
 * the new path next to the old approval.
 */
export function setReverseSpec(id: string, specPath: string): void {
  const d = requireDb()
  d.run(
    `UPDATE intents SET spec_path=?, spec_status='pending', spec_approved=0, spec_approve_user=NULL,
       spec_review_session_id=NULL, spec_review_verdict=NULL, spec_review_reason=NULL,
       spec_review_at=NULL, spec_review_fingerprint=NULL, spec_review_rework_rounds=0,
       spec_review_machine_blocked=0, updated_at=? WHERE id=?`,
    specPath,
    Date.now(),
    id,
  )
}

// ---- Fast-turn settlement record (baseline + idempotency) ----

/**
 * Record the git baseline a manual fast-mode work turn started from. Upserted on
 * every fresh launch AND resume, keyed by the work session id. Because resume
 * REUSES the session id, the upsert also re-opens the settleable window: the
 * conflict branch resets `settled_at` / `outcome` / `spec_path` so the same
 * session's second and later turns can each claim and settle independently. The
 * row's `settled_at` / `outcome` markers are what the settle reads to stay
 * idempotent WITHIN one turn. `baseline` is a JSON object
 * `{ [repoPath]: HEADcommit | null }` captured from the dev directory at turn
 * start.
 */
export function upsertFastTurnBaseline(input: {
  sessionId: string
  intentId: string
  workspacePath: string
  baseline: Record<string, string | null>
}): void {
  const d = requireDb()
  d.run(
    `INSERT INTO intent_fast_turns (session_id, intent_id, workspace_path, baseline, settled_at, outcome, spec_path, created_at)
     VALUES (?,?,?,?,NULL,NULL,NULL,?)
     ON CONFLICT(session_id) DO UPDATE SET
       baseline=excluded.baseline,
       intent_id=excluded.intent_id,
       workspace_path=excluded.workspace_path,
       settled_at=NULL,
       outcome=NULL,
       spec_path=NULL`,
    input.sessionId,
    input.intentId,
    resolve(input.workspacePath),
    JSON.stringify(input.baseline),
    Date.now(),
  )
}

/** Read a fast-turn record by work session id; `null` when none was recorded. */
export function getFastTurn(sessionId: string): {
  intentId: string
  workspacePath: string
  baseline: string
  settledAt: number | null
  outcome: string | null
  specPath: string | null
} | null {
  const d = requireDb()
  const row = d.get<{
    intent_id: string
    workspace_path: string
    baseline: string
    settled_at: number | null
    outcome: string | null
    spec_path: string | null
  }>('SELECT * FROM intent_fast_turns WHERE session_id=?', sessionId)
  if (!row) return null
  return {
    intentId: row.intent_id,
    workspacePath: row.workspace_path,
    baseline: row.baseline,
    settledAt: row.settled_at,
    outcome: row.outcome,
    specPath: row.spec_path,
  }
}

/**
 * Claim a fast-turn settle so a replayed `run:settled` event (or a concurrent
 * handler) can never process the same turn twice. Conditional on `settled_at IS
 * NULL`; returns `false` when the row is already claimed. Marking happens BEFORE
 * the diff / spec work, so a crash mid-settle leaves the turn claimed but
 * incomplete — the next dev turn (a fresh session) regenerates, which is the
 * self-healing path for an interrupted settlement.
 */
export function claimFastTurnSettled(sessionId: string): boolean {
  const d = requireDb()
  let claimed = false
  tx(d, () => {
    const row = d.get<{ settled_at: number | null }>(
      'SELECT settled_at FROM intent_fast_turns WHERE session_id=?',
      sessionId,
    )
    if (!row || row.settled_at !== null) return
    d.run('UPDATE intent_fast_turns SET settled_at=? WHERE session_id=?', Date.now(), sessionId)
    claimed = true
  })
  return claimed
}

/** Record the outcome of a claimed fast-turn settle. */
export function completeFastTurnSettle(
  sessionId: string,
  outcome: 'no_change' | 'small' | 'over' | 'failed',
  specPath?: string | null,
): void {
  const d = requireDb()
  d.run(
    'UPDATE intent_fast_turns SET outcome=?, spec_path=COALESCE(?, spec_path) WHERE session_id=?',
    outcome,
    specPath ?? null,
    sessionId,
  )
}

/** Drop a fast-turn record (intent deletion cleanup). */
export function deleteFastTurnsForIntent(intentId: string): void {
  const d = requireDb()
  d.run('DELETE FROM intent_fast_turns WHERE intent_id=?', intentId)
}

/**
 * What a spec-content write at a controlled boundary did to the intent's status.
 * - `promoted`  — `raw` → `pending`: the document carries real content now.
 * - `reopened`  — `approved` → `pending`: an approved document was rewritten, so
 *   the approval it rested on no longer applies.
 * - `unchanged` — already `pending` (or no such intent): nothing to move.
 */
export type SpecAuthoredOutcome = 'promoted' | 'reopened' | 'unchanged'

/**
 * Record that the spec document's CONTENT actually changed at a controlled write
 * boundary (the authoring run's settle check, which compares the fingerprint it
 * captured before the run against the one on disk after it).
 *
 * This is the ONLY automatic way out of `raw`, and it is content-driven rather
 * than event-driven: launching, resuming or failing a spec run moves nothing by
 * itself. Status, compatibility fields and `updated_at` move in one transaction,
 * so a reader can never observe `pending` next to a stale approver.
 *
 * A status that is already `pending` stays put — content that later resembles the
 * seed again does NOT demote it back to `raw`.
 */
export function markSpecAuthored(id: string): SpecAuthoredOutcome {
  const d = requireDb()
  let outcome: SpecAuthoredOutcome = 'unchanged'
  tx(d, () => {
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', id)
    if (!row) return
    const status = narrowSpecStatus(row.spec_status)
    if (status === 'pending') return
    if (status === 'raw') {
      d.run(
        "UPDATE intents SET spec_status='pending', spec_approved=0, spec_approve_user=NULL, updated_at=? WHERE id=?",
        Date.now(),
        id,
      )
      outcome = 'promoted'
      return
    }
    // `approved`: the reviewed-and-approved document has been rewritten. The
    // approval is withdrawn with it — the conclusion it rested on is bound to the
    // old fingerprint anyway, so leaving the flag set would admit development
    // against content nobody approved.
    d.run(
      "UPDATE intents SET spec_status='pending', spec_approved=0, spec_approve_user=NULL, updated_at=? WHERE id=?",
      Date.now(),
      id,
    )
    outcome = 'reopened'
  })
  return outcome
}

/**
 * Approve a spec on behalf of a HUMAN, under a transactional status guard.
 * Returns `false` — writing nothing — unless the spec is `pending`: a `raw` spec
 * is still being authored (its file may be nothing but the server's seed), and an
 * already-`approved` one has nothing to approve. The UI never offers either, so
 * this is the defensive server-side half of the same rule.
 */
export function approveSpecIfPending(id: string, approver: string): boolean {
  const d = requireDb()
  let applied = false
  tx(d, () => {
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', id)
    if (!row || narrowSpecStatus(row.spec_status) !== 'pending') return
    d.run(
      "UPDATE intents SET spec_status='approved', spec_approved=1, spec_approve_user=?, updated_at=? WHERE id=?",
      approver,
      Date.now(),
      id,
    )
    applied = true
  })
  return applied
}

/**
 * Outcome of a `spec_review` conclusion submission.
 * - `applied`   — a NEW conclusion landed (and, for `changes_requested`, the
 *   rework counter advanced by exactly one).
 * - `duplicate` — the identical conclusion for the identical spec fingerprint is
 *   already recorded. A no-op: no second count, no second event, no re-approval.
 * - `stale`     — the fingerprint does not match the spec's live content, so the
 *   reviewer judged something that no longer exists. Rejected, never a pass.
 * - `unknown`   — no such intent.
 */
export type SpecReviewSubmitOutcome = 'applied' | 'duplicate' | 'stale' | 'unknown'

/**
 * Record a review conclusion against the spec fingerprint it was produced for.
 *
 * The whole check-and-write runs in ONE transaction so a repeated tick, a retried
 * event and a duplicate tool call can never double-count a rework round or land
 * two conclusions. `liveFingerprint` is the spec file's fingerprint as the caller
 * just read it: a submission whose `fingerprint` disagrees is `stale` and is
 * dropped rather than interpreted (an out-of-date judgement is not a pass).
 *
 * A newly applied conclusion also clears the machine-approval suppression flag —
 * a human veto binds to the conclusion it was aimed at, not to the intent forever.
 */
export function recordSpecReview(input: {
  intentId: string
  sessionId: string | null
  verdict: SpecReviewVerdict
  reason: string
  /** The fingerprint the reviewer judged. */
  fingerprint: string
  /** The spec's fingerprint right now, as read by the caller. */
  liveFingerprint: string
  now?: number
}): SpecReviewSubmitOutcome {
  const d = requireDb()
  const now = input.now ?? Date.now()
  let outcome: SpecReviewSubmitOutcome = 'unknown'
  tx(d, () => {
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', input.intentId)
    if (!row) {
      outcome = 'unknown'
      return
    }
    if (input.fingerprint !== input.liveFingerprint) {
      outcome = 'stale'
      return
    }
    if (
      row.spec_review_fingerprint === input.fingerprint &&
      narrowSpecReviewVerdict(row.spec_review_verdict) === input.verdict
    ) {
      outcome = 'duplicate'
      return
    }
    const rounds =
      input.verdict === 'changes_requested'
        ? (row.spec_review_rework_rounds ?? 0) + 1
        : (row.spec_review_rework_rounds ?? 0)
    d.run(
      `UPDATE intents SET spec_review_session_id=?, spec_review_verdict=?, spec_review_reason=?,
         spec_review_at=?, spec_review_fingerprint=?, spec_review_rework_rounds=?,
         spec_review_machine_blocked=0, updated_at=? WHERE id=?`,
      input.sessionId,
      input.verdict,
      input.reason,
      now,
      input.fingerprint,
      rounds,
      now,
      input.intentId,
    )
    outcome = 'applied'
  })
  return outcome
}

/**
 * Approve a spec on behalf of the MACHINE, under a transactional condition check.
 *
 * Returns `true` only when every fact still held at write time: not already
 * approved, a `pass` conclusion, that conclusion bound to `fingerprint`, the spec
 * file's LIVE content still fingerprinting to that same value, and no human veto
 * standing against it. A spec edited or an approval revoked between the kernel's
 * decision and this write fails the check and approves nothing — the next
 * reconcile re-derives from the fresh facts.
 *
 * The live content is re-read HERE, inside the transaction, through
 * `readLiveFingerprint` — the store owns no filesystem knowledge, and the kernel's
 * snapshot fingerprint is by then arbitrarily old. Checking only the stored
 * conclusion against the snapshot would compare two values that were both captured
 * BEFORE the edit, so they would still agree and an unreviewed document would be
 * approved. The reader is handed the spec path off the row read in this same
 * transaction, so it can never follow a path the ledger has since moved.
 * An unreadable spec (`null`) fails closed: unreadable is not unchanged.
 */
export function machineApproveSpec(
  intentId: string,
  fingerprint: string,
  approver: string,
  readLiveFingerprint: (specPath: string) => string | null,
): boolean {
  const d = requireDb()
  let applied = false
  tx(d, () => {
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', intentId)
    if (!row) return
    // Only a `pending` spec may be approved. `raw` is still being authored and
    // `approved` is already there — both fail the guard rather than being nudged
    // through it by the compatibility boolean.
    if (narrowSpecStatus(row.spec_status) !== 'pending') return
    if (row.spec_path === null) return
    if (narrowSpecReviewVerdict(row.spec_review_verdict) !== 'pass') return
    if (row.spec_review_fingerprint !== fingerprint) return
    if (row.spec_review_machine_blocked === 1) return
    if (readLiveFingerprint(row.spec_path) !== fingerprint) return
    d.run(
      "UPDATE intents SET spec_status='approved', spec_approved=1, spec_approve_user=?, updated_at=? WHERE id=?",
      approver,
      Date.now(),
      intentId,
    )
    applied = true
  })
  return applied
}

/**
 * Revoke an approval (human or machine) and veto the conclusion it rested on, so
 * the next tick cannot machine-approve the same conclusion straight back. The
 * spec returns to `pending` — the document still holds the content that was
 * approved, it simply is not approved any more. Returns `false` when the intent
 * was not approved — nothing to revoke, nothing written.
 */
export function revokeSpecApproval(intentId: string): boolean {
  const d = requireDb()
  let revoked = false
  tx(d, () => {
    const row = d.get<Row>('SELECT * FROM intents WHERE id=?', intentId)
    if (!row || narrowSpecStatus(row.spec_status) !== 'approved') return
    d.run(
      `UPDATE intents SET spec_status='pending', spec_approved=0, spec_approve_user=NULL,
         spec_review_machine_blocked=1, updated_at=? WHERE id=?`,
      Date.now(),
      intentId,
    )
    revoked = true
  })
  return revoked
}

/**
 * Lift the machine-approval veto. Called on an explicit HUMAN approval: once a
 * person has approved this spec, the earlier veto has been answered and must not
 * keep suppressing a later machine approval of a freshly reviewed spec.
 */
export function clearSpecReviewMachineBlock(intentId: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET spec_review_machine_blocked=0, updated_at=? WHERE id=?',
    Date.now(),
    intentId,
  )
}

/**
 * Set the spec-REVIEW session id (c3SessionId) for an intent. `null` clears it
 * (the spec-phase occupancy release path).
 */
export function setSpecReviewSessionId(id: string, sessionId: string | null): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET spec_review_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/**
 * Set the spec-authoring session id (c3SessionId) for an intent. `null` clears
 * it (the spec-phase occupancy release path).
 */
export function setSpecSessionId(id: string, sessionId: string | null): void {
  const d = requireDb()
  d.run('UPDATE intents SET spec_session_id=?, updated_at=? WHERE id=?', sessionId, Date.now(), id)
}

/** Set the refine / communication session id (c3SessionId) for an intent. */
export function setIntentSessionId(id: string, sessionId: string | null): void {
  const d = requireDb()
  d.run(
    'UPDATE intents SET intent_session_id=?, updated_at=? WHERE id=?',
    sessionId,
    Date.now(),
    id,
  )
}

/** Patch editable fields; `dependsOn`, when present, replaces the dependency set. */
export function updateIntent(
  id: string,
  patch: Partial<Pick<Intent, 'title' | 'content' | 'priority' | 'status' | 'dependsOn'>> & {
    /** Dep types keyed by depended-on intent id. Only meaningful together with `dependsOn`; absent entries default to `'blocks'`. */
    depTypes?: Record<string, DepType>
  },
): void {
  const d = requireDb()
  tx(d, () => {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.title !== undefined) {
      sets.push('title=?')
      params.push(patch.title)
    }
    if (patch.content !== undefined) {
      sets.push('content=?')
      params.push(patch.content)
    }
    if (patch.priority !== undefined) {
      sets.push('priority=?')
      params.push(patch.priority)
    }
    if (patch.status !== undefined) {
      sets.push('status=?')
      params.push(patch.status)
      // Keep completed_at in sync with status, same rule as updateStatus.
      sets.push('completed_at=?')
      params.push(patch.status === 'done' ? Date.now() : null)
    }
    if (sets.length > 0) {
      sets.push('updated_at=?')
      params.push(Date.now())
      params.push(id)
      d.run(`UPDATE intents SET ${sets.join(', ')} WHERE id=?`, ...params)
    }
    if (patch.dependsOn !== undefined) {
      d.run('DELETE FROM intent_deps WHERE intent_id=?', id)
      const now = Date.now()
      const types = patch.depTypes ?? {}
      for (const dep of patch.dependsOn) {
        const depType = types[dep] ?? 'blocks'
        d.run(
          'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
          id,
          dep,
          depType,
          now,
        )
      }
    }
  })
}

// ---- Intent dependency management ----

/** Return all dependencies for an intent, with type metadata. */
export function listDependencies(intentId: string): DependencyInfo[] {
  const d = db()
  if (!d) return []
  return d
    .all<{
      depends_on_id: string
      dep_type: string
      created_at: number
    }>(
      'SELECT depends_on_id, dep_type, created_at FROM intent_deps WHERE intent_id=? ORDER BY created_at ASC',
      intentId,
    )
    .map((r) => ({
      dependsOnId: r.depends_on_id,
      depType: r.dep_type as DepType,
      createdAt: r.created_at,
    }))
}

/** Insert a single dependency edge. dep_type defaults to 'blocks'. */
export function insertDependency(
  intentId: string,
  dependsOnId: string,
  depType: DepType = 'blocks',
): void {
  const d = requireDb()
  d.run(
    'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
    intentId,
    dependsOnId,
    depType,
    Date.now(),
  )
}

/**
 * Replace all dependencies for an intent with dep_type per edge.
 * Previous edges are deleted first. Each edge specifies its dep_type,
 * so callers can mix blocks / informs / soft_after in one call.
 */
export function updateIntentDeps(
  intentId: string,
  deps: { dependsOnId: string; depType: DepType }[],
): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM intent_deps WHERE intent_id=?', intentId)
    const now = Date.now()
    for (const dep of deps) {
      d.run(
        'INSERT OR IGNORE INTO intent_deps (intent_id, depends_on_id, dep_type, created_at) VALUES (?,?,?,?)',
        intentId,
        dep.dependsOnId,
        dep.depType,
        now,
      )
    }
  })
}

// ---- Communication session mapping / hidden set ----
// `intent_chats` doubles as the per-project "current comm session" map and
// the hidden-session set (every row is hidden from the normal session list).

/** The current comm session id for a project, or null. */
export function getChatSession(workspacePath: string): string | null {
  const d = db()
  if (!d) return null
  const row = d.get<{ session_id: string }>(
    'SELECT session_id FROM intent_chats WHERE workspace_path=? AND is_current=1',
    resolve(workspacePath),
  )
  return row?.session_id ?? null
}

/** Make `sessionId` the project's current comm session (clearing any prior one). */
export function setChatSession(workspacePath: string, sessionId: string, title?: string): void {
  const d = requireDb()
  const proj = resolve(workspacePath)
  const now = Date.now()
  tx(d, () => {
    d.run('UPDATE intent_chats SET is_current=0 WHERE workspace_path=? AND is_current=1', proj)
    if (title !== undefined) {
      d.run(
        `INSERT INTO intent_chats (session_id, workspace_path, is_current, updated_at, title)
         VALUES (?,?,1,?,?)
         ON CONFLICT(session_id) DO UPDATE SET is_current=1, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at`,
        sessionId,
        proj,
        now,
        title,
      )
    } else {
      d.run(
        `INSERT INTO intent_chats (session_id, workspace_path, is_current, updated_at)
         VALUES (?,?,1,?)
         ON CONFLICT(session_id) DO UPDATE SET is_current=1, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at`,
        sessionId,
        proj,
        now,
      )
    }
  })
}

/** Re-key a comm session row when a pending session binds to its real SDK id. */
export function rebindChatSession(pendingId: string, realId: string): void {
  const d = requireDb()
  tx(d, () => {
    // If realId somehow already exists, drop it so the pending row can take it.
    d.run('DELETE FROM intent_chats WHERE session_id=?', realId)
    d.run('UPDATE intent_chats SET session_id=? WHERE session_id=?', realId, pendingId)
  })
}

/** Whether a session id belongs to the comm-session hidden set. */
export function isHiddenSession(sessionId: string): boolean {
  if (!isDbAvailable()) return false
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM intent_chats WHERE session_id=?', sessionId)
}

/** All comm session ids for a project (the hidden set), for list filtering. */
export function listHiddenSessions(workspacePath: string): string[] {
  if (!isDbAvailable()) return []
  const d = db()
  if (!d) return []
  return d
    .all<{
      session_id: string
    }>('SELECT session_id FROM intent_chats WHERE workspace_path=?', resolve(workspacePath))
    .map((r) => r.session_id)
}

/** All spec authoring + review session ids for a project, for list filtering.
 * Neither is a user work session, so neither may appear in the work-session list. */
export function listSpecSessionIds(workspacePath: string): string[] {
  if (!isDbAvailable()) return []
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  const authored = d
    .all<{
      spec_session_id: string
    }>(
      'SELECT spec_session_id FROM intents WHERE workspace_path=? AND spec_session_id IS NOT NULL',
      proj,
    )
    .map((r) => r.spec_session_id)
  const reviewed = d
    .all<{
      spec_review_session_id: string
    }>(
      'SELECT spec_review_session_id FROM intents WHERE workspace_path=? AND spec_review_session_id IS NOT NULL',
      proj,
    )
    .map((r) => r.spec_review_session_id)
  return [...authored, ...reviewed]
}

// ---- Communication session CRUD (session-collection upgrade) ----
// `intent_chats` now holds multiple rows per project (not just one current).
// `title` is nullable — null means render "New Intent" or a first-prompt/time
// derivation on the client. `is_current` is the "default-open" pointer.

/** All comm sessions for a project, newest-first. */
export function listChatSessions(workspacePath: string): IntentSessionInfo[] {
  const d = db()
  if (!d) return []
  const proj = resolve(workspacePath)
  return d
    .all<{
      session_id: string
      title: string | null
      updated_at: number
    }>(
      'SELECT session_id, title, updated_at FROM intent_chats WHERE workspace_path=? ORDER BY updated_at DESC',
      proj,
    )
    .map((r) => ({
      sessionId: r.session_id,
      title: r.title ?? null,
      updatedAt: r.updated_at,
    }))
}

/** Rename a comm session (also bumps updatedAt). */
export function renameChatSession(sessionId: string, title: string): void {
  const d = requireDb()
  d.run(
    'UPDATE intent_chats SET title=?, updated_at=? WHERE session_id=?',
    title,
    Date.now(),
    sessionId,
  )
}

/**
 * Physically delete a comm session row. If the deleted row was `is_current`,
 * the most recent remaining row (by updatedAt) for the same project becomes
 * the new is_current (is_current=1). Otherwise no fallback — callers surface
 * "no sessions" to the user. Also removes runtime (abort + drop) — callers
 * must call `removeRuntime` before this to avoid a stale runtime outlasting
 * the db row.
 *
 * @returns The project path of the deleted session (for callers to broadcast).
 */
export function deleteChatSession(workspacePath: string, sessionId: string): void {
  const d = requireDb()
  const proj = resolve(workspacePath)
  tx(d, () => {
    const row = d.get<{ is_current: number }>(
      'SELECT is_current FROM intent_chats WHERE session_id=?',
      sessionId,
    )
    if (!row) return
    d.run('DELETE FROM intent_chats WHERE session_id=?', sessionId)
    // If the deleted row was is_current, promote the latest remaining.
    if (row.is_current) {
      const next = d.get<{ session_id: string }>(
        'SELECT session_id FROM intent_chats WHERE workspace_path=? ORDER BY updated_at DESC LIMIT 1',
        proj,
      )
      if (next) {
        d.run(
          'UPDATE intent_chats SET is_current=1, updated_at=? WHERE session_id=?',
          Date.now(),
          next.session_id,
        )
      }
    }
  })
}

// ---- Tool-created session set ----
// Sessions spawned by tools (completion judge, consensus advisor). Persisted so
// the "show tool sessions" filter survives restarts — an in-memory-only set
// would be empty after a restart, leaving historic tool sessions unrecognised
// and thus visible even when the setting is off.

/** Record a session id as tool-created (idempotent). */
export function recordToolSession(sessionId: string): void {
  const d = db()
  if (!d) return
  d.run(
    'INSERT OR IGNORE INTO tool_sessions (session_id, created_at) VALUES (?,?)',
    sessionId,
    Date.now(),
  )
}

/** Tool-session marker ids, used only to rebuild ownerless tool projections. */
export function listToolSessionIds(): string[] {
  const d = db()
  if (!d) return []
  return d
    .all<{ session_id: string }>('SELECT session_id FROM tool_sessions')
    .map((r) => r.session_id)
}

/** Whether a session id was recorded as tool-created. */
export function isToolSessionRecorded(sessionId: string): boolean {
  if (!isDbAvailable()) return false
  const d = db()
  if (!d) return false
  return !!d.get('SELECT 1 FROM tool_sessions WHERE session_id=?', sessionId)
}

/** Forget a tool-session record (called when its session is deleted). */
export function deleteToolSessionRecord(sessionId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM tool_sessions WHERE session_id=?', sessionId)
}

// ---- Intent work session execution records (审计追踪) ----

interface IntentSessionRow {
  id: number
  intent_id: string
  session_id: string
  vendor: string
  summary: string | null
  start_at: number | null
  end_at: number | null
  exit_code: string | null
  agent_id: string | null
  created_at: number
}

function toIntentDevSession(r: IntentSessionRow): IntentDevSession {
  return {
    id: r.id,
    intentId: r.intent_id,
    sessionId: r.session_id,
    vendor: r.vendor as IntentDevSession['vendor'],
    summary: r.summary,
    startAt: r.start_at,
    endAt: r.end_at,
    exitCode: r.exit_code as IntentDevSessionExitCode | null,
    agentId: r.agent_id,
    createdAt: r.created_at,
  }
}

/**
 * Insert a new intent work session record.
 * Returns the auto-generated id.
 */
export function insertIntentSession(
  intentId: string,
  sessionId: string,
  vendor: string,
  agentId?: string,
): number {
  const d = requireDb()
  const now = Date.now()
  d.run(
    `INSERT INTO intent_sessions (intent_id, session_id, vendor, agent_id, created_at)
     VALUES (?,?,?,?,?)`,
    intentId,
    sessionId,
    vendor,
    agentId ?? null,
    now,
  )
  const row = d.get<{ id: number }>('SELECT last_insert_rowid() AS id')
  return Number(row!.id)
}

/**
 * Update an intent work session record post-hoc (end timestamp, exit code, summary).
 * Only updates non-`undefined` fields; no-op when no fields are supplied.
 * Skips when the db is unavailable (degradation — caller may log but must not throw).
 */
export function updateIntentSession(
  id: number,
  patch: {
    exitCode?: IntentDevSessionExitCode
    summary?: string
    startAt?: number
    endAt?: number
  },
): void {
  const d = db()
  if (!d) return
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.exitCode !== undefined) {
    sets.push('exit_code=?')
    params.push(patch.exitCode)
  }
  if (patch.summary !== undefined) {
    sets.push('summary=?')
    params.push(patch.summary)
  }
  if (patch.startAt !== undefined) {
    sets.push('start_at=?')
    params.push(patch.startAt)
  }
  if (patch.endAt !== undefined) {
    sets.push('end_at=?')
    params.push(patch.endAt)
  }
  if (sets.length > 0) {
    params.push(id)
    d.run(`UPDATE intent_sessions SET ${sets.join(', ')} WHERE id=?`, ...params)
  }
}

/**
 * Find the most recent intent session record for a given (sessionId, intentId)
 * pair. Returns `null` when the db is unavailable or no match is found.
 * Useful for `run:settled` handlers that need to update a record inserted at
 * `run:bound` time but whose auto-increment id was not captured.
 */
export function getIntentSessionBySessionId(
  sessionId: string,
  intentId: string,
): IntentDevSession | null {
  const d = db()
  if (!d) return null
  const row = d.get<IntentSessionRow>(
    'SELECT * FROM intent_sessions WHERE session_id=? AND intent_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
    sessionId,
    intentId,
  )
  return row ? toIntentDevSession(row) : null
}

/**
 * Reverse-lookup the intent a (dev) session belongs to, via `intent_sessions`.
 * Only `start_development`-bound sessions have a row, so a plain work / comm
 * session returns `null` (no button). When a session was bound more than once,
 * the most recent binding wins. Returns `null` when the db is unavailable.
 */
export function findIntentIdBySessionId(sessionId: string): string | null {
  const d = db()
  if (!d) return null
  const row = d.get<{ intent_id: string }>(
    'SELECT intent_id FROM intent_sessions WHERE session_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
    sessionId,
  )
  return row?.intent_id ?? null
}

/**
 * Broad reverse-lookup of the intent that owns ANY kind of session id — wider than
 * {@link findIntentIdBySessionId} (which only matches Start-work work sessions, on
 * purpose, for the title-bar jump button). Probes three bindings, most-specific first:
 *  1. `intent_sessions.session_id` — an intent work-session record (Start-work runs).
 *  2. `intents.intent_session_id`  — the comm session the comm save links back (codex
 *     `save_intents`).
 *  3. `intents.last_work_session_id` — the latest work session bound to the intent.
 *  4. `intents.id` — the intent's own id, for events written by `pushFailureEvent`
 *     where no real session exists and `session_id` is the intent object id itself.
 *
 * Used by the wait-user-involve store's `toEvent` to derive `intentId`/`intentTitle`
 * from an event's `session_id`, so both a comm-session gate and a work-session prompt
 * resolve to their intent. Returns null when nothing matches or the db is unavailable.
 */
export function findIntentIdByAnySessionId(sessionId: string): string | null {
  const d = db()
  if (!d || !sessionId) return null
  const fromDevSession = d.get<{ intent_id: string }>(
    'SELECT intent_id FROM intent_sessions WHERE session_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
    sessionId,
  )
  if (fromDevSession) return fromDevSession.intent_id
  const fromComm = d.get<{ id: string }>(
    'SELECT id FROM intents WHERE intent_session_id=? LIMIT 1',
    sessionId,
  )
  if (fromComm) return fromComm.id
  const fromLastDev = d.get<{ id: string }>(
    'SELECT id FROM intents WHERE last_work_session_id=? LIMIT 1',
    sessionId,
  )
  if (fromLastDev) return fromLastDev.id
  const fromOwnId = d.get<{ id: string }>('SELECT id FROM intents WHERE id=? LIMIT 1', sessionId)
  return fromOwnId ? fromOwnId.id : null
}

/**
 * List work session records for an intent, newest first.
 * Returns `[]` when the db is unavailable.
 */
export function listIntentSessions(intentId: string): IntentDevSession[] {
  const d = db()
  if (!d) return []
  return d
    .all<IntentSessionRow>(
      'SELECT * FROM intent_sessions WHERE intent_id=? ORDER BY created_at DESC, id DESC',
      intentId,
    )
    .map(toIntentDevSession)
}

/**
 * Get a single intent work session record by its primary key.
 * Returns `null` when the db is unavailable or the record is not found.
 */
export function getIntentSession(id: number): IntentDevSession | null {
  const d = db()
  if (!d) return null
  const row = d.get<IntentSessionRow>('SELECT * FROM intent_sessions WHERE id=?', id)
  return row ? toIntentDevSession(row) : null
}

// ---- Intent lifecycle logs (变更日志) ----
// Append-only "who did what, when" trail across an intent's lifecycle. Work
// session start/stop is NOT recorded here (intent_sessions owns that audit).

interface IntentLogRow {
  id: string
  intent_id: string
  operation_type: string
  summary: string
  actor: string
  created_at: number
}

function toIntentLog(r: IntentLogRow): IntentLog {
  return {
    id: r.id,
    intentId: r.intent_id,
    operationType: r.operation_type as IntentLogOperation,
    summary: r.summary,
    actor: r.actor,
    createdAt: r.created_at,
  }
}

/**
 * Append one lifecycle-log entry. `actor` missing or null lands as `'system'`
 * (the same "system behaviour" convention the rest of the intent domain uses).
 * Throws when the db is unavailable (same `requireDb` contract as other writes);
 * lifecycle instrumentation goes through {@link safeInsertIntentLog} so a log
 * failure never breaks the business path.
 */
export function insertIntentLog(
  intentId: string,
  operationType: IntentLogOperation,
  summary: string,
  actor?: string | null,
): void {
  const d = requireDb()
  d.run(
    'INSERT INTO intent_logs (id, intent_id, operation_type, summary, actor, created_at) VALUES (?,?,?,?,?,?)',
    randomUUID(),
    intentId,
    operationType,
    summary,
    actor ?? 'system',
    Date.now(),
  )
}

/**
 * Best-effort {@link insertIntentLog}: the shared wrapper for every lifecycle
 * instrumentation point. A failed log write (db unavailable, table damaged)
 * only warns — the business operation it decorates must still succeed.
 */
export function safeInsertIntentLog(
  intentId: string,
  operationType: IntentLogOperation,
  summary: string,
  actor?: string | null,
): void {
  try {
    insertIntentLog(intentId, operationType, summary, actor)
  } catch (err) {
    console.warn(
      `[c3:intents] lifecycle log write failed (${operationType}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * One intent's lifecycle-log entries, newest first (created_at DESC, rowid DESC
 * — the random-UUID `id` is no tiebreaker, so same-millisecond rows fall back to
 * insertion order via rowid). Full set, no pagination
 * (single-intent volumes stay small). Returns `[]` when the db is unavailable.
 */
export function listIntentLogs(intentId: string): IntentLog[] {
  const d = db()
  if (!d) return []
  return d
    .all<IntentLogRow>(
      'SELECT * FROM intent_logs WHERE intent_id=? ORDER BY created_at DESC, rowid DESC',
      intentId,
    )
    .map(toIntentLog)
}
