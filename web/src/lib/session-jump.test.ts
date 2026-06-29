import { describe, expect, it } from 'vitest'
import { resolveSessionJumpTarget } from './session-jump'

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
