/**
 * IM robot L2 write authorization — per-capability grants and todo answer contracts.
 *
 * Grants express what a robot MAY attempt; each response still intersects with
 * the sender's binding, personal scope, frozen todo actor, and one-time token.
 */

/** Closed capability registry — unknown names are refused server-side. */
export const ROBOT_WRITE_CAPABILITIES = [
  'queue_respond',
  'automation_control',
  'annotate',
  'dev_start',
] as const
export type RobotWriteCapability = (typeof ROBOT_WRITE_CAPABILITIES)[number]

/** Capabilities that may receive an enabled grant (dev_start is Web-only). */
export const ROBOT_WRITABLE_CAPABILITIES = [
  'queue_respond',
  'automation_control',
  'annotate',
] as const
export type RobotWritableCapability = (typeof ROBOT_WRITABLE_CAPABILITIES)[number]

/** Grant lifecycle as the admin console sees it. */
export const ROBOT_WRITE_GRANT_STATUSES = ['unauthorized', 'active', 'stale', 'disabled'] as const
export type RobotWriteGrantStatus = (typeof ROBOT_WRITE_GRANT_STATUSES)[number]

/** One per-robot, per-capability write grant row (read model). */
export interface ImRobotWriteGrant {
  robotId: string
  capability: RobotWriteCapability
  status: RobotWriteGrantStatus
  enabled: boolean
  acknowledgedBy: string | null
  writeAckAt: number | null
  configHash: string | null
  updatedAt: number | null
}

/** Frozen answer option inside a todo answer contract (never free text). */
export interface TodoAnswerOption {
  answerId: string
  label: string
}

/** Server-side todo answer contract summary (no token plaintext). */
export interface TodoAnswerContractSummary {
  todoId: string
  capability: RobotWritableCapability
  actorSubject: string
  workspaceName: string
  objectType: string
  objectId: string
  todoFingerprint: string
  answers: TodoAnswerOption[]
  expiresAt: number
}

/** Token consumption outcome for audit and user feedback. */
export const TODO_TOKEN_RESULTS = [
  'applied',
  'already_applied',
  'refused',
  'stale',
  'unavailable',
  'expired',
  'cancelled',
  'consumed',
  'grant_missing',
  'scope_denied',
  'actor_denied',
  'format_invalid',
  'answer_invalid',
  'capability_denied',
  'domain_refused',
  'store_unavailable',
] as const
export type TodoTokenResult = (typeof TODO_TOKEN_RESULTS)[number]

/** Plaintext todo token prefix — distinct from identity binding tokens. */
export const TODO_TOKEN_PREFIX = 'c3todo_'
