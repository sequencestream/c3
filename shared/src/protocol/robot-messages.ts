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

import type {
  ImGroupWorkspaceGrant,
  ImIdentityBinding,
  ImIdentityChallengeCreated,
  ImIdentityChallengeSummary,
  ImPlatform,
  ImRobot,
  ImRobotTurnLog,
  RobotConfigInput,
} from './robot.js'

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

/** List the caller's own active IM identity binding (and pending challenge). */
export type ClientGetMyImIdentity = { type: 'get_my_im_identity' }

/**
 * Create a one-shot binding challenge for the authenticated subject against an
 * enabled robot. Subject comes from the connection — never from this payload.
 */
export type ClientCreateImIdentityChallenge = {
  type: 'create_im_identity_challenge'
  robotId: string
}

/** Cancel the caller's pending challenge for a namespace (or all). */
export type ClientCancelImIdentityChallenge = {
  type: 'cancel_im_identity_challenge'
  challengeId: string
}

/** Revoke the caller's own active binding. */
export type ClientRevokeMyImIdentity = {
  type: 'revoke_my_im_identity'
  bindingId: string
}

/** Admin: revoke any active binding. */
export type ClientAdminRevokeImIdentity = {
  type: 'admin_revoke_im_identity'
  bindingId: string
  reason?: string
}

/** Admin: list active bindings (optional namespace filter). */
export type ClientListImIdentityBindings = {
  type: 'list_im_identity_bindings'
  accountNamespace?: string
}

/** Admin: list group workspace grants for one chat. */
export type ClientListImGroupWorkspaceScopes = {
  type: 'list_im_group_workspace_scopes'
  platform: ImPlatform
  providerAccountKey: string
  chatId: string
}

/** Admin: replace the group workspace whitelist for one chat (whole-set write). */
export type ClientSetImGroupWorkspaceScopes = {
  type: 'set_im_group_workspace_scopes'
  platform: ImPlatform
  providerAccountKey: string
  chatId: string
  workspaceNames: string[]
}

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

/** Self identity state: active binding and optional pending challenge (no token). */
export type ServerMyImIdentity = {
  type: 'my_im_identity'
  binding: ImIdentityBinding | null
  pendingChallenge: ImIdentityChallengeSummary | null
  /**
   * When auth is off, the first binder becomes the sole `local` principal with
   * full registered workspace personal scope.
   */
  noAuthLocalHint: boolean
}

/** One-shot challenge response — plaintext token only here. */
export type ServerImIdentityChallengeCreated = {
  type: 'im_identity_challenge_created'
  challenge: ImIdentityChallengeCreated
}

/** Admin binding list. */
export type ServerImIdentityBindings = {
  type: 'im_identity_bindings'
  bindings: ImIdentityBinding[]
}

/** Group workspace whitelist for one chat. */
export type ServerImGroupWorkspaceScopes = {
  type: 'im_group_workspace_scopes'
  platform: ImPlatform
  providerAccountKey: string
  chatId: string
  grants: ImGroupWorkspaceGrant[]
}
