/**
 * IM chat robots: the public data model for c3's deployment-level IM ingress
 * and egress.
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
import type { ImBroadcastType } from './im-broadcast.js'
import type { ImRobotWriteGrant } from './robot-write.js'
import type { VendorId } from './vendor.js'

export type {
  ImRobotWriteGrant,
  RobotWriteCapability,
  RobotWriteGrantStatus,
  RobotWritableCapability,
  TodoAnswerContractSummary,
  TodoAnswerOption,
  TodoTokenResult,
} from './robot-write.js'
export {
  ROBOT_WRITE_CAPABILITIES,
  ROBOT_WRITABLE_CAPABILITIES,
  ROBOT_WRITE_GRANT_STATUSES,
  TODO_TOKEN_PREFIX,
  TODO_TOKEN_RESULTS,
} from './robot-write.js'

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
 * Languages the server-side robot message registry supports. Matches Web
 * {@link UiLang} short codes; null on a robot means follow system default (`en`).
 */
export const ROBOT_MESSAGE_LOCALES = ['en', 'zh', 'ja', 'ko', 'ru'] as const
export type RobotMessageLocale = (typeof ROBOT_MESSAGE_LOCALES)[number]

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
  'input_rejected',
  'busy',
  /** Unbound / revoked sender — identity gate closed before any agent run. */
  'identity_required',
  /** Authorization version changed mid-turn; final answer discarded. */
  'scope_changed',
] as const
export type ImTurnOutcome = (typeof IM_TURN_OUTCOMES)[number]

/** How an IM identity challenge ended, for list/detail summaries (never carries the token). */
export const IM_CHALLENGE_STATUSES = ['pending', 'consumed', 'expired', 'cancelled'] as const
export type ImChallengeStatus = (typeof IM_CHALLENGE_STATUSES)[number]

/**
 * Active binding summary for the authenticated subject (self) or admin views.
 * Tokens never appear here.
 */
export interface ImIdentityBinding {
  id: string
  /** Stable account namespace, e.g. `feishu:<appId>`. */
  accountNamespace: string
  platform: ImPlatform
  /** Opaque platform sender id (admin views may redact; self views show full). */
  senderId: string
  subject: string
  verifiedAt: number
  revokedAt: number | null
}

/** One-shot challenge creation result — plaintext token appears ONLY here. */
export interface ImIdentityChallengeCreated {
  challengeId: string
  accountNamespace: string
  robotId: string
  /** Plaintext token; never listed or re-fetched. */
  token: string
  expiresAt: number
}

/** Pending challenge summary without the token. */
export interface ImIdentityChallengeSummary {
  challengeId: string
  accountNamespace: string
  robotId: string
  status: ImChallengeStatus
  createdAt: number
  expiresAt: number
}

/** One workspace granted to a group chat for detail visibility. */
export interface ImGroupWorkspaceGrant {
  platform: ImPlatform
  /** Provider account key within the platform (Feishu: appId). */
  providerAccountKey: string
  chatId: string
  workspaceName: string
  grantedBy: string
  grantedAt: number
}

/** Closed reason when {@link ImTurnOutcome} is `input_rejected`. */
export const IM_INPUT_REJECT_REASONS = ['credential', 'too_long'] as const
export type ImInputRejectReason = (typeof IM_INPUT_REJECT_REASONS)[number]

/** Max Unicode code points persisted per user or assistant context body. */
export const ROBOT_CONTEXT_MAX_CODEPOINTS = 4000

/** Max committed context turns retained per Conversation. */
export const ROBOT_CONTEXT_MAX_TURNS = 50

/** Retention window for a committed context turn, in milliseconds (30 days). */
export const ROBOT_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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
   * without it is refused server-side.
   */
  outboundAckAt: number | null
  /**
   * Normalized hash of outbound content + target config at acknowledgement time.
   * Any config change invalidates this until the operator re-confirms.
   */
  outboundAckHash: string | null
  /** L0 event kinds this robot may proactively broadcast. Empty = none. */
  broadcastEventTypes: ImBroadcastType[]
  /** When true, bound users with matching personal scope receive p2p broadcasts. */
  broadcastToBoundUsers: boolean
  /** Group chat ids that may receive broadcasts (also must pass chatAllowlist). */
  broadcastGroupChatIds: string[]
  /**
   * Registry copy language for fixed control notices. Null follows system
   * default (`en`). Does not change agent answer or Web UI language.
   */
  locale: RobotMessageLocale | null
  /**
   * Monotonic config revision — incremented on every constrained config or secret
   * write. Write grants bind to the hash at acknowledgement time.
   */
  configRevision: number
  /** Per-capability L2 write grants (absent rows = unauthorized). */
  writeGrants: ImRobotWriteGrant[]
  createdAt: number
  updatedAt: number
  /** Live link state; absent when the robot is disabled. */
  connection?: ImConnectionStatus
}

/**
 * One recorded turn. The audit answers when, for whom, how much was sent and how
 * it ended — never what was said. IM-visible bodies live only in the bounded
 * context store; this audit trail still carries no transcript.
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
  /** Present only when outcome is `input_rejected`. */
  rejectReason: ImInputRejectReason | null
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
  broadcastEventTypes?: ImBroadcastType[]
  broadcastToBoundUsers?: boolean
  broadcastGroupChatIds?: string[]
  /** Registry language; omit on update to keep stored value. Null = system default. */
  locale?: RobotMessageLocale | null
}
