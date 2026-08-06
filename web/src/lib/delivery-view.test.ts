import { describe, expect, it } from 'vitest'
import type { DeliveryTransitionPlan } from '@ccc/shared/protocol'
import {
  calendarDateToEpochMs,
  deliveryGapReasons,
  deliveryTargetInvokable,
  epochMsToCalendarDate,
  isDeliveryReworkTarget,
  isDeliveryTerminal,
  isVerificationConfirmTarget,
} from './delivery-view'

function plan(targets: DeliveryTransitionPlan['targets']): DeliveryTransitionPlan {
  return { targets }
}

describe('deliveryTargetInvokable', () => {
  it('requires a human action AND a satisfied guard', () => {
    expect(
      deliveryTargetInvokable({
        to: 'integrating',
        humanAction: true,
        guard: 'satisfied',
        reasons: [],
      }),
    ).toBe(true)
    expect(
      deliveryTargetInvokable({
        to: 'integrating',
        humanAction: true,
        guard: 'failed',
        reasons: [{ code: 'delivery.guard.branchNotReady' }],
      }),
    ).toBe(false)
    // System-only edges are never invokable even when their data guard is satisfied.
    expect(
      deliveryTargetInvokable({
        to: 'delivered',
        humanAction: false,
        guard: 'satisfied',
        reasons: [],
      }),
    ).toBe(false)
  })
})

describe('isDeliveryReworkTarget / isVerificationConfirmTarget', () => {
  it('recognises the two back-ish human edges by (from,to)', () => {
    expect(isDeliveryReworkTarget('verifying', 'integrating')).toBe(true)
    expect(isDeliveryReworkTarget('planned', 'integrating')).toBe(false)
    expect(isVerificationConfirmTarget('verifying', 'verified')).toBe(true)
    expect(isVerificationConfirmTarget('integrating', 'verifying')).toBe(false)
  })
})

describe('deliveryGapReasons', () => {
  it('flattens + de-duplicates gaps across targets, keeping guard order', () => {
    const g = deliveryGapReasons(
      plan([
        {
          to: 'integrating',
          humanAction: true,
          guard: 'failed',
          reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'workspace-settings' }],
        },
        {
          to: 'verifying',
          humanAction: true,
          guard: 'failed',
          reasons: [
            { code: 'delivery.guard.branchNotReady', jumpTo: 'workspace-settings' },
            { code: 'delivery.guard.prsNotMerged', params: { merged: 1, total: 2 } },
          ],
        },
      ]),
    )
    expect(g.map((r) => r.code)).toEqual([
      'delivery.guard.branchNotReady',
      'delivery.guard.prsNotMerged',
    ])
  })
})

describe('isDeliveryTerminal', () => {
  it('treats delivered / cancelled as terminal', () => {
    expect(isDeliveryTerminal('delivered')).toBe(true)
    expect(isDeliveryTerminal('cancelled')).toBe(true)
    expect(isDeliveryTerminal('verified')).toBe(false)
  })
})

describe('calendar date helpers', () => {
  it('round-trips YYYY-MM-DD through a UTC-midnight epoch', () => {
    expect(epochMsToCalendarDate(calendarDateToEpochMs('2026-08-06'))).toBe('2026-08-06')
  })
  it('renders null/undefined/0 as empty', () => {
    expect(epochMsToCalendarDate(null)).toBe('')
    expect(epochMsToCalendarDate(undefined)).toBe('')
    expect(epochMsToCalendarDate(0)).toBe('')
  })
})
