/**
 * Normalized hash of everything that may leave the machine via one robot.
 *
 * Used at acknowledgement time and re-checked on every guarded send. Changing
 * reply targets, L0 event types, or broadcast destinations invalidates the ack.
 */
import { createHash } from 'node:crypto'
import type { ImRobot } from '@ccc/shared/protocol'

const SCHEMA_VERSION = 'v1'

export function computeOutboundConfigHash(robot: ImRobot): string {
  const payload = [
    SCHEMA_VERSION,
    JSON.stringify([...robot.chatAllowlist].sort()),
    robot.dmMode,
    JSON.stringify([...robot.dmAllowlist].sort()),
    JSON.stringify([...robot.broadcastEventTypes].sort()),
    robot.broadcastToBoundUsers ? '1' : '0',
    JSON.stringify([...robot.broadcastGroupChatIds].sort()),
  ].join('\0')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function outboundConfigAcknowledged(robot: ImRobot): boolean {
  if (robot.outboundAckAt == null || robot.outboundAckHash == null) return false
  return computeOutboundConfigHash(robot) === robot.outboundAckHash
}
