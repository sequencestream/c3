/**
 * Persistence for IM chat robots: configuration, thread↔session mapping, and the
 * outbound audit trail (ADR-0046).
 *
 * Three properties this module is responsible for keeping true:
 *
 *  - **A robot is never enabled by accident.** `enabled` starts at 0 and there is
 *    no create-and-enable call. Enabling is refused unless the operator has
 *    acknowledged what leaves the machine; that check lives here, not only in the
 *    console, so a client that skips the dialog still cannot turn a robot on.
 *  - **The app secret is only ever stored encrypted.** It enters as plaintext on a
 *    write, is encrypted before it touches a row, and leaves this module only
 *    through the one accessor the supervisor needs to connect. Everything else
 *    sees `hasSecret`.
 *  - **The audit records that an outbound happened, never what was said.** A turn
 *    row carries a character count. An outbound copy of the text is exactly the
 *    kind of data ADR-0045 keeps off disk.
 *
 * Availability follows the established store contract: reads degrade to an empty
 * result when the database is unavailable, writes throw. A write that failed must
 * never come back as a receipt.
 */
import { randomUUID } from 'node:crypto'
import {
  IM_DM_MODES,
  IM_PLATFORMS,
  ROBOT_NAME_PATTERN,
  type ImDmMode,
  type ImPlatform,
  type ImRobot,
  type ImRobotTurnLog,
  type ImTurnOutcome,
  type VendorId,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { encryptSecret, decryptSecret } from '../../kernel/config/encryption.js'

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
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  session_id      TEXT,
  vendor          TEXT NOT NULL,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  PRIMARY KEY (robot_id, thread_key)
);`

const TURNS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robot_turns (
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
                 CHECK(outcome IS NULL OR outcome IN
                   ('complete','error','blocked','timeout','guard_refused')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT
);`

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_robot_name ON im_robots(name);
CREATE INDEX IF NOT EXISTS idx_im_robot_enabled ON im_robots(enabled);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);`

let schemaReadyFor: Db | null = null

function ensureSchema(d: Db): void {
  d.exec(ROBOTS_TABLE)
  d.exec(THREADS_TABLE)
  d.exec(TURNS_TABLE)
  d.exec(INDEXES)
}

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
    } catch {
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
}

/** Materialize the tables at startup so an unusable database is found early. */
export function ensureRobotSchema(): boolean {
  return db() !== null
}

export function isStoreAvailable(): boolean {
  return db() !== null
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

/** Parse a JSON string column into a string list, tolerating a corrupted value. */
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

/** Robots the supervisor should hold a connection for. */
export function listEnabledRobots(): ImRobot[] {
  return listRobots().filter((r) => r.enabled)
}

/**
 * The decrypted app secret, for the one caller that must present it to the
 * platform. Kept separate from {@link getRobot} so that reading a robot for any
 * other purpose cannot carry the plaintext along by accident.
 */
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

/**
 * Create a robot. It is always created disabled and unacknowledged — turning it
 * on is a separate, deliberate act (ADR-0046), so there is no `enabled` input.
 */
export function createRobot(input: CreateRobotInput): ImRobot {
  const d = requireDb()
  if (!IM_PLATFORMS.includes(input.platform)) {
    throw new RobotStoreError('platform_unsupported', '不支持的 IM 平台。')
  }
  validateName(d, input.name)
  const now = Date.now()
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
    now,
    now,
  )
  const created = getRobot(id)
  if (!created) throw new RobotStoreError('db_unavailable', '机器人创建后读取失败。')
  return created
}

export interface UpdateRobotInput {
  appId?: string
  /** Plaintext. Omit to keep the stored secret; pass '' to clear it. */
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

/**
 * Update a robot's configuration. `name` and `platform` are absent by design:
 * the name is also the working directory, so changing it would orphan every
 * thread's history, and the platform decides which credentials mean anything.
 */
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
    set('updated_at', Date.now())
    params.push(id)
    d.run(`UPDATE im_robots SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }
  const updated = getRobot(id)
  if (!updated) throw new RobotStoreError('not_found', '机器人不存在。')
  return updated
}

/** Record that the operator acknowledged what a robot sends off the machine. */
export function acknowledgeOutbound(id: string): ImRobot {
  const d = requireDb()
  const now = Date.now()
  d.run('UPDATE im_robots SET outbound_ack_at = ?, updated_at = ? WHERE id = ?', now, now, id)
  const robot = getRobot(id)
  if (!robot) throw new RobotStoreError('not_found', '机器人不存在。')
  return robot
}

/**
 * Enable or disable a robot. Enabling requires both a credential to connect with
 * and a recorded acknowledgement — the server refuses regardless of what the
 * client rendered, so skipping the dialog cannot turn a robot on.
 */
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
  d.run(
    'UPDATE im_robots SET enabled = ?, updated_at = ? WHERE id = ?',
    enabled ? 1 : 0,
    Date.now(),
    id,
  )
  const next = getRobot(id)
  if (!next) throw new RobotStoreError('not_found', '机器人不存在。')
  return next
}

/** Delete a robot together with its threads and audit rows. */
export function deleteRobot(id: string): void {
  const d = requireDb()
  d.run('DELETE FROM im_robot_turns WHERE robot_id = ?', id)
  d.run('DELETE FROM im_robot_threads WHERE robot_id = ?', id)
  d.run('DELETE FROM im_robots WHERE id = ?', id)
}

// ---- Threads ----

export interface RobotThread {
  robotId: string
  threadKey: string
  chatId: string
  sessionId: string | null
  vendor: VendorId
  turnCount: number
  lastMessageId: string | null
  createdAt: number
  lastActiveAt: number
}

interface ThreadRow {
  robot_id: string
  thread_key: string
  chat_id: string
  session_id: string | null
  vendor: string
  turn_count: number
  last_message_id: string | null
  created_at: number
  last_active_at: number
}

function toThread(r: ThreadRow): RobotThread {
  return {
    robotId: r.robot_id,
    threadKey: r.thread_key,
    chatId: r.chat_id,
    sessionId: r.session_id,
    vendor: r.vendor as VendorId,
    turnCount: r.turn_count,
    lastMessageId: r.last_message_id,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }
}

export function getThread(robotId: string, threadKey: string): RobotThread | null {
  const d = db()
  if (!d) return null
  const row = d.get<ThreadRow>(
    'SELECT * FROM im_robot_threads WHERE robot_id = ? AND thread_key = ?',
    robotId,
    threadKey,
  )
  return row ? toThread(row) : null
}

/**
 * Create the thread row if this is its first message, and record which inbound
 * message is being handled. Returns the thread as it stands BEFORE this message
 * — the caller needs the previously bound session to resume.
 */
export function openThread(input: {
  robotId: string
  threadKey: string
  chatId: string
  vendor: VendorId
  messageId: string
}): RobotThread {
  const d = requireDb()
  const now = Date.now()
  const existing = getThread(input.robotId, input.threadKey)
  if (!existing) {
    d.run(
      `INSERT INTO im_robot_threads
         (robot_id, thread_key, chat_id, session_id, vendor, turn_count, last_message_id,
          created_at, last_active_at)
       VALUES (?,?,?,NULL,?,0,?,?,?)`,
      input.robotId,
      input.threadKey,
      input.chatId,
      input.vendor,
      input.messageId,
      now,
      now,
    )
    return {
      robotId: input.robotId,
      threadKey: input.threadKey,
      chatId: input.chatId,
      sessionId: null,
      vendor: input.vendor,
      turnCount: 0,
      lastMessageId: input.messageId,
      createdAt: now,
      lastActiveAt: now,
    }
  }
  d.run(
    'UPDATE im_robot_threads SET last_message_id = ?, chat_id = ?, last_active_at = ? WHERE robot_id = ? AND thread_key = ?',
    input.messageId,
    input.chatId,
    now,
    input.robotId,
    input.threadKey,
  )
  return existing
}

/**
 * Bind the session a completed turn ran in, so the next message in this thread
 * resumes the same conversation. A session only resumes within the vendor that
 * produced it, so the vendor is recorded alongside.
 */
export function bindThreadSession(
  robotId: string,
  threadKey: string,
  sessionId: string,
  vendor: VendorId,
): void {
  const d = requireDb()
  d.run(
    `UPDATE im_robot_threads
       SET session_id = ?, vendor = ?, turn_count = turn_count + 1, last_active_at = ?
     WHERE robot_id = ? AND thread_key = ?`,
    sessionId,
    vendor,
    Date.now(),
    robotId,
    threadKey,
  )
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
  outbound_chars: number
  error: string | null
}

/** Open an audit row for a turn that is about to run. Returns its id. */
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
        started_at, finished_at, outcome, outbound_chars, out_message_id, error)
     VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL,0,NULL,NULL)`,
    id,
    input.robotId,
    input.threadKey,
    input.chatId,
    input.senderId,
    input.messageId,
    Date.now(),
  )
  return id
}

/**
 * Close an audit row. `outboundChars` is a LENGTH — the sent text itself is
 * deliberately not persisted anywhere (ADR-0045).
 */
export function finishTurn(
  turnId: string,
  result: {
    outcome: ImTurnOutcome
    sessionId?: string | null
    outboundChars?: number
    outMessageId?: string | null
    error?: string | null
  },
): void {
  const d = requireDb()
  d.run(
    `UPDATE im_robot_turns
       SET finished_at = ?, outcome = ?, session_id = ?, outbound_chars = ?,
           out_message_id = ?, error = ?
     WHERE id = ?`,
    Date.now(),
    result.outcome,
    result.sessionId ?? null,
    result.outboundChars ?? 0,
    result.outMessageId ?? null,
    result.error ?? null,
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
      outboundChars: r.outbound_chars,
      error: r.error,
    }))
}
