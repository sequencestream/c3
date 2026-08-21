/**
 * IM chat-robot wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 *
 * These messages carry no robot-level `workspaceName`: the robot is a
 * deployment-level management object (one roster for the whole instance). That
 * shape is a management contract, not a data-access safety guarantee — any
 * workspace-scoped read or write belongs on the tool-call contract and must
 * recompute visibility per call. Binding a workspace onto the robot, the
 * connection or a thread is rejected as a design (thread binding would turn a
 * one-time context choice into invisible lasting authorization).
 */

import type { ImPlatform, ImRobot, ImRobotTurnLog, RobotConfigInput } from './robot.js'

/** List every configured robot; server replies with `robots`. */
export type ClientListRobots = { type: 'list_robots' }

/**
 * Create a robot. It is always created disabled — enabling is a separate,
 * deliberate act — so there is no `enabled` field here (ADR-0046).
 */
export type ClientCreateRobot = {
  type: 'create_robot'
  /** Also the working directory name; immutable afterwards. */
  name: string
  platform: ImPlatform
  config: RobotConfigInput
}

/** Update a robot's configuration; server broadcasts `robots`. */
export type ClientUpdateRobot = { type: 'update_robot'; robotId: string; config: RobotConfigInput }

/** Delete a robot together with its threads and audit rows. */
export type ClientDeleteRobot = { type: 'delete_robot'; robotId: string }

/**
 * Record that the operator acknowledged what this robot sends off the machine.
 * A prerequisite for enabling it, checked server-side.
 */
export type ClientAcknowledgeRobotOutbound = {
  type: 'acknowledge_robot_outbound'
  robotId: string
}

/** Enable or disable a robot; server broadcasts `robots`. */
export type ClientSetRobotEnabled = {
  type: 'set_robot_enabled'
  robotId: string
  enabled: boolean
}

/** Read one robot's recent turns; server replies with `robot_turns`. */
export type ClientListRobotTurns = { type: 'list_robot_turns'; robotId: string }

/**
 * The full robot roster. Carries no workspace filter: robots are deployment-
 * level, so every connected console sees the same list. Global management is
 * not unbounded data access — see the file header.
 */
export type ServerRobots = { type: 'robots'; robots: ImRobot[] }

/** One robot's recent turns, newest first. */
export type ServerRobotTurns = {
  type: 'robot_turns'
  robotId: string
  turns: ImRobotTurnLog[]
}
