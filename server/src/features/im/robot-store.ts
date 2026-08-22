/**
 * Persistence for IM chat robots: configuration, sender-isolated Conversations,
 * bounded IM-visible context (ADR-0048), and the outbound audit trail (ADR-0046).
 *
 * Properties this module keeps true:
 *
 *  - **A robot is never enabled by accident.** `enabled` starts at 0; enabling
 *    requires credential + outbound acknowledgement.
 *  - **The app secret is only ever stored encrypted.**
 *  - **Conversation identity is four-dimensional.** `(platform, robotId,
 *    threadKey, senderId)` — different senders never share recoverable context.
 *  - **Context bodies are bounded.** Credential shape refuse, 4000 code points,
 *    50 turns, 30-day hard delete. Audit rows still carry no body.
 *  - **Old shared sessions are cut, not migrated.** A pre-sender threads table is
 *    renamed aside; no `session_id` is copied onto a sender Conversation.
 */
import { randomUUID } from 'node:crypto'
import {
  IM_DM_MODES,
  IM_PLATFORMS,
  ROBOT_CONTEXT_MAX_CODEPOINTS,
  ROBOT_CONTEXT_MAX_TURNS,
  ROBOT_CONTEXT_RETENTION_MS,
  ROBOT_NAME_PATTERN,
  type ImDmMode,
  type ImInputRejectReason,
  type ImPlatform,
  type ImRobot,
  type ImRobotTurnLog,
  type ImTurnOutcome,
  type VendorId,
} from '@ccc/shared/protocol'
import {
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../../kernel/infra/db.js'
import { encryptSecret, decryptSecret } from '../../kernel/config/encryption.js'
import { truncateCodePoints } from './inbound-guard.js'
import type { ConversationIdentity } from './thread-key.js'

// ---- Errors ----

export type RobotStoreErrorCode =
  | 'db_unavailable'
  | 'not_found'
  | 'name_invalid'
  | 'name_conflict'
  | 'platform_unsupported'
  | 'secret_required'
  | 'outbound_not_acknowledged'

export class RobotStoreError extends Error {
  constructor(
    readonly code: RobotStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RobotStoreError'
  }
}

// ---- Constants / clock ----

const SENDER_ISOLATION_MIGRATION = 'robots.sender_isolation.v1'
/** Soft budget for recovery seed size (Unicode code points across all turns). */
export const ROBOT_CONTEXT_RECOVERY_BUDGET = 80_000

let nowFn: () => number = () => Date.now()

/** Test hook: inject a clock for retention boundaries. */
export function setRobotStoreClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

function now(): number {
  return nowFn()
}

// ---- Schema ----

const ROBOTS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robots (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  platform         TEXT NOT NULL
                   CHECK(platform IN ('feishu')),
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
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);`

const THREADS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robot_threads (
  platform         TEXT NOT NULL,
  robot_id         TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  session_id       TEXT,
  vendor           TEXT NOT NULL,
  context_revision INTEGER NOT NULL DEFAULT 0,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER NOT NULL,
  PRIMARY KEY (platform, robot_id, thread_key, sender_id)
);`

const CONTEXT_TURNS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robot_context_turns (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  in_message_id   TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK(status IN ('pending','committed','failed')),
  user_text       TEXT NOT NULL DEFAULT '',
  assistant_text  TEXT NOT NULL DEFAULT '',
  seq             INTEGER,
  committed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (platform, robot_id, in_message_id)
);`

const TURNS_OUTCOME_CHECK =
  "('complete','error','blocked','timeout','guard_refused','input_rejected','busy')"

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
  error          TEXT
`

const TURNS_TABLE = `CREATE TABLE IF NOT EXISTS im_robot_turns (${TURNS_TABLE_BODY});`

const TURNS_TABLE_FRESH = `CREATE TABLE im_robot_turns (${TURNS_TABLE_BODY});`

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_robot_name ON im_robots(name);
CREATE INDEX IF NOT EXISTS idx_im_robot_enabled ON im_robots(enabled);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);
CREATE INDEX IF NOT EXISTS idx_im_ctx_conversation
  ON im_robot_context_turns(platform, robot_id, thread_key, sender_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_im_ctx_committed_at ON im_robot_context_turns(committed_at);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);`

let schemaReadyFor: Db | null = null
let schemaFailed = false

function tableColumns(d: Db, table: string): Set<string> {
  return new Set(d.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
}

function tableExists(d: Db, table: string): boolean {
  return !!d.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    table,
  )
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
    if (tableExists(d, 'im_robot_threads')) {
      const cols = tableColumns(d, 'im_robot_threads')
      if (!cols.has('sender_id')) {
        // Safe cut: keep the old rows under a name no read path touches.
        if (!tableExists(d, 'im_robot_threads_pre_sender')) {
          d.exec('ALTER TABLE im_robot_threads RENAME TO im_robot_threads_pre_sender')
        } else {
          // Interrupted prior attempt left both — drop the incomplete new name by
          // renaming it aside with a unique suffix is forbidden (DROP). Clear via
          // rename of the current incomplete table if it lacks sender_id.
          d.exec(`ALTER TABLE im_robot_threads RENAME TO im_robot_threads_pre_sender_${Date.now()}`)
        }
      }
    }
    d.exec(THREADS_TABLE)

    // ---- Context turns (new) ----
    d.exec(CONTEXT_TURNS_TABLE)

    // ---- Audit turns: extend outcome CHECK + reject_reason ----
    if (tableExists(d, 'im_robot_turns')) {
      const cols = tableColumns(d, 'im_robot_turns')
      if (!cols.has('reject_reason')) {
        if (!tableExists(d, 'im_robot_turns_pre_input_rejected')) {
          d.exec('ALTER TABLE im_robot_turns RENAME TO im_robot_turns_pre_input_rejected')
        } else {
          d.exec(
            `ALTER TABLE im_robot_turns RENAME TO im_robot_turns_pre_input_rejected_${Date.now()}`,
          )
        }
        d.exec(TURNS_TABLE)
        if (tableExists(d, 'im_robot_turns_pre_input_rejected')) {
          d.exec(`
            INSERT INTO im_robot_turns
              (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
               started_at, finished_at, outcome, reject_reason, outbound_chars,
               out_message_id, error)
            SELECT id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
                   started_at, finished_at, outcome, NULL, outbound_chars,
                   out_message_id, error
            FROM im_robot_turns_pre_input_rejected
          `)
          // Same index ownership pitfall as the busy rebuild: RENAME keeps the old
          // index names on the pre_ table, so INDEXES' IF NOT EXISTS would skip.
          d.exec('DROP TABLE im_robot_turns_pre_input_rejected')
        }
      }
    } else {
      d.exec(TURNS_TABLE)
    }

    markMigration(d, SENDER_ISOLATION_MIGRATION)
  })
}

/**
 * SQLite cannot ALTER a CHECK. Existing installs that predate `busy` keep the old
 * constraint until this rebuild copies rows into a table that allows it.
 */
function migrateTurnsOutcomeBusy(d: Db): void {
  const row = d.get<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'im_robot_turns'`,
  )
  if (!row?.sql || row.sql.includes("'busy'")) return
  const cols = tableColumns(d, 'im_robot_turns')
  d.exec('ALTER TABLE im_robot_turns RENAME TO im_robot_turns_pre_busy')
  d.exec(TURNS_TABLE_FRESH)
  if (cols.has('reject_reason')) {
    d.exec('INSERT INTO im_robot_turns SELECT * FROM im_robot_turns_pre_busy')
  } else {
    d.exec(`
      INSERT INTO im_robot_turns
        (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
         started_at, finished_at, outcome, reject_reason, outbound_chars,
         out_message_id, error)
      SELECT id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
             started_at, finished_at, outcome, NULL, outbound_chars,
             out_message_id, error
      FROM im_robot_turns_pre_busy
    `)
  }
  // Drop the renamed table so its indexes (same names as INDEXES below) go with
  // it; otherwise CREATE INDEX IF NOT EXISTS would skip and the new table stays
  // unindexed.
  d.exec('DROP TABLE im_robot_turns_pre_busy')
}

function ensureSchema(d: Db): void {
  d.exec(ROBOTS_TABLE)
  migrateSenderIsolation(d)
  // Idempotent creates for fresh DBs that already ran the migration marker path
  // after rename, and for DBs that never had the old tables.
  d.exec(THREADS_TABLE)
  d.exec(CONTEXT_TURNS_TABLE)
  d.exec(TURNS_TABLE)
  migrateTurnsOutcomeBusy(d)
  d.exec(INDEXES)
}

function db(): Db | null {
  if (schemaFailed) return null
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
      failStalePendingContextTurns(d)
    } catch (err) {
      schemaFailed = true
      schemaReadyFor = null
      console.error(
        '[c3][im] robot schema migration failed; supervisor must not start:',
        err instanceof Error ? err.message : err,
      )
      return null
    }
    schemaReadyFor = d
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new RobotStoreError('db_unavailable', '机器人库不可用,本次写入未生效。')
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetRobotStoreForTests(): void {
  schemaReadyFor = null
  schemaFailed = false
  nowFn = () => Date.now()
}

/** Materialize the tables at startup so an unusable database is found early. */
export function ensureRobotSchema(): boolean {
  return db() !== null
}

export function isStoreAvailable(): boolean {
  return db() !== null
}

/** Whether the sender-isolation migration has been recorded on the open DB. */
export function hasSenderIsolationMigration(): boolean {
  const d = db()
  if (!d) return false
  return hasMigration(d, SENDER_ISOLATION_MIGRATION)
}

// ---- Row mapping ----

interface RobotRow {
  id: string
  name: string
  platform: string
  app_id: string
  app_secret: string
  vendor: string
  agent_id: string
  mode: string
  tool_allowlist: string
  require_mention: number
  chat_allowlist: string
  dm_mode: string
  dm_allowlist: string
  max_turn_ms: number | null
  enabled: number
  outbound_ack_at: number | null
  created_at: number
  updated_at: number
}

function parseList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toRobot(r: RobotRow): ImRobot {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as ImPlatform,
    appId: r.app_id,
    hasSecret: r.app_secret !== '',
    vendor: r.vendor as VendorId,
    agentId: r.agent_id,
    mode: r.mode,
    toolAllowlist: parseList(r.tool_allowlist),
    requireMention: r.require_mention === 1,
    chatAllowlist: parseList(r.chat_allowlist),
    dmMode: r.dm_mode as ImDmMode,
    dmAllowlist: parseList(r.dm_allowlist),
    maxTurnMs: r.max_turn_ms,
    enabled: r.enabled === 1,
    outboundAckAt: r.outbound_ack_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const SELECT_ROBOT = 'SELECT * FROM im_robots'

// ---- Robot reads ----

export function listRobots(): ImRobot[] {
  const d = db()
  if (!d) return []
  return d.all<RobotRow>(`${SELECT_ROBOT} ORDER BY created_at ASC`).map(toRobot)
}

export function getRobot(id: string): ImRobot | null {
  const d = db()
  if (!d) return null
  const row = d.get<RobotRow>(`${SELECT_ROBOT} WHERE id = ?`, id)
  return row ? toRobot(row) : null
}

export function listEnabledRobots(): ImRobot[] {
  return listRobots().filter((r) => r.enabled)
}

export function robotSecret(id: string): string {
  const d = db()
  if (!d) return ''
  const row = d.get<{ app_secret: string }>('SELECT app_secret FROM im_robots WHERE id = ?', id)
  return row ? decryptSecret(row.app_secret) : ''
}

// ---- Robot writes ----

export interface CreateRobotInput {
  name: string
  platform: ImPlatform
  appId: string
  appSecret: string
  vendor: VendorId
  agentId: string
  mode?: string
  toolAllowlist?: string[]
  requireMention?: boolean
  chatAllowlist?: string[]
  dmMode?: ImDmMode
  dmAllowlist?: string[]
  maxTurnMs?: number | null
}

function validateName(d: Db, name: string, excludeId?: string): void {
  if (!ROBOT_NAME_PATTERN.test(name)) {
    throw new RobotStoreError(
      'name_invalid',
      '机器人名只能是小写字母、数字、连字符或下划线,以字母或数字开头,最长 32 个字符。',
    )
  }
  const clash = d.get<{ id: string }>('SELECT id FROM im_robots WHERE name = ?', name)
  if (clash && clash.id !== excludeId) {
    throw new RobotStoreError('name_conflict', '已有同名机器人。')
  }
}

export function createRobot(input: CreateRobotInput): ImRobot {
  const d = requireDb()
  if (!IM_PLATFORMS.includes(input.platform)) {
    throw new RobotStoreError('platform_unsupported', '不支持的 IM 平台。')
  }
  validateName(d, input.name)
  const t = now()
  const id = randomUUID()
  d.run(
    `INSERT INTO im_robots
       (id, name, platform, app_id, app_secret, vendor, agent_id, mode, tool_allowlist,
        require_mention, chat_allowlist, dm_mode, dm_allowlist, max_turn_ms,
        enabled, outbound_ack_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)`,
    id,
    input.name,
    input.platform,
    input.appId,
    encryptSecret(input.appSecret ?? ''),
    input.vendor,
    input.agentId,
    input.mode ?? '',
    JSON.stringify(input.toolAllowlist ?? []),
    input.requireMention === false ? 0 : 1,
    JSON.stringify(input.chatAllowlist ?? []),
    input.dmMode && IM_DM_MODES.includes(input.dmMode) ? input.dmMode : 'disabled',
    JSON.stringify(input.dmAllowlist ?? []),
    input.maxTurnMs ?? null,
    t,
    t,
  )
  const created = getRobot(id)
  if (!created) throw new RobotStoreError('db_unavailable', '机器人创建后读取失败。')
  return created
}

export interface UpdateRobotInput {
  appId?: string
  appSecret?: string
  vendor?: VendorId
  agentId?: string
  mode?: string
  toolAllowlist?: string[]
  requireMention?: boolean
  chatAllowlist?: string[]
  dmMode?: ImDmMode
  dmAllowlist?: string[]
  maxTurnMs?: number | null
}

export function updateRobot(id: string, patch: UpdateRobotInput): ImRobot {
  const d = requireDb()
  const existing = getRobot(id)
  if (!existing) throw new RobotStoreError('not_found', '机器人不存在。')

  const sets: string[] = []
  const params: (string | number | null)[] = []
  const set = (col: string, value: string | number | null): void => {
    sets.push(`${col} = ?`)
    params.push(value)
  }
  if (patch.appId !== undefined) set('app_id', patch.appId)
  if (patch.appSecret !== undefined) set('app_secret', encryptSecret(patch.appSecret))
  if (patch.vendor !== undefined) set('vendor', patch.vendor)
  if (patch.agentId !== undefined) set('agent_id', patch.agentId)
  if (patch.mode !== undefined) set('mode', patch.mode)
  if (patch.toolAllowlist !== undefined) set('tool_allowlist', JSON.stringify(patch.toolAllowlist))
  if (patch.requireMention !== undefined) set('require_mention', patch.requireMention ? 1 : 0)
  if (patch.chatAllowlist !== undefined) set('chat_allowlist', JSON.stringify(patch.chatAllowlist))
  if (patch.dmMode !== undefined && IM_DM_MODES.includes(patch.dmMode)) set('dm_mode', patch.dmMode)
  if (patch.dmAllowlist !== undefined) set('dm_allowlist', JSON.stringify(patch.dmAllowlist))
  if (patch.maxTurnMs !== undefined) set('max_turn_ms', patch.maxTurnMs)

  if (sets.length > 0) {
    set('updated_at', now())
    params.push(id)
    d.run(`UPDATE im_robots SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }
  const updated = getRobot(id)
  if (!updated) throw new RobotStoreError('not_found', '机器人不存在。')
  return updated
}

export function acknowledgeOutbound(id: string): ImRobot {
  const d = requireDb()
  const t = now()
  d.run('UPDATE im_robots SET outbound_ack_at = ?, updated_at = ? WHERE id = ?', t, t, id)
  const robot = getRobot(id)
  if (!robot) throw new RobotStoreError('not_found', '机器人不存在。')
  return robot
}

export function setRobotEnabled(id: string, enabled: boolean): ImRobot {
  const d = requireDb()
  const robot = getRobot(id)
  if (!robot) throw new RobotStoreError('not_found', '机器人不存在。')
  if (enabled) {
    if (!robot.hasSecret) {
      throw new RobotStoreError('secret_required', '启用前需要先配置应用密钥。')
    }
    if (robot.outboundAckAt === null) {
      throw new RobotStoreError(
        'outbound_not_acknowledged',
        '启用前需要先确认发往第三方平台的内容范围。',
      )
    }
  }
  d.run('UPDATE im_robots SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), id)
  const next = getRobot(id)
  if (!next) throw new RobotStoreError('not_found', '机器人不存在。')
  return next
}

/** Delete a robot together with its Conversations, context and audit rows. */
export function deleteRobot(id: string): void {
  const d = requireDb()
  tx(d, () => {
    d.run('DELETE FROM im_robot_context_turns WHERE robot_id = ?', id)
    d.run('DELETE FROM im_robot_turns WHERE robot_id = ?', id)
    d.run('DELETE FROM im_robot_threads WHERE robot_id = ?', id)
    d.run('DELETE FROM im_robots WHERE id = ?', id)
  })
}

// ---- Conversations ----

export interface RobotConversation {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
  chatId: string
  sessionId: string | null
  vendor: VendorId
  contextRevision: number
  turnCount: number
  createdAt: number
  lastActiveAt: number
}

interface ConversationRow {
  platform: string
  robot_id: string
  thread_key: string
  sender_id: string
  chat_id: string
  session_id: string | null
  vendor: string
  context_revision: number
  turn_count: number
  created_at: number
  last_active_at: number
}

function toConversation(r: ConversationRow): RobotConversation {
  return {
    platform: r.platform as ImPlatform,
    robotId: r.robot_id,
    threadKey: r.thread_key,
    senderId: r.sender_id,
    chatId: r.chat_id,
    sessionId: r.session_id,
    vendor: r.vendor as VendorId,
    contextRevision: r.context_revision,
    turnCount: r.turn_count,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }
}

export function getConversation(id: ConversationIdentity): RobotConversation | null {
  const d = db()
  if (!d) return null
  const row = d.get<ConversationRow>(
    `SELECT * FROM im_robot_threads
     WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
    id.platform,
    id.robotId,
    id.threadKey,
    id.senderId,
  )
  return row ? toConversation(row) : null
}

function ensureConversation(
  d: Db,
  input: ConversationIdentity & { chatId: string; vendor: VendorId },
): RobotConversation {
  const existing = getConversation(input)
  const t = now()
  if (!existing) {
    d.run(
      `INSERT INTO im_robot_threads
         (platform, robot_id, thread_key, sender_id, chat_id, session_id, vendor,
          context_revision, turn_count, created_at, last_active_at)
       VALUES (?,?,?,?,?,NULL,?,0,0,?,?)`,
      input.platform,
      input.robotId,
      input.threadKey,
      input.senderId,
      input.chatId,
      input.vendor,
      t,
      t,
    )
    return {
      platform: input.platform,
      robotId: input.robotId,
      threadKey: input.threadKey,
      senderId: input.senderId,
      chatId: input.chatId,
      sessionId: null,
      vendor: input.vendor,
      contextRevision: 0,
      turnCount: 0,
      createdAt: t,
      lastActiveAt: t,
    }
  }
  d.run(
    `UPDATE im_robot_threads SET chat_id = ?, last_active_at = ?
     WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
    input.chatId,
    t,
    input.platform,
    input.robotId,
    input.threadKey,
    input.senderId,
  )
  return { ...existing, chatId: input.chatId, lastActiveAt: t }
}

export type ContextTurnStatus = 'pending' | 'committed' | 'failed'

export interface CommittedContextTurn {
  userText: string
  assistantText: string
  seq: number
  committedAt: number
}

export type ClaimResult =
  | { kind: 'duplicate' }
  | { kind: 'claimed'; conversation: RobotConversation; contextTurnId: string }

/**
 * Atomically claim an inbound messageId for one Conversation. Duplicate
 * (platform, robotId, messageId) returns `duplicate` without a second run.
 */
export function claimInboundMessage(input: {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
  chatId: string
  vendor: VendorId
  messageId: string
}): ClaimResult {
  const d = requireDb()
  return tx(d, () => {
    const conversation = ensureConversation(d, input)
    // Orphan pending (e.g. crash without restart) blocks the Conversation —
    // fail it and clear the native session cache before claiming anew.
    // Live serialization is the in-memory gate; this only heals DB leftovers.
    const orphan = d.get<{ id: string }>(
      `SELECT id FROM im_robot_context_turns
       WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?
         AND status = 'pending'`,
      input.platform,
      input.robotId,
      input.threadKey,
      input.senderId,
    )
    if (orphan) {
      d.run(
        `UPDATE im_robot_context_turns
           SET status = 'failed', user_text = '', assistant_text = ''
         WHERE id = ?`,
        orphan.id,
      )
      d.run(
        `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
         WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
        now(),
        input.platform,
        input.robotId,
        input.threadKey,
        input.senderId,
      )
    }

    const id = randomUUID()
    try {
      d.run(
        `INSERT INTO im_robot_context_turns
           (id, platform, robot_id, thread_key, sender_id, in_message_id, status,
            user_text, assistant_text, seq, committed_at, created_at)
         VALUES (?,?,?,?,?,?,'pending','','',NULL,NULL,?)`,
        id,
        input.platform,
        input.robotId,
        input.threadKey,
        input.senderId,
        input.messageId,
        now(),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE/i.test(msg)) return { kind: 'duplicate' }
      throw err
    }
    // Re-read after possible session clear.
    const fresh = getConversation(input) ?? conversation
    return { kind: 'claimed', conversation: fresh, contextTurnId: id }
  })
}

/** Converge leftover pending rows after restart; clear their session caches. */
function failStalePendingContextTurns(d: Db): void {
  const pending = d.all<{
    id: string
    platform: string
    robot_id: string
    thread_key: string
    sender_id: string
  }>(
    `SELECT id, platform, robot_id, thread_key, sender_id FROM im_robot_context_turns WHERE status = 'pending'`,
  )
  if (pending.length === 0) return
  tx(d, () => {
    for (const row of pending) {
      d.run(
        `UPDATE im_robot_context_turns
           SET status = 'failed', user_text = '', assistant_text = ''
         WHERE id = ?`,
        row.id,
      )
      d.run(
        `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
         WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
        now(),
        row.platform,
        row.robot_id,
        row.thread_key,
        row.sender_id,
      )
    }
  })
}

export function failContextTurn(contextTurnId: string): void {
  const d = requireDb()
  tx(d, () => {
    const row = d.get<{
      platform: string
      robot_id: string
      thread_key: string
      sender_id: string
      status: string
    }>(
      'SELECT platform, robot_id, thread_key, sender_id, status FROM im_robot_context_turns WHERE id = ?',
      contextTurnId,
    )
    if (!row || row.status !== 'pending') return
    d.run(
      `UPDATE im_robot_context_turns
         SET status = 'failed', user_text = '', assistant_text = ''
       WHERE id = ?`,
      contextTurnId,
    )
    d.run(
      `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
       WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
      now(),
      row.platform,
      row.robot_id,
      row.thread_key,
      row.sender_id,
    )
  })
}

/**
 * Commit a delivered turn into recoverable context and bind the native session
 * cache. Prunes by capacity and retention in the same transaction.
 */
export function commitContextTurn(input: {
  contextTurnId: string
  userText: string
  assistantText: string
  sessionId: string
  vendor: VendorId
}): void {
  const d = requireDb()
  const assistant = truncateCodePoints(input.assistantText, ROBOT_CONTEXT_MAX_CODEPOINTS)
  tx(d, () => {
    const row = d.get<{
      platform: string
      robot_id: string
      thread_key: string
      sender_id: string
      status: string
    }>(
      'SELECT platform, robot_id, thread_key, sender_id, status FROM im_robot_context_turns WHERE id = ?',
      input.contextTurnId,
    )
    if (!row || row.status !== 'pending') return

    const t = now()
    const maxSeq = d.get<{ m: number | null }>(
      `SELECT MAX(seq) AS m FROM im_robot_context_turns
       WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?
         AND status = 'committed'`,
      row.platform,
      row.robot_id,
      row.thread_key,
      row.sender_id,
    )
    const seq = (maxSeq?.m ?? 0) + 1

    d.run(
      `UPDATE im_robot_context_turns
         SET status = 'committed', user_text = ?, assistant_text = ?, seq = ?, committed_at = ?
       WHERE id = ? AND status = 'pending'`,
      input.userText,
      assistant,
      seq,
      t,
      input.contextTurnId,
    )

    d.run(
      `UPDATE im_robot_threads
         SET session_id = ?, vendor = ?,
             context_revision = context_revision + 1,
             turn_count = turn_count + 1,
             last_active_at = ?
       WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
      input.sessionId,
      input.vendor,
      t,
      row.platform,
      row.robot_id,
      row.thread_key,
      row.sender_id,
    )

    pruneConversationContext(d, {
      platform: row.platform as ImPlatform,
      robotId: row.robot_id,
      threadKey: row.thread_key,
      senderId: row.sender_id,
    })
  })
}

function pruneConversationContext(d: Db, id: ConversationIdentity): void {
  const cutoff = now() - ROBOT_CONTEXT_RETENTION_MS
  // Time first: delete expired complete turns (exactly 30 days still kept).
  d.run(
    `DELETE FROM im_robot_context_turns
     WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?
       AND status = 'committed' AND committed_at IS NOT NULL AND committed_at < ?`,
    id.platform,
    id.robotId,
    id.threadKey,
    id.senderId,
    cutoff,
  )

  const committed = d.all<{ id: string; seq: number }>(
    `SELECT id, seq FROM im_robot_context_turns
     WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?
       AND status = 'committed'
     ORDER BY seq ASC, id ASC`,
    id.platform,
    id.robotId,
    id.threadKey,
    id.senderId,
  )
  const overflow = committed.length - ROBOT_CONTEXT_MAX_TURNS
  if (overflow <= 0) return
  const toDelete = committed.slice(0, overflow)
  for (const row of toDelete) {
    d.run('DELETE FROM im_robot_context_turns WHERE id = ?', row.id)
  }
  // Keep turn_count aligned with remaining committed rows.
  d.run(
    `UPDATE im_robot_threads SET turn_count = ?
     WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?`,
    committed.length - overflow,
    id.platform,
    id.robotId,
    id.threadKey,
    id.senderId,
  )
}

/**
 * Load committed IM-visible turns for recovery. Applies retention prune first,
 * then trims from the earliest complete turn if the soft budget is exceeded.
 */
export function loadCommittedContext(id: ConversationIdentity): CommittedContextTurn[] {
  const d = requireDb()
  return tx(d, () => {
    pruneConversationContext(d, id)
    const rows = d.all<{
      user_text: string
      assistant_text: string
      seq: number
      committed_at: number
    }>(
      `SELECT user_text, assistant_text, seq, committed_at FROM im_robot_context_turns
       WHERE platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ?
         AND status = 'committed'
       ORDER BY seq ASC, id ASC`,
      id.platform,
      id.robotId,
      id.threadKey,
      id.senderId,
    )
    const turns: CommittedContextTurn[] = rows.map((r) => ({
      userText: r.user_text,
      assistantText: r.assistant_text,
      seq: r.seq,
      committedAt: r.committed_at,
    }))
    return trimByBudget(turns)
  })
}

function trimByBudget(turns: CommittedContextTurn[]): CommittedContextTurn[] {
  let total = 0
  for (const t of turns) {
    total += Array.from(t.userText).length + Array.from(t.assistantText).length
  }
  if (total <= ROBOT_CONTEXT_RECOVERY_BUDGET) return turns
  const kept = [...turns]
  while (kept.length > 0) {
    total = 0
    for (const t of kept) {
      total += Array.from(t.userText).length + Array.from(t.assistantText).length
    }
    if (total <= ROBOT_CONTEXT_RECOVERY_BUDGET) break
    kept.shift() // drop earliest complete pair — never split a pair
  }
  return kept
}

/**
 * Verified native session reference for resume, or null when the cache must be
 * discarded and the turn must start from the DB seed.
 */
export function resolvedSessionRef(
  conversation: RobotConversation,
  robotVendor: VendorId,
): { sessionId: string; contextRevision: number } | null {
  if (!conversation.sessionId) return null
  if (conversation.vendor !== robotVendor) return null
  return { sessionId: conversation.sessionId, contextRevision: conversation.contextRevision }
}

// ---- Audit ----

interface TurnRow {
  id: string
  robot_id: string
  thread_key: string
  chat_id: string
  sender_id: string
  session_id: string | null
  started_at: number
  finished_at: number | null
  outcome: string | null
  reject_reason: string | null
  outbound_chars: number
  error: string | null
}

export function beginTurn(input: {
  robotId: string
  threadKey: string
  chatId: string
  senderId: string
  messageId: string
}): string {
  const d = requireDb()
  const id = randomUUID()
  d.run(
    `INSERT INTO im_robot_turns
       (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
        started_at, finished_at, outcome, reject_reason, outbound_chars, out_message_id, error)
     VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL,NULL,0,NULL,NULL)`,
    id,
    input.robotId,
    input.threadKey,
    input.chatId,
    input.senderId,
    input.messageId,
    now(),
  )
  return id
}

export function finishTurn(
  turnId: string,
  result: {
    outcome: ImTurnOutcome
    sessionId?: string | null
    outboundChars?: number
    outMessageId?: string | null
    error?: string | null
    rejectReason?: ImInputRejectReason | null
  },
): void {
  const d = requireDb()
  d.run(
    `UPDATE im_robot_turns
       SET finished_at = ?, outcome = ?, session_id = ?, outbound_chars = ?,
           out_message_id = ?, error = ?, reject_reason = ?
     WHERE id = ?`,
    now(),
    result.outcome,
    result.sessionId ?? null,
    result.outboundChars ?? 0,
    result.outMessageId ?? null,
    result.error ?? null,
    result.rejectReason ?? null,
    turnId,
  )
}

export function listTurns(robotId: string, limit = 50): ImRobotTurnLog[] {
  const d = db()
  if (!d) return []
  return d
    .all<TurnRow>(
      'SELECT * FROM im_robot_turns WHERE robot_id = ? ORDER BY started_at DESC LIMIT ?',
      robotId,
      limit,
    )
    .map((r) => ({
      id: r.id,
      robotId: r.robot_id,
      threadKey: r.thread_key,
      chatId: r.chat_id,
      senderId: r.sender_id,
      sessionId: r.session_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      outcome: r.outcome as ImTurnOutcome | null,
      rejectReason: (r.reject_reason as ImInputRejectReason | null) ?? null,
      outboundChars: r.outbound_chars,
      error: r.error,
    }))
}
