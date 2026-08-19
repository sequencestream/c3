import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Delivery, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import Deliveries from './Deliveries.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceName: 'w1',
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
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        deliveryLogsById: {},
        deliveryLogsLoadingId: null,
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
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        deliveryLogsById: {},
        deliveryLogsLoadingId: null,
        associatedIntents: [],
        intents: [],
      },
    })
    // current-branch note + the three detail tabs are reachable through the detail.
    expect(w.find('[data-testid="delivery-current-branch-note"]').exists()).toBe(true)
    expect(w.findAll('[data-testid^="delivery-pane-tab-"]').length).toBe(3)
  })

  it('routes logs by delivery id — another delivery s cached trail is never rendered here', async () => {
    const other = {
      id: 'l-other',
      deliveryId: 'd9',
      operationType: 'delivery_created' as const,
      summary: '创建交付: 另一条交付',
      actor: 'alice',
      createdAt: 1,
    }
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery()],
        activeId: 'd1',
        activeDelivery: delivery(),
        activePlan: PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        // Only ANOTHER delivery's trail is cached, and its fetch is the one in
        // flight — neither may leak into the open delivery's tab.
        deliveryLogsById: { d9: [other] },
        deliveryLogsLoadingId: 'd9',
        associatedIntents: [],
        intents: [],
      },
    })
    await w.find('[data-testid="delivery-pane-tab-logs"]').trigger('click')
    expect(w.find('[data-testid="delivery-logs-list"]').exists()).toBe(false)
    // Not "loading" either: that flag belongs to d9, not to the open delivery.
    expect(w.emitted('list-logs')).toEqual([['d1']])
  })

  it('forwards transition through the detail', async () => {
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery({ status: 'verifying' })],
        activeId: 'd1',
        activeDelivery: delivery({ status: 'verifying' }),
        // 一个可达的返工目标:标题栏推进区渲染它,点击直接上抛 transition。
        activePlan: {
          targets: [{ to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] }],
        },
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        deliveryLogsById: {},
        deliveryLogsLoadingId: null,
        associatedIntents: [],
        intents: [],
      },
    })
    await w.find('[data-testid="delivery-advance-integrating"]').trigger('click')
    expect(w.emitted('transition')?.[0]).toEqual(['integrating', false])
  })

  it('forwards a title click in the intents tab through as open-intent', async () => {
    const w = mount(Deliveries, {
      props: {
        deliveries: [delivery()],
        activeId: 'd1',
        activeDelivery: delivery(),
        activePlan: PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        deliveryLogsById: {},
        deliveryLogsLoadingId: null,
        associatedIntents: [
          {
            id: 'i1',
            title: 'Alpha',
            status: 'todo',
            prStatus: null,
            headBranch: null,
            prNumber: null,
            prUrl: null,
          },
        ],
        intents: [],
      },
    })
    await w.find('[data-testid="delivery-pane-tab-intents"]').trigger('click')
    await w.find('[data-testid="delivery-intent-title-i1"]').trigger('click')
    expect(w.emitted('open-intent')?.[0]).toEqual(['i1'])
  })
})
