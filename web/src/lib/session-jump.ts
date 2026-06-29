import type { SessionKind } from '@ccc/shared/protocol'

export type SessionOwnerKind = 'intent' | 'discussion' | 'schedule'

export type SessionJumpTarget =
  | { kind: 'intentDetail'; intentId: string; tab?: 'specSession' }
  // `intentId` is null for a standalone intent (chat) session that has no owning
  // intent: the jump still opens the intents page, just without selecting an intent.
  | { kind: 'intentSessions'; intentId: string | null }
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

// The title-bar source button's i18n label family, chosen by the session's own
// kind (a presentational decision; jump semantics still come only from
// `resolveSessionJumpTarget`). intent/spec → "意图", discussion → "讨论",
// schedule → "定时任务", work/tool (or unknown) → generic "溯源".
export type SessionSourceLabel = 'intent' | 'discussion' | 'schedule' | 'trace'

export interface SessionSourceAction {
  target: SessionJumpTarget
  label: SessionSourceLabel
}

function sourceLabelForKind(kind: SessionKind | string | null | undefined): SessionSourceLabel {
  if (kind === 'spec' || kind === 'intent') return 'intent'
  if (kind === 'discussion') return 'discussion'
  if (kind === 'schedule') return 'schedule'
  return 'trace'
}

// The active session's title-bar source action: a jump target (from
// `resolveSessionJumpTarget`, with the legacy `linkedIntentId` compat field as a
// fallback when owner metadata is absent) plus the label family to render.
// Returns null when nothing resolves ⇒ no button.
export function resolveSessionSourceAction(input: {
  sessionKind: SessionKind | string | null | undefined
  ownerKind: SessionOwnerKind | string | null | undefined
  ownerId: string | null | undefined
  linkedIntentId?: string | null
}): SessionSourceAction | null {
  const target =
    resolveSessionJumpTarget(input) ??
    (input.linkedIntentId
      ? ({ kind: 'intentDetail', intentId: input.linkedIntentId } as const)
      : // A standalone intent (chat) session has no owning intent, but its source is
        // still the intents page — surface a button that opens it there.
        input.sessionKind === 'intent'
        ? ({ kind: 'intentSessions', intentId: null } as const)
        : null)
  if (!target) return null
  return { target, label: sourceLabelForKind(input.sessionKind) }
}
