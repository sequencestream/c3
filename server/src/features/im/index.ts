/**
 * IM chat-robot handlers.
 *
 * Every write here is administrator-only. That is not the usual "settings are
 * admin" reflex: creating, configuring or enabling a robot decides what leaves
 * this machine for a third-party cloud, which ADR-0046 makes an authorization
 * decision rather than a personal preference.
 *
 * The roster broadcast carries no workspace. Robots are global — they are the
 * one domain here deliberately not scoped to one — so every connected console
 * sees the same list.
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
import { reloadRobot, robotConnectionStatus } from './supervisor.js'

/** Map a store refusal onto the wire error vocabulary. */
const ERROR_CODES: Record<RobotStoreError['code'], UiErrorCode> = {
  db_unavailable: 'robot.dbUnavailable',
  not_found: 'robot.notFound',
  name_invalid: 'robot.nameInvalid',
  name_conflict: 'robot.nameConflict',
  platform_unsupported: 'robot.platformUnsupported',
  secret_required: 'robot.secretRequired',
  outbound_not_acknowledged: 'robot.outboundNotAcknowledged',
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

/** Attach each robot's live link state, which is runtime-only and never stored. */
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
