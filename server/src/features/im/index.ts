/**
 * IM chat-robot handlers.
 *
 * Every write here is administrator-only. That is not the usual "settings are
 * admin" reflex: creating, configuring or enabling a robot decides what leaves
 * this machine for a third-party cloud, which ADR-0046 makes an authorization
 * decision rather than a personal preference.
 *
 * The roster broadcast carries no workspace filter. Robots are a deployment-
 * level management surface — one list for the whole instance — which is not
 * the same as unbounded data access.
 */
import type { ImRobot } from '@ccc/shared/protocol'
import type { UiErrorCode } from '@ccc/shared/ui-codes'
import type { Conn, Handler } from '../../transport/index.js'
import { requireAdmin } from '../auth/authz.js'
import {
  RobotStoreError,
  acknowledgeOutbound,
  createRobot,
  deleteRobot,
  isStoreAvailable,
  listRobots,
  listTurns,
  setRobotEnabled,
  updateRobot,
} from './robot-store.js'
import {
  IdentityStoreError,
  adminRevokeBinding,
  cancelChallenge,
  createChallenge,
  buildMyImIdentityView,
  listActiveBindings,
  listGroupWorkspaceScopes,
  revokeMyBinding,
  setGroupWorkspaceScopes,
  isIdentityStoreAvailable,
} from './identity-store.js'
import { reloadRobot, robotConnectionStatus } from './supervisor.js'
import {
  WriteGrantStoreError,
  acknowledgeWriteCapability,
  setWriteGrantEnabled,
  isWriteGrantStoreAvailable,
} from './write-grant-store.js'

/** Map a store refusal onto the wire error vocabulary. */
const ERROR_CODES: Record<RobotStoreError['code'], UiErrorCode> = {
  db_unavailable: 'robot.dbUnavailable',
  not_found: 'robot.notFound',
  name_invalid: 'robot.nameInvalid',
  name_conflict: 'robot.nameConflict',
  platform_unsupported: 'robot.platformUnsupported',
  secret_required: 'robot.secretRequired',
  outbound_not_acknowledged: 'robot.outboundNotAcknowledged',
  locale_invalid: 'robot.localeInvalid',
}

const IDENTITY_ERROR_CODES: Record<IdentityStoreError['code'], UiErrorCode> = {
  db_unavailable: 'robot.identityUnavailable',
  robot_not_ready: 'robot.robotNotReady',
  not_found: 'robot.challengeNotFound',
  not_owner: 'robot.notOwner',
  conflict: 'robot.bindingNotFound',
  rate_limited: 'robot.identityUnavailable',
  invalid: 'robot.identityUnavailable',
}

/**
 * Run a store call, turning a refusal into a wire error. Anything else rethrows:
 * an unexpected failure must not be reported as a tidy domain refusal.
 */
function guarded(conn: Conn, run: () => void): void {
  try {
    run()
  } catch (err) {
    if (err instanceof RobotStoreError) {
      conn.send({ type: 'error', error: { code: ERROR_CODES[err.code] } })
      return
    }
    throw err
  }
}

const WRITE_GRANT_ERROR_CODES: Record<WriteGrantStoreError['code'], UiErrorCode> = {
  db_unavailable: 'robot.dbUnavailable',
  not_found: 'robot.notFound',
  capability_invalid: 'robot.writeCapabilityInvalid',
  capability_not_grantable: 'robot.writeCapabilityNotGrantable',
}

function guardedWriteGrant(conn: Conn, run: () => void): void {
  try {
    run()
  } catch (err) {
    if (err instanceof WriteGrantStoreError) {
      conn.send({ type: 'error', error: { code: WRITE_GRANT_ERROR_CODES[err.code] } })
      return
    }
    throw err
  }
}

/** Attach live connection state and return the roster snapshot. */
function withConnections(robots: ImRobot[]): ImRobot[] {
  return robots.map((r) => {
    const connection = robotConnectionStatus(r.id)
    return connection ? { ...r, connection } : r
  })
}

function sendRoster(conn: Conn): void {
  conn.send({ type: 'robots', robots: withConnections(listRobots()) })
}

export const listRobotsHandler: Handler<'list_robots'> = (_ctx, conn) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.dbUnavailable' } })
    return
  }
  sendRoster(conn)
}

export const createRobotHandler: Handler<'create_robot'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const cfg = msg.config
  if (!cfg.vendor || !cfg.agentId) {
    conn.send({ type: 'error', error: { code: 'robot.agentRequired' } })
    return
  }
  guarded(conn, () => {
    createRobot({
      name: msg.name,
      platform: msg.platform,
      appId: cfg.appId ?? '',
      appSecret: cfg.appSecret ?? '',
      vendor: cfg.vendor!,
      agentId: cfg.agentId!,
      ...(cfg.mode !== undefined ? { mode: cfg.mode } : {}),
      ...(cfg.toolAllowlist !== undefined ? { toolAllowlist: cfg.toolAllowlist } : {}),
      ...(cfg.requireMention !== undefined ? { requireMention: cfg.requireMention } : {}),
      ...(cfg.chatAllowlist !== undefined ? { chatAllowlist: cfg.chatAllowlist } : {}),
      ...(cfg.dmMode !== undefined ? { dmMode: cfg.dmMode } : {}),
      ...(cfg.dmAllowlist !== undefined ? { dmAllowlist: cfg.dmAllowlist } : {}),
      ...(cfg.maxTurnMs !== undefined ? { maxTurnMs: cfg.maxTurnMs } : {}),
    })
    sendRoster(conn)
  })
}

export const updateRobotHandler: Handler<'update_robot'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  guarded(conn, () => {
    updateRobot(msg.robotId, msg.config)
    sendRoster(conn)
  })
  // Re-dial with the new configuration; a disabled robot simply drops its link.
  void reloadRobot(msg.robotId).then(() => sendRoster(conn))
}

export const deleteRobotHandler: Handler<'delete_robot'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  guarded(conn, () => {
    deleteRobot(msg.robotId)
    sendRoster(conn)
  })
  void reloadRobot(msg.robotId)
}

export const acknowledgeRobotOutboundHandler: Handler<'acknowledge_robot_outbound'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  guarded(conn, () => {
    acknowledgeOutbound(msg.robotId)
    sendRoster(conn)
  })
}

export const setRobotEnabledHandler: Handler<'set_robot_enabled'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  guarded(conn, () => {
    // Refuses without a credential and a recorded acknowledgement — the check is
    // here, not only in the console, so skipping the dialog cannot enable a robot.
    setRobotEnabled(msg.robotId, msg.enabled)
    sendRoster(conn)
  })
  void reloadRobot(msg.robotId).then(() => sendRoster(conn))
}

export const listRobotTurnsHandler: Handler<'list_robot_turns'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  conn.send({ type: 'robot_turns', robotId: msg.robotId, turns: listTurns(msg.robotId) })
}

function identityGuarded(conn: Conn, run: () => void): void {
  try {
    run()
  } catch (err) {
    if (err instanceof IdentityStoreError) {
      conn.send({ type: 'error', error: { code: IDENTITY_ERROR_CODES[err.code] } })
      return
    }
    throw err
  }
}

export const getMyImIdentityHandler: Handler<'get_my_im_identity'> = (_ctx, conn) => {
  if (!isIdentityStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.identityUnavailable' } })
    return
  }
  conn.send({ type: 'my_im_identity', ...buildMyImIdentityView(conn.subject) })
}

export const createImIdentityChallengeHandler: Handler<'create_im_identity_challenge'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!isIdentityStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.identityUnavailable' } })
    return
  }
  identityGuarded(conn, () => {
    const challenge = createChallenge(conn.subject, msg.robotId)
    conn.send({ type: 'im_identity_challenge_created', challenge })
    conn.send({ type: 'my_im_identity', ...buildMyImIdentityView(conn.subject) })
  })
}

export const cancelImIdentityChallengeHandler: Handler<'cancel_im_identity_challenge'> = (
  _ctx,
  conn,
  msg,
) => {
  identityGuarded(conn, () => {
    cancelChallenge(conn.subject, msg.challengeId)
    conn.send({ type: 'my_im_identity', ...buildMyImIdentityView(conn.subject) })
  })
}

export const revokeMyImIdentityHandler: Handler<'revoke_my_im_identity'> = (_ctx, conn, msg) => {
  identityGuarded(conn, () => {
    revokeMyBinding(conn.subject, msg.bindingId)
    conn.send({ type: 'my_im_identity', ...buildMyImIdentityView(conn.subject) })
  })
}

export const adminRevokeImIdentityHandler: Handler<'admin_revoke_im_identity'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  identityGuarded(conn, () => {
    adminRevokeBinding(conn.subject, msg.bindingId, msg.reason)
    conn.send({ type: 'im_identity_bindings', bindings: listActiveBindings() })
  })
}

export const listImIdentityBindingsHandler: Handler<'list_im_identity_bindings'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  if (!isIdentityStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.identityUnavailable' } })
    return
  }
  conn.send({
    type: 'im_identity_bindings',
    bindings: listActiveBindings(msg.accountNamespace),
  })
}

export const listImGroupWorkspaceScopesHandler: Handler<'list_im_group_workspace_scopes'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  conn.send({
    type: 'im_group_workspace_scopes',
    platform: msg.platform,
    providerAccountKey: msg.providerAccountKey,
    chatId: msg.chatId,
    grants: listGroupWorkspaceScopes(msg.platform, msg.providerAccountKey, msg.chatId),
  })
}

export const setImGroupWorkspaceScopesHandler: Handler<'set_im_group_workspace_scopes'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  identityGuarded(conn, () => {
    const grants = setGroupWorkspaceScopes(
      conn.subject,
      msg.platform,
      msg.providerAccountKey,
      msg.chatId,
      msg.workspaceNames,
    )
    conn.send({
      type: 'im_group_workspace_scopes',
      platform: msg.platform,
      providerAccountKey: msg.providerAccountKey,
      chatId: msg.chatId,
      grants,
    })
  })
}

export const acknowledgeRobotWriteCapabilityHandler: Handler<
  'acknowledge_robot_write_capability'
> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  if (!isStoreAvailable() || !isWriteGrantStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.dbUnavailable' } })
    return
  }
  guardedWriteGrant(conn, () => {
    acknowledgeWriteCapability(msg.robotId, msg.capability, conn.subject ?? 'admin')
    sendRoster(conn)
  })
}

export const setRobotWriteGrantEnabledHandler: Handler<'set_robot_write_grant_enabled'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  if (!isStoreAvailable() || !isWriteGrantStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'robot.dbUnavailable' } })
    return
  }
  guardedWriteGrant(conn, () => {
    setWriteGrantEnabled(msg.robotId, msg.capability, msg.enabled)
    sendRoster(conn)
  })
}
