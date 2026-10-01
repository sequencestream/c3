import type { SessionKind, SessionOwnerKind } from '@ccc/shared/protocol'

export const ACTIVITY_STATES = [
  'running',
  'awaiting_user',
  'paused',
  'parked',
  'stale',
  'idle',
] as const

export type ActivityState = (typeof ACTIVITY_STATES)[number]

/** States that belong in the workspace running-session union. */
export const RUNNING_ACTIVITY_STATES = ['running', 'awaiting_user', 'parked'] as const

export type RunningActivityState = (typeof RUNNING_ACTIVITY_STATES)[number]

export function isRunningActivityState(state: ActivityState): boolean {
  return state === 'running' || state === 'awaiting_user' || state === 'parked'
}

export interface ActivityOwner {
  kind: SessionOwnerKind
  id: string
}

export interface ActivityFact {
  activityId: string
  generation: string
  sequence: number
  sessionId: string
  workspaceName: string
  sessionKind: SessionKind
  owner?: ActivityOwner
  state: ActivityState
  updatedAt: number
  leaseUntil?: number
}

export type ActivityRejectReason =
  'unknown_activity' | 'stale_generation' | 'stale_sequence' | 'settled' | 'duplicate_session'

export type ActivityApplyResult =
  { accepted: true; fact: ActivityFact } | { accepted: false; reason: ActivityRejectReason }

export interface ActivityStartInput {
  activityId: string
  sessionId: string
  workspaceName: string
  sessionKind: SessionKind
  owner?: ActivityOwner
  state?: Exclude<ActivityState, 'idle'>
  generation?: string
  at?: number
  leaseUntil?: number
}

export interface ActivityFencing {
  generation?: string
  sequence?: number
  at?: number
}

export interface ActivityRegistryClock {
  now: () => number
  generation: () => string
}
