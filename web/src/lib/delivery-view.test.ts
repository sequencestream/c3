import { describe, expect, it } from 'vitest'
import type { DeliveryTransitionPlan } from '@ccc/shared/protocol'
import {
  DELIVERY_STATUS_LABEL_KEYS,
  calendarDateToEpochMs,
  deliveryAdvanceLabelKey,
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

describe('deliveryAdvanceLabelKey', () => {
  it('gives each human edge its own ACTION key', () => {
    expect(deliveryAdvanceLabelKey('planned', 'integrating')).toBe(
      'delivery.action.startIntegrating.label',
    )
    expect(deliveryAdvanceLabelKey('integrating', 'verifying')).toBe(
      'delivery.action.startVerifying.label',
    )
    expect(deliveryAdvanceLabelKey('verifying', 'verified')).toBe(
      'delivery.action.confirmVerification.label',
    )
    expect(deliveryAdvanceLabelKey('verifying', 'integrating')).toBe('delivery.action.rework.label')
  })

  it('never labels a button with a status name — that keyspace belongs to the badge', () => {
    const statusKeys = new Set(Object.values(DELIVERY_STATUS_LABEL_KEYS))
    for (const [from, to] of [
      ['planned', 'integrating'],
      ['integrating', 'verifying'],
      ['verifying', 'verified'],
      ['verifying', 'integrating'],
    ] as const) {
      expect(statusKeys.has(deliveryAdvanceLabelKey(from, to)), `${from}→${to}`).toBe(false)
    }
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
