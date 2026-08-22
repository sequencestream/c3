/**
 * Per-capability L2 write grants for IM robots.
 */
import { randomUUID } from 'node:crypto'
import {
  ROBOT_WRITE_CAPABILITIES,
  ROBOT_WRITABLE_CAPABILITIES,
  type ImRobot,
  type ImRobotWriteGrant,
  type RobotWriteCapability,
  type RobotWriteGrantStatus,
  type RobotWritableCapability,
} from '@ccc/shared/protocol'
import {
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../../kernel/infra/db.js'
import { computeWriteConfigHash, writeGrantConfigAcknowledged } from './write-config-hash.js'
import { getRobot } from './robot-store.js'

export type WriteGrantStoreErrorCode =
  'db_unavailable' | 'not_found' | 'capability_invalid' | 'capability_not_grantable'

export class WriteGrantStoreError extends Error {
  constructor(
    readonly code: WriteGrantStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WriteGrantStoreError'
  }
}

const WRITE_GRANTS_MIGRATION = 'robots.write_grants.v1'
const WRITE_AUDITS_MIGRATION = 'robots.write_audits.v1'

let nowFn: () => number = () => Date.now()
let schemaReadyFor: Db | null = null
let schemaFailed = false

export function setWriteGrantStoreClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

export function resetWriteGrantStoreForTests(): void {
  schemaReadyFor = null
  schemaFailed = false
  nowFn = () => Date.now()
}

function now(): number {
  return nowFn()
}

const GRANTS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robot_write_grants (
  robot_id         TEXT NOT NULL,
  capability       TEXT NOT NULL
                   CHECK(capability IN ('queue_respond','automation_control','annotate','dev_start')),
  enabled          INTEGER NOT NULL DEFAULT 0,
  acknowledged_by  TEXT,
  write_ack_at     INTEGER,
  config_hash      TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (robot_id, capability),
  FOREIGN KEY (robot_id) REFERENCES im_robots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_grants_robot ON im_robot_write_grants(robot_id);`

const AUDITS_TABLE = `
CREATE TABLE IF NOT EXISTS im_robot_write_audits (
  id                   TEXT PRIMARY KEY,
  robot_id             TEXT NOT NULL,
  todo_id              TEXT,
  binding_subject      TEXT,
  sender_id_redacted   TEXT,
  actor_subject        TEXT,
  object_workspace     TEXT,
  capability           TEXT,
  answer_id            TEXT,
  result               TEXT NOT NULL,
  refuse_reason        TEXT,
  idempotency_key      TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_audits_robot ON im_robot_write_audits(robot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_audits_todo ON im_robot_write_audits(todo_id);`

interface GrantRow {
  robot_id: string
  capability: string
  enabled: number
  acknowledged_by: string | null
  write_ack_at: number | null
  config_hash: string | null
  updated_at: number
}

function isWritableCapability(cap: RobotWriteCapability): cap is RobotWritableCapability {
  return (ROBOT_WRITABLE_CAPABILITIES as readonly string[]).includes(cap)
}

function assertGrantable(cap: RobotWriteCapability): void {
  if (!isWritableCapability(cap)) {
    throw new WriteGrantStoreError('capability_not_grantable', '该能力当前不可通过 IM 授权。')
  }
  if (!(ROBOT_WRITE_CAPABILITIES as readonly string[]).includes(cap)) {
    throw new WriteGrantStoreError('capability_invalid', '未知写能力。')
  }
}

function grantStatus(robot: ImRobot, row: GrantRow | undefined): RobotWriteGrantStatus {
  if (!row || !row.enabled) return row ? 'disabled' : 'unauthorized'
  if (row.write_ack_at == null || row.config_hash == null) return 'unauthorized'
  if (!writeGrantConfigAcknowledged(robot, row.config_hash)) return 'stale'
  return 'active'
}

function toGrant(
  robot: ImRobot,
  row: GrantRow | undefined,
  cap: RobotWriteCapability,
): ImRobotWriteGrant {
  return {
    robotId: robot.id,
    capability: cap,
    status: grantStatus(robot, row),
    enabled: row?.enabled === 1,
    acknowledgedBy: row?.acknowledged_by ?? null,
    writeAckAt: row?.write_ack_at ?? null,
    configHash: row?.config_hash ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

function migrateWriteGrants(d: Db): void {
  if (hasMigration(d, WRITE_GRANTS_MIGRATION)) return
  d.exec(GRANTS_TABLE)
  markMigration(d, WRITE_GRANTS_MIGRATION)
}

function migrateWriteAudits(d: Db): void {
  if (hasMigration(d, WRITE_AUDITS_MIGRATION)) return
  d.exec(AUDITS_TABLE)
  markMigration(d, WRITE_AUDITS_MIGRATION)
}

function ensureSchema(d: Db): void {
  migrateWriteGrants(d)
  migrateWriteAudits(d)
}

function db(): Db | null {
  if (schemaFailed) return null
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
    } catch (err) {
      schemaFailed = true
      schemaReadyFor = null
      console.error('[c3][im] write grant schema failed:', err instanceof Error ? err.message : err)
      return null
    }
    schemaReadyFor = d
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new WriteGrantStoreError('db_unavailable', '写授权库不可用。')
  return d
}

export function isWriteGrantStoreAvailable(): boolean {
  return db() !== null
}

export function ensureWriteGrantSchema(): boolean {
  return db() !== null
}

function rowFor(d: Db, robotId: string, cap: RobotWriteCapability): GrantRow | undefined {
  return (
    d.get<GrantRow>(
      'SELECT * FROM im_robot_write_grants WHERE robot_id = ? AND capability = ?',
      robotId,
      cap,
    ) ?? undefined
  )
}

export function listWriteGrantsForRobot(robot: ImRobot): ImRobotWriteGrant[] {
  const d = db()
  if (!d) {
    return ROBOT_WRITE_CAPABILITIES.map((cap) => toGrant(robot, undefined, cap))
  }
  const rows = d.all<GrantRow>('SELECT * FROM im_robot_write_grants WHERE robot_id = ?', robot.id)
  const byCap = new Map(rows.map((r) => [r.capability, r]))
  return ROBOT_WRITE_CAPABILITIES.map((cap) => toGrant(robot, byCap.get(cap), cap))
}

export function isWriteGrantActive(robot: ImRobot, capability: RobotWritableCapability): boolean {
  const d = db()
  if (!d) return false
  const row = rowFor(d, robot.id, capability)
  return grantStatus(robot, row) === 'active'
}

export function acknowledgeWriteCapability(
  robotId: string,
  capability: RobotWriteCapability,
  confirmer: string,
): ImRobotWriteGrant[] {
  assertGrantable(capability)
  const d = requireDb()
  const robot = getRobot(robotId)
  if (!robot) throw new WriteGrantStoreError('not_found', '机器人不存在。')
  const t = now()
  const hash = computeWriteConfigHash(robot)
  const existing = rowFor(d, robotId, capability)
  if (existing) {
    d.run(
      `UPDATE im_robot_write_grants
         SET enabled = 1, acknowledged_by = ?, write_ack_at = ?, config_hash = ?, updated_at = ?
       WHERE robot_id = ? AND capability = ?`,
      confirmer,
      t,
      hash,
      t,
      robotId,
      capability,
    )
  } else {
    d.run(
      `INSERT INTO im_robot_write_grants
         (robot_id, capability, enabled, acknowledged_by, write_ack_at, config_hash, updated_at)
       VALUES (?,?,1,?,?,?,?)`,
      robotId,
      capability,
      confirmer,
      t,
      hash,
      t,
    )
  }
  const updated = getRobot(robotId)
  if (!updated) throw new WriteGrantStoreError('not_found', '机器人不存在。')
  return listWriteGrantsForRobot(updated)
}

export function setWriteGrantEnabled(
  robotId: string,
  capability: RobotWriteCapability,
  enabled: boolean,
): ImRobotWriteGrant[] {
  if (!(ROBOT_WRITE_CAPABILITIES as readonly string[]).includes(capability)) {
    throw new WriteGrantStoreError('capability_invalid', '未知写能力。')
  }
  if (enabled) assertGrantable(capability)
  const d = requireDb()
  const robot = getRobot(robotId)
  if (!robot) throw new WriteGrantStoreError('not_found', '机器人不存在。')
  const t = now()
  const existing = rowFor(d, robotId, capability)
  if (existing) {
    d.run(
      'UPDATE im_robot_write_grants SET enabled = ?, updated_at = ? WHERE robot_id = ? AND capability = ?',
      enabled ? 1 : 0,
      t,
      robotId,
      capability,
    )
  } else if (enabled) {
    throw new WriteGrantStoreError('capability_invalid', '启用前需要先确认该能力。')
  }
  const updated = getRobot(robotId)
  if (!updated) throw new WriteGrantStoreError('not_found', '机器人不存在。')
  return listWriteGrantsForRobot(updated)
}

export function appendWriteAudit(input: {
  robotId: string
  todoId?: string | null
  bindingSubject?: string | null
  senderIdRedacted?: string | null
  actorSubject?: string | null
  objectWorkspace?: string | null
  capability?: string | null
  answerId?: string | null
  result: string
  refuseReason?: string | null
  idempotencyKey?: string | null
}): void {
  const d = db()
  if (!d) return
  d.run(
    `INSERT INTO im_robot_write_audits
       (id, robot_id, todo_id, binding_subject, sender_id_redacted, actor_subject,
        object_workspace, capability, answer_id, result, refuse_reason, idempotency_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    input.robotId,
    input.todoId ?? null,
    input.bindingSubject ?? null,
    input.senderIdRedacted ?? null,
    input.actorSubject ?? null,
    input.objectWorkspace ?? null,
    input.capability ?? null,
    input.answerId ?? null,
    input.result,
    input.refuseReason ?? null,
    input.idempotencyKey ?? null,
    now(),
  )
}
