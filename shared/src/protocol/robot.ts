/**
 * IM chat robots: the public data model for c3's deployment-level IM ingress
 * and egress (ADR-0046).
 *
 * A robot is a c3-instance resource, not a workspace resource: its roster,
 * connection and config are shared across the deployment. That is *not*
 * unbounded access — workspace, object and user authority are never inferred
 * from the robot directory, the platform connection, `threadKey` or
 * `sessionId`; callers that touch c3 objects must recompute scope per tool
 * call. The run root `~/.c3/robots/<name>/` is an isolated working container
 * (identity, display name and directory name at once), not an authorization
 * boundary or a default workspace.
 *
 * The app secret never appears here. A robot carries `hasSecret` so the console
 * can tell "configured" from "not configured"; the plaintext travels one way
 * only, on the write that sets it.
 */
import type { VendorId } from './vendor.js'

/** The chat platforms a robot can be bound to. */
export const IM_PLATFORMS = ['feishu'] as const
export type ImPlatform = (typeof IM_PLATFORMS)[number]

/** Whether, and from whom, a robot accepts direct messages. */
export const IM_DM_MODES = ['disabled', 'allowlist', 'open'] as const
export type ImDmMode = (typeof IM_DM_MODES)[number]

/**
 * A robot's name, which is also its directory name. Lowercase so the identity
 * cannot depend on a filesystem's case sensitivity, and free of separators so it
 * can never escape the robots directory.
 */
export const ROBOT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** Default wall clock for one robot turn, when the robot sets none. */
export const ROBOT_DEFAULT_MAX_TURN_MS = 300_000

/**
 * How a robot turn ended, including the ways it never reached the chat.
 * `busy` is the thread already running a turn (busy notice sent, no agent run).
 * `guard_refused` is any outbound-guard refusal (credential hit included).
 */
export const IM_TURN_OUTCOMES = [
  'complete',
  'error',
  'blocked',
  'timeout',
  'guard_refused',
  'busy',
] as const
export type ImTurnOutcome = (typeof IM_TURN_OUTCOMES)[number]

/**
 * A robot's live link to its platform. Runtime state, never persisted — it is
 * re-established on every start, so a stored copy could only ever be stale.
 */
export const IM_CONNECTION_STATES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
] as const
export type ImConnectionState = (typeof IM_CONNECTION_STATES)[number]

/** A robot's connection as the console renders it. */
export interface ImConnectionStatus {
  state: ImConnectionState
  /** Consecutive reconnect attempts in the current loop; 0 once connected. */
  reconnectAttempts: number
  /** Why the last attempt failed, when it did. Never carries credentials. */
  lastError?: string
}

/** One configured robot, as the console sees it. */
export interface ImRobot {
  id: string
  /** Identity, display name and directory name. Immutable after creation. */
  name: string
  platform: ImPlatform
  appId: string
  /** Whether an app secret is stored. The secret itself never reaches the wire. */
  hasSecret: boolean
  vendor: VendorId
  /** A real agent id, or a group reference resolved fresh on every turn. */
  agentId: string
  /** Preset action mode, same vocabulary as an automation's. */
  mode: string
  /**
   * Write/exec-class tools this robot was deliberately widened to. Empty — the
   * value a robot is created with — leaves it read-only.
   */
  toolAllowlist: string[]
  /** Whether a group message must @-mention the robot to get a reply. */
  requireMention: boolean
  /** Group ids the robot answers in; empty means every group. */
  chatAllowlist: string[]
  dmMode: ImDmMode
  dmAllowlist: string[]
  /** Wall clock for one turn; null means {@link ROBOT_DEFAULT_MAX_TURN_MS}. */
  maxTurnMs: number | null
  enabled: boolean
  /**
   * When the operator acknowledged what leaves the machine. Enabling a robot
   * without it is refused server-side (ADR-0046).
   */
  outboundAckAt: number | null
  createdAt: number
  updatedAt: number
  /** Live link state; absent when the robot is disabled. */
  connection?: ImConnectionStatus
}

/**
 * One recorded turn. The audit answers when, for whom, how much was sent and how
 * it ended — never what was said. An outbound copy of the text is exactly the
 * kind of data c3 does not put on disk (ADR-0045).
 */
export interface ImRobotTurnLog {
  id: string
  robotId: string
  threadKey: string
  chatId: string
  senderId: string
  sessionId: string | null
  startedAt: number
  finishedAt: number | null
  outcome: ImTurnOutcome | null
  /** Characters actually delivered to the platform; 0 when nothing was sent. */
  outboundChars: number
  error: string | null
}

/**
 * The editable half of a robot's configuration, shared by create and update.
 * The app secret travels one way only — it is set here and never read back.
 */
export interface RobotConfigInput {
  appId?: string
  /**
   * Plaintext, sent only when it is being set. Omitted on an update that leaves
   * the stored secret alone; an empty string clears it. It is never sent back.
   */
  appSecret?: string
  vendor?: VendorId
  /** A real agent id, or a group reference resolved fresh on every turn. */
  agentId?: string
  mode?: string
  toolAllowlist?: string[]
  requireMention?: boolean
  chatAllowlist?: string[]
  dmMode?: ImDmMode
  dmAllowlist?: string[]
  maxTurnMs?: number | null
}
