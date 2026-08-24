/**
 * IM robot schema: the four table DDLs, the whole-table rebuild migrations (all
 * routed through `table-rebuild.ts`), the ADD COLUMN migrations, and the
 * idempotent `ensureSchema` pass run lazily on the first DB access.
 *
 * Properties the schema keeps true:
 *
 *  - **Rebuilds converge.** The RENAME → create → copy → index sequence is the
 *    helper's single responsibility; `CREATE INDEX IF NOT EXISTS` never silently
 *    skips because the old index name rode the RENAME onto an archive.
 *  - **Idempotent.** Re-ensuring a converged database is a no-op; a DB that
 *    predates these tables converges in place without touching other tables.
 *  - **`im_robots` mostly evolves via ADD COLUMN**, not rebuilds — except the
 *    one-time platform CHECK removal below, which SQLite cannot express as an
 *    ALTER.
 *
 * The schema lifecycle is registered into `robot-db.ts` at module load so the
 * shared `db()` entrypoint runs it once per fresh connection.
 */
import { hasMigration, markMigration, type Db } from '../../kernel/infra/db.js'
import { computeOutboundConfigHash } from './outbound-config-hash.js'
import { execIdentitySchema } from './identity-schema.js'
import { validateRobotMessageRegistry } from './robot-message-registry.js'
import { toRobot, type RobotRow } from './robot-config-store.js'
import { failStalePendingContextTurns } from './robot-context-store.js'
import { db, registerSchemaSetup, tableColumns, tx } from './robot-db.js'
import { rebuildTable } from './table-rebuild.js'

// ---- Migration markers ----

const SENDER_ISOLATION_MIGRATION = 'robots.sender_isolation.v1'
const IDENTITY_SCOPE_MIGRATION = 'robots.identity_scope.v1'
const BROADCAST_CONFIG_MIGRATION = 'robots.broadcast_config.v1'
const LOCALE_MIGRATION = 'robots.locale.v1'
const CONFIG_REVISION_MIGRATION = 'robots.config_revision.v1'

// ---- DDL (table bodies + IF NOT EXISTS + fresh CREATE for rebuilds) ----

/**
 * The FULL im_robots column set, platform CHECK-free. The base create and the
 * platform-check rebuild both shape the table from this body, so a rebuilt
 * table is never left missing a column that a marker-gated ALTER migration
 * would have added only once (those markers stay set across a rebuild).
 */
const IM_ROBOTS_TABLE_BODY = `
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  platform         TEXT NOT NULL,
  app_id           TEXT NOT NULL,
  app_secret       TEXT NOT NULL DEFAULT '',
  vendor           TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT '',
  tool_allowlist   TEXT NOT NULL DEFAULT '[]',
  require_mention  INTEGER NOT NULL DEFAULT 1,
  chat_allowlist   TEXT NOT NULL DEFAULT '[]',
  dm_mode          TEXT NOT NULL DEFAULT 'disabled'
                   CHECK(dm_mode IN ('disabled','allowlist','open')),
  dm_allowlist     TEXT NOT NULL DEFAULT '[]',
  max_turn_ms      INTEGER,
  enabled          INTEGER NOT NULL DEFAULT 0,
  outbound_ack_at  INTEGER,
  locale           TEXT CHECK(locale IS NULL OR locale IN ('en','zh','ja','ko','ru')),
  outbound_ack_hash TEXT,
  broadcast_event_types TEXT NOT NULL DEFAULT '[]',
  broadcast_to_bound_users INTEGER NOT NULL DEFAULT 0,
  broadcast_group_chat_ids TEXT NOT NULL DEFAULT '[]',
  config_revision  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
`

const ROBOTS_TABLE = `CREATE TABLE IF NOT EXISTS im_robots (${IM_ROBOTS_TABLE_BODY});`
const ROBOTS_TABLE_FRESH = `CREATE TABLE im_robots (${IM_ROBOTS_TABLE_BODY});`

/** All `im_robots` columns, in DDL order — the platform-check rebuild copy projection. */
const ALL_ROBOT_COLS = [
  'id',
  'name',
  'platform',
  'app_id',
  'app_secret',
  'vendor',
  'agent_id',
  'mode',
  'tool_allowlist',
  'require_mention',
  'chat_allowlist',
  'dm_mode',
  'dm_allowlist',
  'max_turn_ms',
  'enabled',
  'outbound_ack_at',
  'locale',
  'outbound_ack_hash',
  'broadcast_event_types',
  'broadcast_to_bound_users',
  'broadcast_group_chat_ids',
  'config_revision',
  'created_at',
  'updated_at',
]

const THREADS_TABLE_BODY = `
  platform         TEXT NOT NULL,
  robot_id         TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  binding_id       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  scope_hash       TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  session_id       TEXT,
  vendor           TEXT NOT NULL,
  context_revision INTEGER NOT NULL DEFAULT 0,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER NOT NULL,
  PRIMARY KEY (platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash)`

const THREADS_TABLE = `CREATE TABLE IF NOT EXISTS im_robot_threads (${THREADS_TABLE_BODY});`
const THREADS_TABLE_FRESH = `CREATE TABLE im_robot_threads (${THREADS_TABLE_BODY});`

const CONTEXT_TURNS_TABLE_BODY = `
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  binding_id      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  scope_hash      TEXT NOT NULL,
  in_message_id   TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK(status IN ('pending','committed','failed')),
  user_text       TEXT NOT NULL DEFAULT '',
  assistant_text  TEXT NOT NULL DEFAULT '',
  seq             INTEGER,
  committed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (platform, robot_id, in_message_id)`

const CONTEXT_TURNS_TABLE = `CREATE TABLE IF NOT EXISTS im_robot_context_turns (${CONTEXT_TURNS_TABLE_BODY});`
const CONTEXT_TURNS_TABLE_FRESH = `CREATE TABLE im_robot_context_turns (${CONTEXT_TURNS_TABLE_BODY});`

const TURNS_OUTCOME_CHECK =
  "('complete','error','blocked','timeout','guard_refused','input_rejected','busy','identity_required','scope_changed')"

const TURNS_TABLE_BODY = `
  id             TEXT PRIMARY KEY,
  robot_id       TEXT NOT NULL,
  thread_key     TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  in_message_id  TEXT NOT NULL,
  session_id     TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  outcome        TEXT
                 CHECK(outcome IS NULL OR outcome IN ${TURNS_OUTCOME_CHECK}),
  reject_reason  TEXT
                 CHECK(reject_reason IS NULL OR reject_reason IN ('credential','too_long')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT`

const TURNS_TABLE = `CREATE TABLE IF NOT EXISTS im_robot_turns (${TURNS_TABLE_BODY});`
const TURNS_TABLE_FRESH = `CREATE TABLE im_robot_turns (${TURNS_TABLE_BODY});`

/** All `im_robot_turns` columns, in DDL order — the rebuild copy projections. */
const ALL_TURN_COLS = [
  'id',
  'robot_id',
  'thread_key',
  'chat_id',
  'sender_id',
  'in_message_id',
  'session_id',
  'started_at',
  'finished_at',
  'outcome',
  'reject_reason',
  'outbound_chars',
  'out_message_id',
  'error',
]

// ---- Indexes, grouped by table (single source for rebuilds + the tail pass) ----

const ROBOTS_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_robot_name ON im_robots(name);
CREATE INDEX IF NOT EXISTS idx_im_robot_enabled ON im_robots(enabled);`

const THREADS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);`

const CONTEXT_TURNS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_im_ctx_conversation
  ON im_robot_context_turns(platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash, status, seq);
CREATE INDEX IF NOT EXISTS idx_im_ctx_committed_at ON im_robot_context_turns(committed_at);`

const TURNS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);`

const ALL_INDEXES = `${ROBOTS_INDEXES}${THREADS_INDEXES}${CONTEXT_TURNS_INDEXES}${TURNS_INDEXES}`

// ---- Rebuild migrations (the helper owns the RENAME → copy → index order) ----

/**
 * Converge threads + turns to the sender-isolated schema. Safe-cut: old shared
 * session rows are renamed aside and never copied. Failure throws — caller must
 * not start the supervisor.
 */
function migrateSenderIsolation(d: Db): void {
  if (hasMigration(d, SENDER_ISOLATION_MIGRATION)) {
    // Marker set, but tables must still exist (idempotent CREATE below).
    return
  }

  tx(d, () => {
    // ---- Threads: old shared → rename aside; new empty Conversation table ----
    rebuildTable(d, {
      table: 'im_robot_threads',
      archive: 'im_robot_threads_pre_sender',
      newDdl: THREADS_TABLE_FRESH,
      copy: null, // safe-cut: old shared rows are not copied
      indexDdl: THREADS_INDEXES,
      keepArchive: true, // archive retained (safe-cut); only the name collision goes
      needs: (dd) => !tableColumns(dd, 'im_robot_threads').has('sender_id'),
    })

    // ---- Audit turns: extend outcome CHECK + reject_reason ----
    rebuildTable(d, {
      table: 'im_robot_turns',
      archive: 'im_robot_turns_pre_input_rejected',
      newDdl: TURNS_TABLE_FRESH,
      copy: {
        columns: ALL_TURN_COLS,
        select: ALL_TURN_COLS.map((c) => (c === 'reject_reason' ? 'NULL' : c)),
      },
      indexDdl: TURNS_INDEXES,
      keepArchive: false,
      needs: (dd) => !tableColumns(dd, 'im_robot_turns').has('reject_reason'),
    })

    markMigration(d, SENDER_ISOLATION_MIGRATION)
  })
}

/**
 * SQLite cannot ALTER a CHECK. Existing installs that predate `busy` keep the old
 * constraint until this rebuild copies rows into a table that allows it. Unlike
 * the two marker-gated rebuilds, this one is shape-gated (no migration marker).
 */
function migrateTurnsOutcomeBusy(d: Db): void {
  tx(d, () => {
    rebuildTable(d, {
      table: 'im_robot_turns',
      archive: 'im_robot_turns_pre_busy',
      newDdl: TURNS_TABLE_FRESH,
      copy: (dd, source) => ({
        columns: ALL_TURN_COLS,
        select: ALL_TURN_COLS.map((c) =>
          c === 'reject_reason' && !tableColumns(dd, source).has('reject_reason') ? 'NULL' : c,
        ),
      }),
      indexDdl: TURNS_INDEXES,
      keepArchive: false,
      needs: (dd) => {
        const row = dd.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'im_robot_turns'`,
        )
        return row?.sql ? !row.sql.includes("'busy'") : false
      },
    })
  })
}

/**
 * Upgrade Conversation / Context Turn / turns outcome for identity binding +
 * scope_hash. Safe-cut: old four-dimensional threads and context bodies are not
 * copied. Audit rows are preserved into an expanded outcome CHECK.
 */
function migrateIdentityScope(d: Db): void {
  if (hasMigration(d, IDENTITY_SCOPE_MIGRATION)) return

  tx(d, () => {
    // ---- Threads: cut old PK; do not copy session_id or rows ----
    rebuildTable(d, {
      table: 'im_robot_threads',
      archive: 'im_robot_threads_pre_identity',
      newDdl: THREADS_TABLE_FRESH,
      copy: null,
      indexDdl: THREADS_INDEXES,
      keepArchive: true,
      needs: (dd) => {
        const cols = tableColumns(dd, 'im_robot_threads')
        return !cols.has('binding_id') || !cols.has('scope_hash')
      },
    })

    // ---- Context turns: cut old bodies (no trusted subject); hard-delete archive ----
    rebuildTable(d, {
      table: 'im_robot_context_turns',
      archive: 'im_robot_context_turns_pre_identity',
      newDdl: CONTEXT_TURNS_TABLE_FRESH,
      copy: null,
      indexDdl: CONTEXT_TURNS_INDEXES,
      keepArchive: false, // hard-delete archived bodies after rename
      needs: (dd) => {
        const cols = tableColumns(dd, 'im_robot_context_turns')
        return !cols.has('binding_id') || !cols.has('scope_hash')
      },
    })

    // ---- Audit turns: widen outcome CHECK; copy all historical rows ----
    rebuildTable(d, {
      table: 'im_robot_turns',
      archive: 'im_robot_turns_pre_identity',
      newDdl: TURNS_TABLE_FRESH,
      copy: { columns: ALL_TURN_COLS, select: ALL_TURN_COLS },
      indexDdl: TURNS_INDEXES,
      keepArchive: false,
      needs: (dd) => {
        const row = dd.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'im_robot_turns'`,
        )
        return row?.sql ? !row.sql.includes("'identity_required'") : false
      },
    })

    execIdentitySchema(d)

    markMigration(d, IDENTITY_SCOPE_MIGRATION)
  })
}

// ---- ADD COLUMN migrations ----

function ensureColumn(d: Db, table: string, column: string, ddl: string): void {
  const cols = tableColumns(d, table)
  if (!cols.has(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

function migrateRobotLocale(d: Db): void {
  if (hasMigration(d, LOCALE_MIGRATION)) return
  tx(d, () => {
    const cols = tableColumns(d, 'im_robots')
    if (!cols.has('locale')) {
      d.exec(`ALTER TABLE im_robots ADD COLUMN locale TEXT
        CHECK(locale IS NULL OR locale IN ('en','zh','ja','ko','ru'))`)
      d.exec("UPDATE im_robots SET locale = 'zh'")
    }
    markMigration(d, LOCALE_MIGRATION)
  })
}

function migrateConfigRevision(d: Db): void {
  if (hasMigration(d, CONFIG_REVISION_MIGRATION)) return
  tx(d, () => {
    ensureColumn(d, 'im_robots', 'config_revision', 'INTEGER NOT NULL DEFAULT 0')
    markMigration(d, CONFIG_REVISION_MIGRATION)
  })
}

/** Add L0 broadcast config columns and backfill ack hash for existing robots. */
function migrateBroadcastConfig(d: Db): void {
  if (hasMigration(d, BROADCAST_CONFIG_MIGRATION)) return
  tx(d, () => {
    ensureColumn(d, 'im_robots', 'outbound_ack_hash', 'TEXT')
    ensureColumn(d, 'im_robots', 'broadcast_event_types', "TEXT NOT NULL DEFAULT '[]'")
    ensureColumn(d, 'im_robots', 'broadcast_to_bound_users', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(d, 'im_robots', 'broadcast_group_chat_ids', "TEXT NOT NULL DEFAULT '[]'")
    const rows = d.all<RobotRow>('SELECT * FROM im_robots')
    for (const row of rows) {
      const robot = toRobot(row)
      if (robot.outboundAckAt != null && robot.outboundAckHash == null) {
        d.run(
          'UPDATE im_robots SET outbound_ack_hash = ? WHERE id = ?',
          computeOutboundConfigHash(robot),
          robot.id,
        )
      }
    }
    markMigration(d, BROADCAST_CONFIG_MIGRATION)
  })
}

/**
 * Drop the platform-specific `CHECK(platform IN ('feishu'))` that leaked a
 * provider name into the neutral robots table. SQLite cannot ALTER a CHECK, so
 * this rebuilds through the shared helper: rename aside, create the fresh table
 * from {@link IM_ROBOTS_TABLE_BODY} — which already carries EVERY column — then
 * copy each row and drop the archive.
 *
 * Shape-gated like {@link migrateTurnsOutcomeBusy}, not marker-gated: it runs
 * after the column-adding migrations, so an old table always has the full
 * column set to copy; a mid-flight table that skipped one falls back to that
 * column's DEFAULT so the NOT NULL copy still succeeds.
 */
function migrateImRobotsPlatformCheck(d: Db): void {
  tx(d, () => {
    rebuildTable(d, {
      table: 'im_robots',
      archive: 'im_robots_pre_platform_check',
      newDdl: ROBOTS_TABLE_FRESH,
      copy: (dd, source) => {
        const cols = tableColumns(dd, source)
        const fallback: Record<string, string> = {
          locale: 'NULL',
          outbound_ack_hash: 'NULL',
          broadcast_event_types: "'[]'",
          broadcast_to_bound_users: '0',
          broadcast_group_chat_ids: "'[]'",
          config_revision: '0',
        }
        return {
          columns: ALL_ROBOT_COLS,
          select: ALL_ROBOT_COLS.map((c) => (cols.has(c) ? c : (fallback[c] ?? c))),
        }
      },
      indexDdl: ROBOTS_INDEXES,
      keepArchive: false,
      needs: (dd) => {
        const row = dd.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'im_robots'`,
        )
        return row?.sql ? row.sql.includes("CHECK(platform IN ('feishu'))") : false
      },
    })
  })
}

// ---- Idempotent schema ensure ----

function ensureSchema(d: Db): void {
  d.exec(ROBOTS_TABLE)
  migrateSenderIsolation(d)
  migrateRobotLocale(d)
  // Idempotent creates for fresh DBs that already ran the migration marker path
  // after rename, and for DBs that never had the old tables.
  d.exec(THREADS_TABLE)
  d.exec(CONTEXT_TURNS_TABLE)
  d.exec(TURNS_TABLE)
  migrateTurnsOutcomeBusy(d)
  migrateIdentityScope(d)
  migrateBroadcastConfig(d)
  migrateConfigRevision(d)
  // After the column migrations so an old table has the full set to copy.
  migrateImRobotsPlatformCheck(d)
  // Re-create after rebuild migrations (tables may have been rebuilt).
  d.exec(THREADS_TABLE)
  d.exec(CONTEXT_TURNS_TABLE)
  d.exec(TURNS_TABLE)
  d.exec(ALL_INDEXES)
  validateRobotMessageRegistry()
}

/** Whether the sender-isolation migration has been recorded on the open DB. */
export function hasSenderIsolationMigration(): boolean {
  const d = db()
  if (!d) return false
  return hasMigration(d, SENDER_ISOLATION_MIGRATION)
}

// The lazy `db()` entrypoint runs this once per fresh connection; the post-ensure
// step lets the context store converge leftover pending rows after a restart.
registerSchemaSetup(ensureSchema, failStalePendingContextTurns)
