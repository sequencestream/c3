/**
 * Table-driven tests for the delivery state machine: all 36 from×to combos,
 * the two back edges, the cancel edges, human/system write roles and the four
 * guard rungs. Asserts the illegal-edge code and the guard-failed code + gap
 * reasons separately, and that failed writes change nothing (the machine is
 * pure — the caller applies a status only on `ok`).
 */
import { describe, expect, it } from 'vitest'
import type { Delivery, DeliveryStatus } from '@ccc/shared/protocol'
import { DELIVERY_STATUSES } from '@ccc/shared/protocol'
import {
  DELIVERY_INVALID_TRANSITION,
  DELIVERY_TRANSITION_GUARD_FAILED,
  canTransitionDelivery,
  computeTransitionPlan,
  countDeliveriesNeedingAction,
  deliveryRequiresAction,
  type DeliveryTransitionFacts,
} from './state-machine.js'

/** Legal edges a HUMAN may write (role human; guards passed). */
const LEGAL_HUMAN: ReadonlyArray<[DeliveryStatus, DeliveryStatus]> = [
  ['planned', 'integrating'],
  ['planned', 'cancelled'],
  ['integrating', 'verifying'],
  ['integrating', 'cancelled'],
  ['verifying', 'verified'],
  ['verifying', 'integrating'], // rework
  ['verifying', 'cancelled'],
  ['verified', 'cancelled'],
]

/** Legal edges only the SYSTEM may write. */
const LEGAL_SYSTEM: ReadonlyArray<[DeliveryStatus, DeliveryStatus]> = [
  ['verified', 'delivered'],
  ['verified', 'verifying'], // merge-conflict back edge
]

/** Facts where every guard passes. */
const PASSING_FACTS: DeliveryTransitionFacts = {
  from: 'planned',
  to: 'integrating',
  role: 'human',
  branchReady: true,
  integration: { total: 1, merged: 1 },
  confirmVerified: true,
  mergeSucceeded: true,
  reason: 'merge_conflict',
}

function facts(
  from: DeliveryStatus,
  to: DeliveryStatus,
  patch: Partial<DeliveryTransitionFacts> = {},
): DeliveryTransitionFacts {
  return { ...PASSING_FACTS, from, to, ...patch }
}

describe('canTransitionDelivery — all 36 from×to combos', () => {
  for (const from of DELIVERY_STATUSES) {
    for (const to of DELIVERY_STATUSES) {
      const edge = `edge ${from} → ${to}`
      if (
        (LEGAL_HUMAN as ReadonlyArray<[string, string]>).some(([a, b]) => a === from && b === to)
      ) {
        it(`${edge} is writable by a human when its guards pass`, () => {
          expect(canTransitionDelivery(facts(from, to))).toEqual({ ok: true })
        })
        it(`${edge} is refused for a system writer (transitionGuardFailed)`, () => {
          const v = canTransitionDelivery(facts(from, to, { role: 'system' }))
          expect(v.ok).toBe(false)
          if (!v.ok) {
            expect(v.code).toBe(DELIVERY_TRANSITION_GUARD_FAILED)
            expect(v.reasons.map((r) => r.code)).toContain('delivery.guard.humanOnly')
          }
        })
        continue
      }
      if (
        (LEGAL_SYSTEM as ReadonlyArray<[string, string]>).some(([a, b]) => a === from && b === to)
      ) {
        it(`${edge} is writable by the system when its guards pass`, () => {
          expect(canTransitionDelivery(facts(from, to, { role: 'system' }))).toEqual({ ok: true })
        })
        it(`${edge} is refused for a human writer (systemOnly)`, () => {
          const v = canTransitionDelivery(facts(from, to, { role: 'human' }))
          expect(v.ok).toBe(false)
          if (!v.ok) {
            expect(v.code).toBe(DELIVERY_TRANSITION_GUARD_FAILED)
            expect(v.reasons.map((r) => r.code)).toContain('delivery.guard.systemOnly')
          }
        })
        continue
      }
      it(`${edge} is an illegal transition (invalidStatusTransition)`, () => {
        const v = canTransitionDelivery(facts(from, to))
        expect(v).toEqual({ ok: false, code: DELIVERY_INVALID_TRANSITION, reasons: [] })
      })
    }
  }
})

describe('canTransitionDelivery — the four guard rungs, in order', () => {
  it('planned → integrating requires the branch ready', () => {
    const v = canTransitionDelivery(facts('planned', 'integrating', { branchReady: false }))
    expect(v).toEqual({
      ok: false,
      code: DELIVERY_TRANSITION_GUARD_FAILED,
      reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'workspace-settings' }],
    })
  })

  it('integrating → verifying needs ≥1 association before anything else', () => {
    const v = canTransitionDelivery(
      facts('integrating', 'verifying', { integration: { total: 0, merged: 0 } }),
    )
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons[0]).toEqual({
        code: 'delivery.guard.noAssociatedIntents',
        jumpTo: 'associated-intents',
      })
    }
  })

  it('integrating → verifying blocks on unmerged PRs (missing PR and non-merged both count)', () => {
    const v = canTransitionDelivery(
      facts('integrating', 'verifying', { integration: { total: 2, merged: 1 } }),
    )
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons[0]).toEqual({
        code: 'delivery.guard.prsNotMerged',
        params: { merged: 1, total: 2 },
        jumpTo: 'associated-intents',
      })
    }
  })

  it('verifying → verified needs an explicit human confirmation even when all PRs merged', () => {
    const v = canTransitionDelivery(facts('verifying', 'verified', { confirmVerified: false }))
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons).toContainEqual({ code: 'delivery.guard.verificationNotConfirmed' })
    }
  })

  it('verified → delivered needs the merge to have succeeded (system writer)', () => {
    const v = canTransitionDelivery(
      facts('verified', 'delivered', { role: 'system', mergeSucceeded: false }),
    )
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons).toContainEqual({ code: 'delivery.guard.mergeNotSucceeded' })
    }
  })

  it('verified → verifying (system) requires the merge-conflict reason', () => {
    const v = canTransitionDelivery(
      facts('verified', 'verifying', { role: 'system', reason: undefined }),
    )
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons).toContainEqual({ code: 'delivery.guard.mergeConflictReasonRequired' })
    }
  })

  it('a human viewer of a system-only edge gets the role note but not the write-reason', () => {
    const v = canTransitionDelivery(facts('verified', 'verifying', { role: 'human' }))
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reasons).toContainEqual({ code: 'delivery.guard.systemOnly' })
      expect(v.reasons.map((r) => r.code)).not.toContain(
        'delivery.guard.mergeConflictReasonRequired',
      )
    }
  })

  it('rework verifying → integrating has no data guard for a human', () => {
    expect(canTransitionDelivery(facts('verifying', 'integrating'))).toEqual({ ok: true })
    // branch/integration facts are irrelevant to rework.
    expect(
      canTransitionDelivery(
        facts('verifying', 'integrating', {
          branchReady: false,
          integration: { total: 0, merged: 0 },
        }),
      ),
    ).toEqual({ ok: true })
  })

  it('terminal states have no out-edges', () => {
    for (const from of ['delivered', 'cancelled'] as DeliveryStatus[]) {
      for (const to of DELIVERY_STATUSES) {
        expect(canTransitionDelivery(facts(from, to, { role: 'system' }))).toEqual({
          ok: false,
          code: DELIVERY_INVALID_TRANSITION,
          reasons: [],
        })
      }
    }
  })

  it('a same-state write is illegal (no no-op)', () => {
    expect(canTransitionDelivery(facts('planned', 'planned'))).toEqual({
      ok: false,
      code: DELIVERY_INVALID_TRANSITION,
      reasons: [],
    })
  })
})

function delivery(status: DeliveryStatus, patch: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'T',
    description: '',
    status,
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { total: 0, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('computeTransitionPlan — reachability the page renders + gaps', () => {
  it('planned shows integrating greyed until the branch is ready', () => {
    const plan = computeTransitionPlan(delivery('planned'))
    expect(plan.targets).toEqual([
      {
        to: 'integrating',
        humanAction: true,
        guard: 'failed',
        reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'workspace-settings' }],
      },
    ])
  })

  it('planned shows integrating invokable once the branch is ready', () => {
    const plan = computeTransitionPlan(delivery('planned', { branchReady: true }))
    expect(plan.targets).toEqual([
      { to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] },
    ])
  })

  it('integrating shows verifying blocked on association/PR gaps', () => {
    const plan = computeTransitionPlan(
      delivery('integrating', { branchReady: true, integration: { total: 2, merged: 1 } }),
    )
    expect(plan.targets).toEqual([
      {
        to: 'verifying',
        humanAction: true,
        guard: 'failed',
        reasons: [
          {
            code: 'delivery.guard.prsNotMerged',
            params: { merged: 1, total: 2 },
            jumpTo: 'associated-intents',
          },
        ],
      },
    ])
  })

  it('verifying offers the rework edge always-satisfied and verified gated on confirmation', () => {
    const plan = computeTransitionPlan(
      delivery('verifying', { branchReady: true, integration: { total: 1, merged: 1 } }),
    )
    expect(plan.targets.map((t) => [t.to, t.humanAction, t.guard])).toEqual([
      ['verified', true, 'failed'],
      ['integrating', true, 'satisfied'],
    ])
    const verified = plan.targets.find((t) => t.to === 'verified')!
    expect(verified.reasons).toContainEqual({ code: 'delivery.guard.verificationNotConfirmed' })
  })

  it('verified shows only system edges (never human-invokable)', () => {
    const plan = computeTransitionPlan(delivery('verified'))
    expect(plan.targets.map((t) => [t.to, t.humanAction, t.guard])).toEqual([
      ['delivered', false, 'failed'],
      ['verifying', false, 'failed'],
    ])
  })

  it('terminal states show no targets', () => {
    expect(computeTransitionPlan(delivery('delivered')).targets).toEqual([])
    expect(computeTransitionPlan(delivery('cancelled')).targets).toEqual([])
  })
})

describe('deliveryRequiresAction — the badge rule', () => {
  it('counts only deliveries with an executable human action or human-solvable gap', () => {
    // planned: branch not ready — not human-solvable this phase → no badge.
    expect(
      deliveryRequiresAction('planned', computeTransitionPlan(delivery('planned')).targets),
    ).toBe(false)
    // planned with branch ready: integrating is invokable → badge.
    expect(
      deliveryRequiresAction(
        'planned',
        computeTransitionPlan(delivery('planned', { branchReady: true })).targets,
      ),
    ).toBe(true)
    // integrating: no association, no executable action → no badge.
    expect(
      deliveryRequiresAction(
        'integrating',
        computeTransitionPlan(delivery('integrating', { branchReady: true })).targets,
      ),
    ).toBe(false)
    // verifying: the rework edge is always executable → badge.
    expect(
      deliveryRequiresAction('verifying', computeTransitionPlan(delivery('verifying')).targets),
    ).toBe(true)
    // verified: pure system wait → no badge.
    expect(
      deliveryRequiresAction('verified', computeTransitionPlan(delivery('verified')).targets),
    ).toBe(false)
    // terminals: never.
    expect(
      deliveryRequiresAction('delivered', computeTransitionPlan(delivery('delivered')).targets),
    ).toBe(false)
    expect(
      deliveryRequiresAction('cancelled', computeTransitionPlan(delivery('cancelled')).targets),
    ).toBe(false)
  })

  it('sums over a workspace list without reading a redundant column', () => {
    const items = [
      delivery('planned'),
      delivery('planned', { branchReady: true, id: 'd2' }),
      delivery('verifying', { id: 'd3' }),
      delivery('verified', { id: 'd4' }),
      delivery('cancelled', { id: 'd5' }),
    ]
    expect(countDeliveriesNeedingAction(items)).toBe(2)
  })
})
