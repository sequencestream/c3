/**
 * Normalized hash of everything that constrains L2 write authorization for one robot.
 *
 * Covers all editable robot config, credential version, and monotonic config_revision.
 * Excludes grant/outbound ack fields, enabled runtime state, and timestamps.
 */
import { createHash } from 'node:crypto'
import type { ImRobot } from '@ccc/shared/protocol'

const SCHEMA_VERSION = 'v1'

export function computeWriteConfigHash(robot: ImRobot): string {
  const payload = [
    SCHEMA_VERSION,
    robot.platform,
    robot.appId,
    robot.hasSecret ? '1' : '0',
    robot.vendor,
    robot.agentId,
    robot.mode,
    JSON.stringify([...robot.toolAllowlist].sort()),
    robot.requireMention ? '1' : '0',
    JSON.stringify([...robot.chatAllowlist].sort()),
    robot.dmMode,
    JSON.stringify([...robot.dmAllowlist].sort()),
    String(robot.maxTurnMs ?? ''),
    robot.locale ?? '',
    String(robot.configRevision),
  ].join('\0')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function writeGrantConfigAcknowledged(robot: ImRobot, storedHash: string | null): boolean {
  if (!storedHash) return false
  return computeWriteConfigHash(robot) === storedHash
}
