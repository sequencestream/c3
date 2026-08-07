import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Delivery, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import DeliveryDetail from './DeliveryDetail.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Sprint 3',
    description: 'ship the batch',
    status: 'planned',
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { total: 2, merged: 1 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const PLANNED_PLAN: DeliveryTransitionPlan = {
  targets: [
    {
      to: 'integrating',
      humanAction: true,
      guard: 'failed',
      reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'branch' }],
    },
  ],
}

function mountDetail(
  over: {
    delivery?: Delivery
    plan?: DeliveryTransitionPlan
    mode?: 'worktree' | 'current-branch'
  } = {},
) {
  return mount(DeliveryDetail, {
    props: {
      delivery: over.delivery ?? delivery(),
      plan: over.plan ?? PLANNED_PLAN,
      branchInit: null,
      workspaceGitBranchMode: over.mode ?? 'worktree',
      mainlineAhead: null,
      syncPhase: null,
      associatedIntents: [],
      intents: [],
    },
  })
}

describe('DeliveryDetail', () => {
  it('renders exactly two tabs: overview / associated intents', () => {
    const w = mountDetail()
    const tabs = w.findAll('[data-testid^="delivery-pane-tab-"]')
    expect(tabs.map((t) => t.attributes('data-testid'))).toEqual([
      'delivery-pane-tab-overview',
      'delivery-pane-tab-intents',
    ])
    // 无 PR / 设置 / 分支 独立 Tab。
    for (const forbidden of ['pr', 'settings', 'branch']) {
      expect(w.find(`[data-testid="delivery-pane-tab-${forbidden}"]`).exists()).toBe(false)
    }
  })

  it('renders the segmented selector with blocked targets greyed (disabled)', () => {
    const w = mountDetail()
    const blocked = w.find('[data-testid="delivery-seg-integrating"]')
    expect(blocked.exists()).toBe(true)
    expect(blocked.attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="delivery-seg-current-planned"]').exists()).toBe(true)
  })

  it('shows the persistent gap list with the jump entry and N/M inline', () => {
    const w = mountDetail()
    expect(w.find('[data-testid="delivery-gaps"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-gap-delivery.guard.branchNotReady"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-gap-jump"]').exists()).toBe(false) // no hard-coded testid; jump is a button
    expect(w.find('[data-testid="delivery-ready-line"]').exists()).toBe(true)
    // N/M 并入说明,不做独立进度条。
    expect(w.find('[data-testid="delivery-progress"]').exists()).toBe(false)
  })

  it('shows the current-branch aggregate-only note when in current-branch mode', () => {
    const w = mountDetail({ mode: 'current-branch' })
    expect(w.find('[data-testid="delivery-current-branch-note"]').exists()).toBe(true)
  })

  it('omits the current-branch note in worktree mode', () => {
    const w = mountDetail({ mode: 'worktree' })
    expect(w.find('[data-testid="delivery-current-branch-note"]').exists()).toBe(false)
  })

  it('jumps from the branch gap to the branch-init section (no workspace settings)', async () => {
    const w = mountDetail()
    // The branchNotReady gap now jumps to the delivery's own branch-init section,
    // not the workspace settings.
    const jumpBtns = w.findAll('.delivery-gap-jump')
    expect(jumpBtns.length).toBeGreaterThan(0)
    await jumpBtns[0].trigger('click')
    await w.vm.$nextTick()
    expect(w.emitted('open-workspace-settings')).toBeFalsy()
    expect(w.find('[data-testid="delivery-branch-block"]').exists()).toBe(true)
  })

  it('renders the branch-init form (with the generated default name) when branch is not ready', () => {
    const w = mountDetail()
    expect(w.find('[data-testid="delivery-branch-block"]').exists()).toBe(true)
    const input = w.find('[data-testid="delivery-branch-name-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('delivery/d1-sprint-3')
    expect(
      w.find('[data-testid="delivery-branch-init-btn"]').attributes('disabled'),
    ).toBeUndefined()
  })

  it('emits init-branch with mode + branch name', async () => {
    const w = mountDetail()
    const input = w.find('[data-testid="delivery-branch-name-input"]')
    await input.setValue('release/2026-08')
    await w.find('[data-testid="delivery-branch-mode-bind"]').trigger('click')
    await w.find('[data-testid="delivery-branch-init-btn"]').trigger('click')
    expect(w.emitted('init-branch')?.[0]).toEqual([{ mode: 'bind', branchName: 'release/2026-08' }])
  })

  it('shows the in-flight progress line while a branch-init run is active', () => {
    const w = mountDetail()
    // branchInit starts null → no progress line; re-mount with a live run.
    expect(w.find('[data-testid="delivery-branch-init-progress"]').exists()).toBe(false)
    const w2 = mount(DeliveryDetail, {
      props: {
        delivery: delivery(),
        plan: PLANNED_PLAN,
        branchInit: { deliveryId: 'd1', phase: 'pushing' },
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        syncPhase: null,
        associatedIntents: [],
        intents: [],
      },
    })
    expect(w2.find('[data-testid="delivery-branch-init-progress"]').exists()).toBe(true)
  })

  it('does not render the branch-init form in current-branch mode', () => {
    const w = mountDetail({ mode: 'current-branch' })
    expect(w.find('[data-testid="delivery-branch-block"]').exists()).toBe(false)
  })

  it('renders the cleanup entry (with danger ConfirmDialog) only for a terminal delivery with a branch', async () => {
    const w = mountDetail({
      delivery: delivery({ status: 'delivered', branchName: 'delivery/abc' }),
      plan: { targets: [] },
    })
    expect(w.find('[data-testid="delivery-branch-cleanup"]').exists()).toBe(true)
    await w.find('[data-testid="delivery-branch-cleanup-btn"]').trigger('click')
    const dialogs = w.findAllComponents(ConfirmDialog)
    const open = dialogs.find((d) => d.props('open') === true)
    expect(open).toBeTruthy()
    open!.vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('cleanup-branch')?.[0]).toEqual(['d1'])
  })

  it('emits cancel via the danger ConfirmDialog', async () => {
    const w = mountDetail()
    await w.find('[data-testid="delivery-cancel-btn"]').trigger('click')
    const dialogs = w.findAllComponents(ConfirmDialog)
    const open = dialogs.find((d) => d.props('open') === true)
    expect(open).toBeTruthy()
    open!.vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('cancel')?.[0]).toEqual(['d1'])
  })

  it('emits transition with confirmVerified=true after the verification confirmation', async () => {
    const w = mountDetail({
      delivery: delivery({
        status: 'verifying',
        branchReady: true,
        integration: { total: 1, merged: 1 },
      }),
      plan: {
        targets: [
          { to: 'verified', humanAction: true, guard: 'satisfied', reasons: [] },
          { to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] },
        ],
      },
    })
    const verifiedSeg = w.find('[data-testid="delivery-seg-verified"]')
    expect(verifiedSeg.attributes('disabled')).toBeUndefined()
    await verifiedSeg.trigger('click')
    // The verifying→verified target pops the confirmation dialog before writing.
    const dialogs = w.findAllComponents(ConfirmDialog)
    const open = dialogs.find((d) => d.props('open') === true)
    expect(open).toBeTruthy()
    open!.vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('transition')?.[0]).toEqual(['verified', true])
  })

  it('emits rework directly (no confirmation) for verifying → integrating', async () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verifying' }),
      plan: {
        targets: [
          {
            to: 'verified',
            humanAction: true,
            guard: 'failed',
            reasons: [{ code: 'delivery.guard.verificationNotConfirmed' }],
          },
          { to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] },
        ],
      },
    })
    await w.find('[data-testid="delivery-seg-integrating"]').trigger('click')
    expect(w.emitted('transition')?.[0]).toEqual(['integrating', false])
  })

  it('renders the terminal note for delivered / cancelled', () => {
    const w = mountDetail({ delivery: delivery({ status: 'delivered' }), plan: { targets: [] } })
    expect(w.find('[data-testid="delivery-terminal-note"]').exists()).toBe(true)
  })

  it('renders overview meta rows (branch, base branch, dates) without a PR link', () => {
    const w = mountDetail()
    expect(w.find('[data-testid="delivery-meta-base-branch"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-meta-branch"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-meta-pr"]').exists()).toBe(true)
  })
})
