/**
 * IM robot configuration persistence: the `im_robots` row and its read/write
 * surface. A robot is never enabled by accident — `enabled` starts at 0 and
 * enabling requires credential + outbound acknowledgement; the app secret is
 * only ever stored encrypted and comes back through one dedicated accessor.
 *
 * The row mapping (`toRobot`) is also the schema module's read entry for the
 * broadcast-config backfill, kept here (not in the schema module) to avoid a
 * schema↔store cycle.
 */
import { randomUUID } from 'node:crypto'
import {
  IM_BROADCAST_TYPES,
  IM_DM_MODES,
  IM_PLATFORMS,
  ROBOT_MESSAGE_LOCALES,
  ROBOT_NAME_PATTERN,
  type ImBroadcastType,
  type ImDmMode,
  type ImPlatform,
  type ImRobot,
  type RobotMessageLocale,
  type VendorId,
} from '@ccc/shared/protocol'
import type { Db } from '../../kernel/infra/db.js'
import { encryptSecret, decryptSecret } from '../../kernel/config/encryption.js'
import { computeOutboundConfigHash, outboundConfigAcknowledged } from './outbound-config-hash.js'
import { listWriteGrantsForRobot } from './write-grant-store.js'
import { RobotStoreError, db, now, requireDb, tx } from './robot-db.js'

// ---- Row mapping ----

export interface RobotRow {
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
  outbound_ack_hash: string | null
  broadcast_event_types: string
  broadcast_to_bound_users: number
  broadcast_group_chat_ids: string
  locale: string | null
  config_revision: number
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

function parseBroadcastTypes(raw: string): ImBroadcastType[] {
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(
      (x): x is ImBroadcastType =>
        typeof x === 'string' && (IM_BROADCAST_TYPES as readonly string[]).includes(x),
    )
  } catch {
    return []
  }
}

function parseLocale(raw: string | null): RobotMessageLocale | null {
  if (!raw) return null
  return (ROBOT_MESSAGE_LOCALES as readonly string[]).includes(raw)
    ? (raw as RobotMessageLocale)
    : null
}

function assertLocale(value: RobotMessageLocale | null | undefined): RobotMessageLocale | null {
  if (value === undefined || value === null) return null
  if (!(ROBOT_MESSAGE_LOCALES as readonly string[]).includes(value)) {
    throw new RobotStoreError('locale_invalid', '不支持的机器人语言。')
  }
  return value
}

/** Map an `im_robots` row to the public robot model (write grants attached). */
export function toRobot(r: RobotRow): ImRobot {
  const base: ImRobot = {
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
    outboundAckHash: r.outbound_ack_hash ?? null,
    broadcastEventTypes: parseBroadcastTypes(r.broadcast_event_types ?? '[]'),
    broadcastToBoundUsers: (r.broadcast_to_bound_users ?? 0) === 1,
    broadcastGroupChatIds: parseList(r.broadcast_group_chat_ids ?? '[]'),
    locale: parseLocale(r.locale),
    configRevision: r.config_revision ?? 0,
    writeGrants: [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  return { ...base, writeGrants: listWriteGrantsForRobot(base) }
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
  locale?: RobotMessageLocale | null
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
  broadcastEventTypes?: ImBroadcastType[]
  broadcastToBoundUsers?: boolean
  broadcastGroupChatIds?: string[]
  locale?: RobotMessageLocale | null
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
  if (patch.broadcastEventTypes !== undefined) {
    set('broadcast_event_types', JSON.stringify(patch.broadcastEventTypes))
  }
  if (patch.broadcastToBoundUsers !== undefined) {
    set('broadcast_to_bound_users', patch.broadcastToBoundUsers ? 1 : 0)
  }
  if (patch.broadcastGroupChatIds !== undefined) {
    set('broadcast_group_chat_ids', JSON.stringify(patch.broadcastGroupChatIds))
  }
  if (patch.locale !== undefined) set('locale', assertLocale(patch.locale))

  if (sets.length > 0) {
    set('updated_at', now())
    set('config_revision', (existing.configRevision ?? 0) + 1)
    params.push(id)
    d.run(`UPDATE im_robots SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }
  const updated = getRobot(id)
  if (!updated) throw new RobotStoreError('not_found', '机器人不存在。')
  return updated
}

export function acknowledgeOutbound(id: string): ImRobot {
  const d = requireDb()
  const existing = getRobot(id)
  if (!existing) throw new RobotStoreError('not_found', '机器人不存在。')
  const t = now()
  const hash = computeOutboundConfigHash(existing)
  d.run(
    'UPDATE im_robots SET outbound_ack_at = ?, outbound_ack_hash = ?, updated_at = ? WHERE id = ?',
    t,
    hash,
    t,
    id,
  )
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
    if (robot.outboundAckAt === null || !outboundConfigAcknowledged(robot)) {
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
