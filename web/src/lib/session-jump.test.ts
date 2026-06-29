import { describe, expect, it } from 'vitest'
import { resolveSessionJumpTarget, resolveSessionSourceAction } from './session-jump'

describe('resolveSessionJumpTarget', () => {
  it('returns null when owner is missing', () => {
    expect(
      resolveSessionJumpTarget({ sessionKind: 'work', ownerKind: null, ownerId: null }),
    ).toBeNull()
  })

  it('routes work sessions owned by intents to the intent detail', () => {
    expect(
      resolveSessionJumpTarget({ sessionKind: 'work', ownerKind: 'intent', ownerId: 'intent-1' }),
    ).toEqual({ kind: 'intentDetail', intentId: 'intent-1' })
  })

  it('routes intent comm sessions to intent sessions view', () => {
    expect(
      resolveSessionJumpTarget({ sessionKind: 'intent', ownerKind: 'intent', ownerId: 'intent-1' }),
    ).toEqual({ kind: 'intentSessions', intentId: 'intent-1' })
  })

  it('routes spec sessions to the intent spec session tab', () => {
    expect(
      resolveSessionJumpTarget({ sessionKind: 'spec', ownerKind: 'intent', ownerId: 'intent-1' }),
    ).toEqual({ kind: 'intentDetail', intentId: 'intent-1', tab: 'specSession' })
  })

  it('routes discussion and schedule owners', () => {
    expect(
      resolveSessionJumpTarget({
        sessionKind: 'discussion',
        ownerKind: 'discussion',
        ownerId: 'discussion-1',
      }),
    ).toEqual({ kind: 'discussion', discussionId: 'discussion-1' })
    expect(
      resolveSessionJumpTarget({
        sessionKind: 'schedule',
        ownerKind: 'schedule',
        ownerId: 'schedule-1',
      }),
    ).toEqual({ kind: 'schedule', scheduleId: 'schedule-1' })
  })

  it('routes tool sessions through their owner and rejects unknown owners', () => {
    expect(
      resolveSessionJumpTarget({ sessionKind: 'tool', ownerKind: 'intent', ownerId: 'intent-1' }),
    ).toEqual({ kind: 'intentDetail', intentId: 'intent-1' })
    expect(
      resolveSessionJumpTarget({
        sessionKind: 'tool',
        ownerKind: 'discussion',
        ownerId: 'discussion-1',
      }),
    ).toEqual({ kind: 'discussion', discussionId: 'discussion-1' })
    expect(
      resolveSessionJumpTarget({
        sessionKind: 'tool',
        ownerKind: 'schedule',
        ownerId: 'schedule-1',
      }),
    ).toEqual({ kind: 'schedule', scheduleId: 'schedule-1' })
    expect(
      resolveSessionJumpTarget({ sessionKind: 'tool', ownerKind: 'unknown', ownerId: 'x' }),
    ).toBeNull()
  })
})

describe('resolveSessionSourceAction', () => {
  it('labels intent and spec sessions as "intent"', () => {
    expect(
      resolveSessionSourceAction({ sessionKind: 'spec', ownerKind: 'intent', ownerId: 'i1' }),
    ).toEqual({
      target: { kind: 'intentDetail', intentId: 'i1', tab: 'specSession' },
      label: 'intent',
    })
    expect(
      resolveSessionSourceAction({ sessionKind: 'intent', ownerKind: 'intent', ownerId: 'i1' }),
    ).toEqual({ target: { kind: 'intentSessions', intentId: 'i1' }, label: 'intent' })
  })

  it('labels discussion and schedule sessions by their own kind', () => {
    expect(
      resolveSessionSourceAction({
        sessionKind: 'discussion',
        ownerKind: 'discussion',
        ownerId: 'd1',
      }),
    ).toEqual({ target: { kind: 'discussion', discussionId: 'd1' }, label: 'discussion' })
    expect(
      resolveSessionSourceAction({ sessionKind: 'schedule', ownerKind: 'schedule', ownerId: 's1' }),
    ).toEqual({ target: { kind: 'schedule', scheduleId: 's1' }, label: 'schedule' })
  })

  it('labels work/tool sessions generically as "trace"', () => {
    expect(
      resolveSessionSourceAction({ sessionKind: 'work', ownerKind: 'intent', ownerId: 'i1' }),
    ).toEqual({ target: { kind: 'intentDetail', intentId: 'i1' }, label: 'trace' })
    expect(
      resolveSessionSourceAction({ sessionKind: 'tool', ownerKind: 'schedule', ownerId: 's1' }),
    ).toEqual({ target: { kind: 'schedule', scheduleId: 's1' }, label: 'trace' })
  })

  it('gives a standalone intent (chat) session an owner-less intentSessions target', () => {
    expect(
      resolveSessionSourceAction({ sessionKind: 'intent', ownerKind: null, ownerId: null }),
    ).toEqual({ target: { kind: 'intentSessions', intentId: null }, label: 'intent' })
  })

  it('falls back to the legacy linkedIntentId when owner metadata is absent', () => {
    expect(
      resolveSessionSourceAction({
        sessionKind: 'work',
        ownerKind: null,
        ownerId: null,
        linkedIntentId: 'i9',
      }),
    ).toEqual({ target: { kind: 'intentDetail', intentId: 'i9' }, label: 'trace' })
  })

  it('returns null when nothing resolves', () => {
    expect(
      resolveSessionSourceAction({ sessionKind: 'work', ownerKind: null, ownerId: null }),
    ).toBeNull()
  })
})
