/**
 * Unified outbound audit and broadcast idempotency claims.
 *
 * Separate from {@link im_robot_turns}: proactive broadcasts are not robot turns.
 * Audit rows carry metadata only — never message body, titles, or deep links.
 */
import { randomUUID } from 'node:crypto'
import type {
  ImBroadcastType,
  ImOutboundAuditLog,
  ImOutboundCategory,
  ImOutboundTargetKind,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

export type OutboundAuditInput = {
  robotId: string
  category: ImOutboundCategory
  sourceEventKind?: ImBroadcastType | null
  idempotencyKey?: string | null
  targetKind: ImOutboundTargetKind
  targetRef: string
  objectWorkspace?: string | null
  templateKey?: string | null
  result: ImOutboundAuditLog['result']
  refuseReason?: string | null
  outboundChars?: number
  platformMessageId?: string | null
}

const AUDIT_TABLE = `
CREATE TABLE IF NOT EXISTS im_outbound_audit (
  id                  TEXT PRIMARY KEY,
  robot_id            TEXT NOT NULL,
  category            TEXT NOT NULL,
  source_event_kind   TEXT,
  idempotency_key     TEXT,
  target_kind         TEXT NOT NULL,
  target_ref          TEXT NOT NULL,
  object_workspace    TEXT,
  template_key        TEXT,
  result              TEXT NOT NULL,
  refuse_reason       TEXT,
  outbound_chars      INTEGER NOT NULL DEFAULT 0,
  platform_message_id TEXT,
  at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_outbound_audit_robot ON im_outbound_audit(robot_id, at DESC);
`

const IDEMPOTENCY_TABLE = `
CREATE TABLE IF NOT EXISTS im_broadcast_claims (
  robot_id          TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  target_kind       TEXT NOT NULL,
  target_ref        TEXT NOT NULL,
  platform_message_id TEXT,
  claimed_at        INTEGER NOT NULL,
  PRIMARY KEY (robot_id, idempotency_key, target_kind, target_ref)
);
`

let schemaReady = false

export function ensureOutboundAuditSchema(): boolean {
  const d = getDb()
  if (!d) return false
  if (schemaReady) return true
  d.exec(AUDIT_TABLE)
  d.exec(IDEMPOTENCY_TABLE)
  schemaReady = true
  return true
}

export function resetOutboundAuditStoreForTests(): void {
  schemaReady = false
}

function requireDb(): Db {
  const d = getDb()
  if (!d || !ensureOutboundAuditSchema()) {
    throw new Error('outbound audit store unavailable')
  }
  return d
}

export function isOutboundAuditAvailable(): boolean {
  return isDbAvailable() && ensureOutboundAuditSchema()
}

/** Redact a platform id for audit — keep prefix only. */
export function redactTargetRef(ref: string): string {
  if (ref.length <= 8) return ref
  return `${ref.slice(0, 4)}…${ref.slice(-4)}`
}

export function appendOutboundAudit(input: OutboundAuditInput): string | null {
  if (!isOutboundAuditAvailable()) return null
  const d = requireDb()
  const id = randomUUID()
  const t = Date.now()
  d.run(
    `INSERT INTO im_outbound_audit
       (id, robot_id, category, source_event_kind, idempotency_key, target_kind,
        target_ref, object_workspace, template_key, result, refuse_reason,
        outbound_chars, platform_message_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.robotId,
    input.category,
    input.sourceEventKind ?? null,
    input.idempotencyKey ?? null,
    input.targetKind,
    redactTargetRef(input.targetRef),
    input.objectWorkspace ?? null,
    input.templateKey ?? null,
    input.result,
    input.refuseReason ?? null,
    input.outboundChars ?? 0,
    input.platformMessageId ?? null,
    t,
  )
  return id
}

export type IdempotencyClaimResult =
  | { ok: true; alreadySent: false }
  | { ok: true; alreadySent: true; messageId: string | null }
  | { ok: false; reason: 'unavailable' }

/**
 * Claim one robot/event/target triple before calling the provider.
 * Returns alreadySent when a prior attempt reached the platform.
 */
export function claimBroadcastDelivery(input: {
  robotId: string
  idempotencyKey: string
  targetKind: ImOutboundTargetKind
  targetRef: string
}): IdempotencyClaimResult {
  if (!isOutboundAuditAvailable()) return { ok: false, reason: 'unavailable' }
  const d = requireDb()
  const existing = d.get<{ platform_message_id: string | null }>(
    `SELECT platform_message_id FROM im_broadcast_claims
     WHERE robot_id=? AND idempotency_key=? AND target_kind=? AND target_ref=?`,
    input.robotId,
    input.idempotencyKey,
    input.targetKind,
    input.targetRef,
  )
  if (existing) {
    return { ok: true, alreadySent: true, messageId: existing.platform_message_id }
  }
  d.run(
    `INSERT INTO im_broadcast_claims
       (robot_id, idempotency_key, target_kind, target_ref, platform_message_id, claimed_at)
     VALUES (?,?,?,?,NULL,?)`,
    input.robotId,
    input.idempotencyKey,
    input.targetKind,
    input.targetRef,
    Date.now(),
  )
  return { ok: true, alreadySent: false }
}

/** Mark a claim as delivered once the provider confirms (or reports failure). */
export function finalizeBroadcastClaim(input: {
  robotId: string
  idempotencyKey: string
  targetKind: ImOutboundTargetKind
  targetRef: string
  platformMessageId: string | null
}): void {
  if (!isOutboundAuditAvailable()) return
  const d = requireDb()
  d.run(
    `UPDATE im_broadcast_claims SET platform_message_id=?
     WHERE robot_id=? AND idempotency_key=? AND target_kind=? AND target_ref=?`,
    input.platformMessageId,
    input.robotId,
    input.idempotencyKey,
    input.targetKind,
    input.targetRef,
  )
}

/** Release a claim that never reached the provider so the same event may retry. */
export function releaseBroadcastClaim(input: {
  robotId: string
  idempotencyKey: string
  targetKind: ImOutboundTargetKind
  targetRef: string
}): void {
  if (!isOutboundAuditAvailable()) return
  const d = requireDb()
  d.run(
    `DELETE FROM im_broadcast_claims
     WHERE robot_id=? AND idempotency_key=? AND target_kind=? AND target_ref=?
       AND platform_message_id IS NULL`,
    input.robotId,
    input.idempotencyKey,
    input.targetKind,
    input.targetRef,
  )
}

export function listOutboundAudit(robotId: string, limit = 50): ImOutboundAuditLog[] {
  if (!isOutboundAuditAvailable()) return []
  const d = requireDb()
  return d
    .all<{
      id: string
      robot_id: string
      category: string
      source_event_kind: string | null
      idempotency_key: string | null
      target_kind: string
      target_ref: string
      object_workspace: string | null
      template_key: string | null
      result: string
      refuse_reason: string | null
      outbound_chars: number
      platform_message_id: string | null
      at: number
    }>(`SELECT * FROM im_outbound_audit WHERE robot_id=? ORDER BY at DESC LIMIT ?`, robotId, limit)
    .map((r) => ({
      id: r.id,
      robotId: r.robot_id,
      category: r.category as ImOutboundCategory,
      sourceEventKind: r.source_event_kind as ImBroadcastType | null,
      idempotencyKey: r.idempotency_key,
      targetKind: r.target_kind as ImOutboundTargetKind,
      targetRef: r.target_ref,
      objectWorkspace: r.object_workspace,
      templateKey: r.template_key,
      result: r.result as ImOutboundAuditLog['result'],
      refuseReason: r.refuse_reason,
      outboundChars: r.outbound_chars,
      platformMessageId: r.platform_message_id,
      at: r.at,
    }))
}
