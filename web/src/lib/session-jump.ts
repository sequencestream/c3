import type { SessionKind } from '@ccc/shared/protocol'

export type SessionOwnerKind = 'intent' | 'discussion' | 'schedule'

export type SessionJumpTarget =
  | { kind: 'intentDetail'; intentId: string; tab?: 'specSession' }
  | { kind: 'intentSessions'; intentId: string }
  | { kind: 'discussion'; discussionId: string }
  | { kind: 'schedule'; scheduleId: string }

export function resolveSessionJumpTarget(input: {
  sessionKind: SessionKind | string | null | undefined
  ownerKind: SessionOwnerKind | string | null | undefined
  ownerId: string | null | undefined
}): SessionJumpTarget | null {
  if (!input.ownerKind || !input.ownerId) return null
  if (input.ownerKind === 'intent') {
    if (input.sessionKind === 'spec')
      return { kind: 'intentDetail', intentId: input.ownerId, tab: 'specSession' }
    if (input.sessionKind === 'intent') return { kind: 'intentSessions', intentId: input.ownerId }
    if (input.sessionKind === 'work') return { kind: 'intentDetail', intentId: input.ownerId }
    if (input.sessionKind === 'tool') return { kind: 'intentDetail', intentId: input.ownerId }
  }
  if (
    (input.sessionKind === 'discussion' || input.sessionKind === 'tool') &&
    input.ownerKind === 'discussion'
  ) {
    return { kind: 'discussion', discussionId: input.ownerId }
  }
  if (
    (input.sessionKind === 'schedule' || input.sessionKind === 'tool') &&
    input.ownerKind === 'schedule'
  ) {
    return { kind: 'schedule', scheduleId: input.ownerId }
  }
  return null
}
