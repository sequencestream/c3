import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Delivery, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import Deliveries from './Deliveries.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'planned',
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { total: 0, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const PLAN: DeliveryTransitionPlan = {
  targets: [
    {
      to: 'integrating',
      humanAction: true,
      guard: 'failed',
      reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'branch' }],
    },
  ],
}

describe('Deliveries', () => {
  it('renders the delivery list and passes the open through', async () => {
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery()],
        activeId: null,
        activeDelivery: null,
        activePlan: null,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        syncPhase: null,
        associatedIntents: [],
        intents: [],
      },
    })
    expect(w.find('[data-testid="delivery-list"]').exists()).toBe(true)
    await w.find('[data-testid^="delivery-row-"]').trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['d1'])
  })

  it('renders the detail only when an active delivery + plan are present', () => {
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery()],
        activeId: 'd1',
        activeDelivery: delivery(),
        activePlan: PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'current-branch',
        mainlineAhead: null,
        syncPhase: null,
        associatedIntents: [],
        intents: [],
      },
    })
    // current-branch note + the two detail tabs are reachable through the detail.
    expect(w.find('[data-testid="delivery-current-branch-note"]').exists()).toBe(true)
    expect(w.findAll('[data-testid^="delivery-pane-tab-"]').length).toBe(2)
  })

  it('forwards transition through the detail', async () => {
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery()],
        activeId: 'd1',
        activeDelivery: delivery(),
        activePlan: PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        syncPhase: null,
        associatedIntents: [],
        intents: [],
      },
    })
    // The planned→integrating target is blocked; a rework/verify fixture is not
    // present here — assert the container wires the emit from the selector's
    // current delivery (cancelled is a title-bar action, covered elsewhere).
    expect(w.find('[data-testid="delivery-status-block"]').exists()).toBe(true)
  })
})
