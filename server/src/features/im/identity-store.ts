/**
 * IM identity binding: one-shot challenges, active bindings, group workspace
 * visibility, and append-only auth audit.
 *
 * Binding maps a platform account-namespace sender to a c3 AuthorizationSubject.
 * It never grants workspace access by itself — callers still intersect with
 * `user_workspace_scopes` and group whitelists on every tool call.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  ImChallengeStatus,
  ImGroupWorkspaceGrant,
  ImIdentityBinding,
  ImIdentityChallengeCreated,
  ImIdentityChallengeSummary,
  ImPlatform,
} from '@ccc/shared/protocol'
import { resolveAuthSubject, LOCAL_SUBJECT } from '../auth/authorization.js'
import { configuredAdmin } from '../auth/authz.js'
import { normalizeSubject } from '../auth/scope-store.js'
import { loadSettings } from '../../kernel/config/index.js'
import { configTx } from '../../kernel/config/config-store.js'
import { bumpPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { execIdentitySchema } from './identity-schema.js'
import { getRobot } from './robot-store.js'

export { execIdentitySchema, identityTablesPresent } from './identity-schema.js'

export type IdentityStoreErrorCode =
  | 'db_unavailable'
  | 'robot_not_ready'
  | 'not_found'
  | 'not_owner'
  | 'conflict'
  | 'rate_limited'
  | 'invalid'

export class IdentityStoreError extends Error {
  constructor(
    readonly code: IdentityStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityStoreError'
  }
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000
const TOKEN_BYTES = 16 // 128-bit
const FAIL_WINDOW_MS = 60_000
const FAIL_MAX = 10

let nowFn: () => number = () => Date.now()
const failBuckets = new Map<string, number[]>()

export function setIdentityStoreClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

export function resetIdentityStoreForTests(): void {
  schemaReadyFor = null
  failBuckets.clear()
  nowFn = () => Date.now()
}

/** Test-only: insert an active binding (multi-sender supervisor scenarios). */
export function seedBindingForTests(input: {
  accountNamespace: string
  senderId: string
  subject: string
}): ImIdentityBinding {
  return configTx((d) => {
    ensureSchema(d)
    const bindingId = randomUUID()
    const t = now()
    d.run(
      `INSERT INTO im_identity_bindings
         (id, account_namespace, sender_id, subject, verified_at,
          revoked_at, revoked_by, revoke_reason)
       VALUES (?,?,?,?,?,NULL,NULL,NULL)`,
      bindingId,
      input.accountNamespace,
      input.senderId,
      input.subject,
      t,
    )
    bumpPolicyEpoch()
    return toBinding({
      id: bindingId,
      account_namespace: input.accountNamespace,
      sender_id: input.senderId,
      subject: input.subject,
      verified_at: t,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
    })
  })
}

function now(): number {
  return nowFn()
}

/** Feishu (and future providers): stable account namespace = platform + app id. */
export function accountNamespaceOf(platform: ImPlatform, appId: string): string {
  return `${platform}:${appId.trim()}`
}

export function providerAccountKeyOf(platform: ImPlatform, appId: string): string {
  void platform
  return appId.trim()
}

export function parseAccountNamespace(
  ns: string,
): { platform: ImPlatform; providerAccountKey: string } | null {
  const i = ns.indexOf(':')
  if (i <= 0) return null
  const platform = ns.slice(0, i)
  const key = ns.slice(i + 1).trim()
  if (platform !== 'feishu' || !key) return null
  return { platform, providerAccountKey: key }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Stable audit digest of an external sender id — not reversible to the id. */
export function senderDigest(senderId: string): string {
  return createHash('sha256').update(senderId, 'utf8').digest('hex').slice(0, 16)
}

let schemaReadyFor: Db | null = null

function ensureSchema(d: Db): void {
  execIdentitySchema(d)
}

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
      schemaReadyFor = d
    } catch (err) {
      schemaReadyFor = null
      console.error('[c3][im] identity schema failed:', err instanceof Error ? err.message : err)
      return null
    }
  }
  return d
}

export function ensureIdentitySchema(): boolean {
  return db() !== null
}

export function isIdentityStoreAvailable(): boolean {
  return db() !== null
}

function writeAudit(
  d: Db,
  row: {
    eventType: string
    subject?: string | null
    accountNamespace?: string | null
    senderId?: string | null
    robotId?: string | null
    chatId?: string | null
    bindingId?: string | null
    reasonCode?: string | null
    actor?: string | null
  },
): void {
  d.run(
    `INSERT INTO im_identity_audit
       (id, event_type, subject, account_namespace, sender_digest, robot_id,
        chat_id, binding_id, reason_code, actor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    row.eventType,
    row.subject ?? null,
    row.accountNamespace ?? null,
    row.senderId ? senderDigest(row.senderId) : null,
    row.robotId ?? null,
    row.chatId ?? null,
    row.bindingId ?? null,
    row.reasonCode ?? null,
    row.actor ?? null,
    now(),
  )
}

function expirePending(d: Db, t: number): void {
  d.run(
    `UPDATE im_identity_challenges
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?`,
    t,
  )
}

interface ChallengeRow {
  id: string
  account_namespace: string
  subject: string
  robot_id: string
  token_hash: string
  status: string
  created_at: number
  expires_at: number
  consumed_at: number | null
  cancelled_at: number | null
}

interface BindingRow {
  id: string
  account_namespace: string
  sender_id: string
  subject: string
  verified_at: number
  revoked_at: number | null
  revoked_by: string | null
  revoke_reason: string | null
}

function toBinding(r: BindingRow): ImIdentityBinding {
  const parsed = parseAccountNamespace(r.account_namespace)
  return {
    id: r.id,
    accountNamespace: r.account_namespace,
    platform: parsed?.platform ?? 'feishu',
    senderId: r.sender_id,
    subject: r.subject,
    verifiedAt: r.verified_at,
    revokedAt: r.revoked_at,
  }
}

function toChallengeSummary(r: ChallengeRow): ImIdentityChallengeSummary {
  return {
    challengeId: r.id,
    accountNamespace: r.account_namespace,
    robotId: r.robot_id,
    status: r.status as ImChallengeStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
}

/** Whether this deployment has no admin gate (trusted-local). */
export function isNoAuthDeployment(): boolean {
  return configuredAdmin(loadSettings().auth) === null
}

export function getActiveBindingForSender(
  accountNamespace: string,
  senderId: string,
): ImIdentityBinding | null {
  const d = db()
  if (!d) return null
  const row = d.get<BindingRow>(
    `SELECT * FROM im_identity_bindings
     WHERE account_namespace = ? AND sender_id = ? AND revoked_at IS NULL`,
    accountNamespace,
    senderId,
  )
  return row ? toBinding(row) : null
}

export function getActiveBindingById(bindingId: string): ImIdentityBinding | null {
  const d = db()
  if (!d) return null
  const row = d.get<BindingRow>(
    `SELECT * FROM im_identity_bindings WHERE id = ? AND revoked_at IS NULL`,
    bindingId,
  )
  return row ? toBinding(row) : null
}

export function getMyActiveBinding(rawSubject: string | null): ImIdentityBinding | null {
  return listMyActiveBindings(rawSubject)[0] ?? null
}

export function listMyActiveBindings(rawSubject: string | null): ImIdentityBinding[] {
  const subject = resolveAuthSubject(rawSubject)
  if (!subject) return []
  const d = db()
  if (!d) return []
  const rows = d.all<BindingRow>(
    `SELECT * FROM im_identity_bindings
     WHERE subject = ? AND revoked_at IS NULL
     ORDER BY verified_at DESC`,
    subject,
  )
  return rows.map(toBinding)
}

export function getMyPendingChallenge(
  rawSubject: string | null,
): ImIdentityChallengeSummary | null {
  return listMyPendingChallenges(rawSubject)[0] ?? null
}

export function listMyPendingChallenges(rawSubject: string | null): ImIdentityChallengeSummary[] {
  const subject = resolveAuthSubject(rawSubject)
  if (!subject) return []
  const d = db()
  if (!d) return []
  const t = now()
  expirePending(d, t)
  const rows = d.all<ChallengeRow>(
    `SELECT * FROM im_identity_challenges
     WHERE subject = ? AND status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC`,
    subject,
    t,
  )
  return rows.map(toChallengeSummary)
}

export function buildMyImIdentityView(rawSubject: string | null): {
  bindings: ImIdentityBinding[]
  pendingChallenges: ImIdentityChallengeSummary[]
  noAuthLocalHint: boolean
} {
  return {
    bindings: listMyActiveBindings(rawSubject),
    pendingChallenges: listMyPendingChallenges(rawSubject),
    noAuthLocalHint: isNoAuthDeployment(),
  }
}

export function createChallenge(
  rawSubject: string | null,
  robotId: string,
): ImIdentityChallengeCreated {
  const subject = resolveAuthSubject(rawSubject)
  if (!subject) throw new IdentityStoreError('invalid', 'no subject')
  const robot = getRobot(robotId)
  if (!robot || !robot.enabled || robot.outboundAckAt == null) {
    throw new IdentityStoreError('robot_not_ready', 'robot not ready for binding')
  }
  const ns = accountNamespaceOf(robot.platform, robot.appId)
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const tokenHash = hashToken(token)
  const t = now()
  const expiresAt = t + CHALLENGE_TTL_MS
  const challengeId = randomUUID()

  return configTx((d) => {
    ensureSchema(d)
    expirePending(d, t)
    d.run(
      `UPDATE im_identity_challenges
         SET status = 'cancelled', cancelled_at = ?
       WHERE subject = ? AND account_namespace = ? AND status = 'pending'`,
      t,
      subject,
      ns,
    )
    d.run(
      `INSERT INTO im_identity_challenges
         (id, account_namespace, subject, robot_id, token_hash, status,
          created_at, expires_at, consumed_at, cancelled_at)
       VALUES (?,?,?,?,?,'pending',?,?,NULL,NULL)`,
      challengeId,
      ns,
      subject,
      robotId,
      tokenHash,
      t,
      expiresAt,
    )
    writeAudit(d, {
      eventType: 'challenge_created',
      subject,
      accountNamespace: ns,
      robotId,
      actor: subject,
    })
    return {
      challengeId,
      accountNamespace: ns,
      robotId,
      token,
      expiresAt,
    }
  })
}

export function cancelChallenge(rawSubject: string | null, challengeId: string): void {
  const subject = resolveAuthSubject(rawSubject)
  if (!subject) throw new IdentityStoreError('invalid', 'no subject')
  configTx((d) => {
    ensureSchema(d)
    const row = d.get<ChallengeRow>(
      `SELECT * FROM im_identity_challenges WHERE id = ?`,
      challengeId,
    )
    if (!row || row.subject !== subject)
      throw new IdentityStoreError('not_found', 'challenge not found')
    if (row.status !== 'pending') throw new IdentityStoreError('not_found', 'challenge not pending')
    const t = now()
    d.run(
      `UPDATE im_identity_challenges
         SET status = 'cancelled', cancelled_at = ?
       WHERE id = ?`,
      t,
      challengeId,
    )
    writeAudit(d, {
      eventType: 'challenge_cancelled',
      subject,
      accountNamespace: row.account_namespace,
      robotId: row.robot_id,
      actor: subject,
    })
  })
}

function failKey(robotId: string, senderId: string): string {
  return `${robotId}::${senderId}`
}

function checkRateLimit(robotId: string, senderId: string): boolean {
  const key = failKey(robotId, senderId)
  const t = now()
  const window = (failBuckets.get(key) ?? []).filter((x) => t - x < FAIL_WINDOW_MS)
  failBuckets.set(key, window)
  return window.length < FAIL_MAX
}

function recordFail(robotId: string, senderId: string): void {
  const key = failKey(robotId, senderId)
  const window = failBuckets.get(key) ?? []
  window.push(now())
  failBuckets.set(key, window)
}

export type ConsumeChallengeResult =
  { ok: true; binding: ImIdentityBinding } | { ok: false; reason: 'failed' | 'rate_limited' }

/**
 * Consume a DM token. Group callers must not reach here. All failure modes
 * collapse to the same result — no oracle on which check failed.
 */
export function consumeChallenge(input: {
  robotId: string
  accountNamespace: string
  senderId: string
  token: string
}): ConsumeChallengeResult {
  if (!checkRateLimit(input.robotId, input.senderId)) {
    const d = db()
    if (d) {
      try {
        configTx((txDb) => {
          ensureSchema(txDb)
          writeAudit(txDb, {
            eventType: 'challenge_consume_failed',
            accountNamespace: input.accountNamespace,
            senderId: input.senderId,
            robotId: input.robotId,
            reasonCode: 'rate_limited',
          })
        })
      } catch {
        /* audit failure must not change the collapsed consume result */
      }
    }
    return { ok: false, reason: 'rate_limited' }
  }
  const d = db()
  if (!d) {
    recordFail(input.robotId, input.senderId)
    return { ok: false, reason: 'failed' }
  }
  const tokenHash = hashToken(input.token.trim())
  const t = now()

  try {
    const result = configTx((txDb): ConsumeChallengeResult => {
      ensureSchema(txDb)
      expirePending(txDb, t)
      const row = txDb.get<ChallengeRow>(
        `SELECT * FROM im_identity_challenges
         WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`,
        tokenHash,
        t,
      )
      if (
        !row ||
        row.account_namespace !== input.accountNamespace ||
        row.robot_id !== input.robotId
      ) {
        writeAudit(txDb, {
          eventType: 'challenge_consume_failed',
          accountNamespace: input.accountNamespace,
          senderId: input.senderId,
          robotId: input.robotId,
          reasonCode: 'invalid_or_mismatch',
        })
        return { ok: false, reason: 'failed' }
      }

      const senderConflict = txDb.get<{ id: string }>(
        `SELECT id FROM im_identity_bindings
         WHERE account_namespace = ? AND sender_id = ? AND revoked_at IS NULL`,
        input.accountNamespace,
        input.senderId,
      )
      const subjectConflict = txDb.get<{ id: string }>(
        `SELECT id FROM im_identity_bindings
         WHERE account_namespace = ? AND subject = ? AND revoked_at IS NULL`,
        input.accountNamespace,
        row.subject,
      )
      if (senderConflict || subjectConflict) {
        writeAudit(txDb, {
          eventType: 'challenge_consume_failed',
          subject: row.subject,
          accountNamespace: input.accountNamespace,
          senderId: input.senderId,
          robotId: input.robotId,
          reasonCode: 'uniqueness_conflict',
        })
        return { ok: false, reason: 'failed' }
      }

      const bindingId = randomUUID()
      txDb.run(
        `UPDATE im_identity_challenges
           SET status = 'consumed', consumed_at = ?
         WHERE id = ?`,
        t,
        row.id,
      )
      txDb.run(
        `INSERT INTO im_identity_bindings
           (id, account_namespace, sender_id, subject, verified_at,
            revoked_at, revoked_by, revoke_reason)
         VALUES (?,?,?,?,?,NULL,NULL,NULL)`,
        bindingId,
        input.accountNamespace,
        input.senderId,
        row.subject,
        t,
      )
      bumpPolicyEpoch()
      writeAudit(txDb, {
        eventType: 'binding_verified',
        subject: row.subject,
        accountNamespace: input.accountNamespace,
        senderId: input.senderId,
        robotId: input.robotId,
        bindingId,
        actor: row.subject,
      })
      return {
        ok: true,
        binding: toBinding({
          id: bindingId,
          account_namespace: input.accountNamespace,
          sender_id: input.senderId,
          subject: row.subject,
          verified_at: t,
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
        }),
      }
    })
    if (!result.ok) recordFail(input.robotId, input.senderId)
    return result
  } catch {
    recordFail(input.robotId, input.senderId)
    return { ok: false, reason: 'failed' }
  }
}

function revokeBindingRow(
  d: Db,
  bindingId: string,
  actor: string,
  reason: string,
  requireSubject: string | null,
): ImIdentityBinding {
  const row = d.get<BindingRow>(
    `SELECT * FROM im_identity_bindings WHERE id = ? AND revoked_at IS NULL`,
    bindingId,
  )
  if (!row) throw new IdentityStoreError('not_found', 'binding not found')
  if (requireSubject && row.subject !== requireSubject) {
    throw new IdentityStoreError('not_owner', 'not your binding')
  }
  const t = now()
  d.run(
    `UPDATE im_identity_bindings
       SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
     WHERE id = ?`,
    t,
    actor,
    reason,
    bindingId,
  )
  bumpPolicyEpoch()
  writeAudit(d, {
    eventType: 'binding_revoked',
    subject: row.subject,
    accountNamespace: row.account_namespace,
    senderId: row.sender_id,
    bindingId,
    reasonCode: reason,
    actor,
  })
  return toBinding({ ...row, revoked_at: t, revoked_by: actor, revoke_reason: reason })
}

export function revokeMyBinding(rawSubject: string | null, bindingId: string): void {
  const subject = resolveAuthSubject(rawSubject)
  if (!subject) throw new IdentityStoreError('invalid', 'no subject')
  configTx((d) => {
    ensureSchema(d)
    revokeBindingRow(d, bindingId, subject, 'user_revoke', subject)
  })
}

export function adminRevokeBinding(
  rawAdmin: string | null,
  bindingId: string,
  reason?: string,
): void {
  const admin = resolveAuthSubject(rawAdmin)
  if (!admin) throw new IdentityStoreError('invalid', 'no subject')
  // Caller must already have checked requireAdmin; we still record the actor.
  configTx((d) => {
    ensureSchema(d)
    revokeBindingRow(d, bindingId, admin, reason?.trim() || 'admin_revoke', null)
  })
}

export function listActiveBindings(accountNamespace?: string): ImIdentityBinding[] {
  const d = db()
  if (!d) return []
  if (accountNamespace) {
    return d
      .all<BindingRow>(
        `SELECT * FROM im_identity_bindings
         WHERE revoked_at IS NULL AND account_namespace = ?
         ORDER BY verified_at DESC`,
        accountNamespace,
      )
      .map(toBinding)
  }
  return d
    .all<BindingRow>(
      `SELECT * FROM im_identity_bindings WHERE revoked_at IS NULL ORDER BY verified_at DESC`,
    )
    .map(toBinding)
}

export function listGroupWorkspaceScopes(
  platform: ImPlatform,
  providerAccountKey: string,
  chatId: string,
): ImGroupWorkspaceGrant[] {
  const d = db()
  if (!d) return []
  return d
    .all<{
      platform: string
      provider_account_key: string
      chat_id: string
      workspace_name: string
      granted_by: string
      granted_at: number
    }>(
      `SELECT * FROM im_group_workspace_scopes
       WHERE platform = ? AND provider_account_key = ? AND chat_id = ?
       ORDER BY workspace_name ASC`,
      platform,
      providerAccountKey,
      chatId,
    )
    .map((r) => ({
      platform: r.platform as ImPlatform,
      providerAccountKey: r.provider_account_key,
      chatId: r.chat_id,
      workspaceName: r.workspace_name,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }))
}

/** Whole-set replace of a group's workspace whitelist; bumps policy epoch. */
export function setGroupWorkspaceScopes(
  rawAdmin: string | null,
  platform: ImPlatform,
  providerAccountKey: string,
  chatId: string,
  workspaceNames: readonly string[],
): ImGroupWorkspaceGrant[] {
  const actor = resolveAuthSubject(rawAdmin)
  if (!actor) throw new IdentityStoreError('invalid', 'no subject')
  const names = [...new Set(workspaceNames.map((w) => w.trim()).filter(Boolean))].sort()
  const t = now()
  return configTx((d) => {
    ensureSchema(d)
    d.run(
      `DELETE FROM im_group_workspace_scopes
       WHERE platform = ? AND provider_account_key = ? AND chat_id = ?`,
      platform,
      providerAccountKey,
      chatId,
    )
    const grants: ImGroupWorkspaceGrant[] = []
    for (const name of names) {
      d.run(
        `INSERT INTO im_group_workspace_scopes
           (platform, provider_account_key, chat_id, workspace_name, granted_by, granted_at)
         VALUES (?,?,?,?,?,?)`,
        platform,
        providerAccountKey,
        chatId,
        name,
        actor,
        t,
      )
      grants.push({
        platform,
        providerAccountKey,
        chatId,
        workspaceName: name,
        grantedBy: actor,
        grantedAt: t,
      })
    }
    bumpPolicyEpoch()
    writeAudit(d, {
      eventType: 'group_scope_replaced',
      accountNamespace: accountNamespaceOf(platform, providerAccountKey),
      chatId,
      actor,
      reasonCode: `count=${names.length}`,
    })
    return grants
  })
}

export function groupWorkspaceNames(
  platform: ImPlatform,
  providerAccountKey: string,
  chatId: string,
): string[] {
  return listGroupWorkspaceScopes(platform, providerAccountKey, chatId).map((g) => g.workspaceName)
}

/** Identity audit rows — used by tests to assert failed consumes persist. */
export function listIdentityAudit(): { eventType: string; reasonCode: string | null }[] {
  const d = db()
  if (!d) return []
  return d
    .all<{ event_type: string; reason_code: string | null }>(
      `SELECT event_type, reason_code FROM im_identity_audit ORDER BY created_at ASC`,
    )
    .map((r) => ({ eventType: r.event_type, reasonCode: r.reason_code }))
}

/** Subject used for no-auth local bindings — exported for tests/docs. */
export { LOCAL_SUBJECT, normalizeSubject }
