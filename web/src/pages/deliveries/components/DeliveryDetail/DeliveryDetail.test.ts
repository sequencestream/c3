import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Delivery, DeliveryPr, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import { DELIVERY_STATUSES } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import { i18n } from '@/i18n'
import { DELIVERY_STATUS_LABEL_KEYS } from '@/lib/delivery-view'
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
    mainlineAhead?: number | null
    deliveryBranchAhead?: number | null
    deliveryPr?: DeliveryPr | null
  } = {},
) {
  return mount(DeliveryDetail, {
    props: {
      delivery: over.delivery ?? delivery(),
      plan: over.plan ?? PLANNED_PLAN,
      branchInit: null,
      workspaceGitBranchMode: over.mode ?? 'worktree',
      mainlineAhead: over.mainlineAhead ?? null,
      deliveryBranchAhead: over.deliveryBranchAhead ?? null,
      syncPhase: null,
      deliveryPr: over.deliveryPr ?? null,
      deliveryPrBusy: false,
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

  it('renders the status badge tight against the title, one per status', () => {
    for (const status of DELIVERY_STATUSES) {
      const w = mountDetail({ delivery: delivery({ status }), plan: { targets: [] } })
      const badge = w.find(`[data-testid="delivery-detail-status-${status}"]`)
      expect(badge.exists(), status).toBe(true)
      // 徽标携带状态名以便逐态配色,且纯展示——不是按钮、不承载动作。
      expect(badge.classes(), status).toContain(status)
      expect(badge.element.tagName, status).toBe('SPAN')
    }
  })

  it('renders the badge right after the title, with no flexing element between them', () => {
    const w = mountDetail()
    const head = w.find('.delivery-detail-head')
    const children = [...head.element.children].map((el) => el.className)
    expect(children[0]).toContain('delivery-detail-title')
    expect(children[1]).toContain('delivery-detail-status')
    // 吃掉剩余宽度的空隙元素排在徽标之后,动作组再跟其后。
    expect(children[2]).toContain('delivery-head-spacer')
    expect(children[3]).toContain('delivery-head-actions')
  })

  it('renders no advance button at all when every target is guard-blocked', () => {
    const w = mountDetail()
    // 被挡目标不是置灰,是根本不渲染;推进区里一个目标按钮也没有。
    expect(w.findAll('[data-testid^="delivery-advance-"]').length).toBe(0)
    expect(w.find('[data-testid="delivery-seg-integrating"]').exists()).toBe(false)
  })

  it('shows the gap banner under the title bar, with its jump entry, and N/M in the title bar', () => {
    const w = mountDetail()
    const banner = w.find('[data-testid="delivery-gaps"]')
    expect(banner.exists()).toBe(true)
    // 缺口框在标题栏之下、Tab 条之上,不在概览 tab 内。
    expect(w.find('[data-testid="delivery-overview"] [data-testid="delivery-gaps"]').exists()).toBe(
      false,
    )
    expect(banner.attributes('role')).toBe('alert')
    expect(w.find('[data-testid="delivery-gap-delivery.guard.branchNotReady"]').exists()).toBe(true)
    expect(banner.find('.delivery-gap-jump').exists()).toBe(true)
    // N/M 收进标题栏动作组,不做独立进度条。
    const ready = w.find(
      '[data-testid="delivery-head-actions"] [data-testid="delivery-ready-line"]',
    )
    expect(ready.exists()).toBe(true)
    expect(ready.text()).toContain('1')
    expect(ready.text()).toContain('2')
    expect(w.find('[data-testid="delivery-progress"]').exists()).toBe(false)
  })

  it('keeps the gap banner visible after switching to the associated-intents tab', async () => {
    const w = mountDetail()
    await w.find('[data-testid="delivery-pane-tab-intents"]').trigger('click')
    expect(w.find('[data-testid="delivery-gaps"]').exists()).toBe(true)
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
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
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

  it('emits cancel from the overflow menu via the danger ConfirmDialog', async () => {
    const w = mountDetail()
    // 取消不在标题栏直排,得先展开「…」。
    expect(w.find('[data-testid="delivery-cancel-btn"]').exists()).toBe(false)
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    await w.find('[data-testid="delivery-cancel-btn"]').trigger('click')
    // 点菜单项即收起菜单,确认框接手。
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)
    const open = w.findAllComponents(ConfirmDialog).find((d) => d.props('open') === true)
    expect(open).toBeTruthy()
    expect(open!.props('danger')).toBe(true)
    open!.vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('cancel')?.[0]).toEqual(['d1'])
  })

  it('omits the cancel action for terminal statuses, keeps it reachable for non-terminal', async () => {
    // 取消已收进「…」,可达性因此按「展开后菜单里有没有这一项」判定:终态连入口都没有,
    // 自然也够不着取消;非终态展开后才现身。
    for (const status of ['delivered', 'cancelled'] as const) {
      const w = mountDetail({ delivery: delivery({ status }), plan: { targets: [] } })
      expect(w.find('[data-testid="delivery-more-btn"]').exists(), status).toBe(false)
      expect(w.find('[data-testid="delivery-cancel-btn"]').exists(), status).toBe(false)
    }
    const w = mountDetail()
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    expect(w.find('[data-testid="delivery-cancel-btn"]').exists()).toBe(true)
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
    // 两个可达目标都渲染成推进按钮。
    expect(
      w.findAll('[data-testid^="delivery-advance-"]').map((b) => b.attributes('data-testid')),
    ).toEqual(['delivery-advance-verified', 'delivery-advance-integrating'])
    await w.find('[data-testid="delivery-advance-verified"]').trigger('click')
    // The verifying→verified target pops the confirmation dialog before writing.
    const dialogs = w.findAllComponents(ConfirmDialog)
    const open = dialogs.find((d) => d.props('open') === true)
    expect(open).toBeTruthy()
    open!.vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('transition')?.[0]).toEqual(['verified', true])
  })

  it('writes nothing when the verification confirmation is dismissed', async () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verifying', branchReady: true }),
      plan: { targets: [{ to: 'verified', humanAction: true, guard: 'satisfied', reasons: [] }] },
    })
    await w.find('[data-testid="delivery-advance-verified"]').trigger('click')
    const open = w.findAllComponents(ConfirmDialog).find((d) => d.props('open') === true)
    open!.vm.$emit('cancel')
    await w.vm.$nextTick()
    expect(w.emitted('transition')).toBeFalsy()
  })

  it('emits rework directly (no confirmation) for verifying → integrating', async () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verifying' }),
      plan: {
        targets: [
          // 挡住 verified 的是前置缺口(分支未就绪),不再是「未人工确认」——
          // 后者由点击时的确认弹窗满足,服务端计划不再把它算作缺口。
          {
            to: 'verified',
            humanAction: true,
            guard: 'failed',
            reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'branch' }],
          },
          { to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] },
        ],
      },
    })
    // 被挡的 verified 目标不渲染,只剩返工按钮。
    expect(w.find('[data-testid="delivery-advance-verified"]').exists()).toBe(false)
    await w.find('[data-testid="delivery-advance-integrating"]').trigger('click')
    expect(w.emitted('transition')?.[0]).toEqual(['integrating', false])
  })

  it('renders no verified button while a FRONT guard still blocks it', () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verifying', integration: { total: 2, merged: 1 } }),
      plan: {
        targets: [
          {
            to: 'verified',
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
          { to: 'integrating', humanAction: true, guard: 'satisfied', reasons: [] },
        ],
      },
    })
    expect(w.find('[data-testid="delivery-advance-verified"]').exists()).toBe(false)
    // 「为何推不动」由缺口横幅回答,且里面绝不出现「未人工确认」。
    expect(w.find('[data-testid="delivery-gap-delivery.guard.prsNotMerged"]').exists()).toBe(true)
    expect(
      w.find('[data-testid="delivery-gap-delivery.guard.verificationNotConfirmed"]').exists(),
    ).toBe(false)
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

  it('keeps the overview free of any status content', () => {
    const w = mountDetail()
    // 分段选择器整块退役,元信息也不再有「状态」行;状态只在标题栏。
    expect(w.find('[data-testid="delivery-selector"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-status-block"]').exists()).toBe(false)
    expect(w.findAll('[data-testid^="delivery-seg-"]').length).toBe(0)
    expect(w.find('[data-testid="delivery-meta-status"]').exists()).toBe(false)
    // 其余元信息行仍在。
    for (const row of ['base-branch', 'branch', 'start', 'end', 'pr', 'created', 'updated']) {
      expect(w.find(`[data-testid="delivery-meta-${row}"]`).exists(), row).toBe(true)
    }
  })

  it('passes a title click in the intents tab through as open-intent', async () => {
    const w = mount(DeliveryDetail, {
      props: {
        delivery: delivery(),
        plan: PLANNED_PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        deliveryBranchAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        associatedIntents: [
          {
            id: 'i1',
            title: 'Alpha',
            status: 'todo',
            prStatus: null,
            headBranch: null,
          },
        ],
        intents: [],
      },
    })
    await w.find('[data-testid="delivery-pane-tab-intents"]').trigger('click')
    expect(w.find('[data-testid="delivery-intents-tab"]').exists()).toBe(true)
    await w.find('[data-testid="delivery-intent-title-i1"]').trigger('click')
    expect(w.emitted('open-intent')?.[0]).toEqual(['i1'])
  })
})

// ---- 「…」溢出菜单 ------------------------------------------------------

describe('DeliveryDetail — 标题栏「…」溢出菜单', () => {
  it('非终态渲染入口,展开态经 aria-expanded 表达', async () => {
    const w = mountDetail()
    const entry = w.find('[data-testid="delivery-more-btn"]')
    expect(entry.exists()).toBe(true)
    expect(entry.attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)

    await entry.trigger('click')
    expect(w.find('[data-testid="delivery-more-btn"]').attributes('aria-expanded')).toBe('true')
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(true)
    // 菜单里目前只有「取消交付」一项(不新增删除等能力)。
    expect(w.findAll('[data-testid="delivery-more-menu"] button').length).toBe(1)
  })

  it('再次点击入口收起', async () => {
    const w = mountDetail()
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)
  })

  it('点击外部与 Esc 都收起', async () => {
    for (const dismiss of [
      () => document.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ]) {
      const w = mountDetail()
      await w.find('[data-testid="delivery-more-btn"]').trigger('click')
      expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(true)
      dismiss()
      await w.vm.$nextTick()
      expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)
      w.unmount()
    }
  })

  it('入口与菜单内的点击不冒到 document 上的收起监听(真实挂载)', async () => {
    // 默认 mount 不挂进 document,冒泡到不了收起监听 —— 这条得真挂上才测得到:
    // 少了 @click.stop,入口的这一下点击会立刻被 document 监听收回去,菜单永远打不开。
    const w = mount(DeliveryDetail, {
      attachTo: document.body,
      props: {
        delivery: delivery(),
        plan: PLANNED_PLAN,
        branchInit: null,
        workspaceGitBranchMode: 'worktree',
        mainlineAhead: null,
        syncPhase: null,
        deliveryPr: null,
        deliveryPrBusy: false,
        deliveryBranchAhead: null,
        associatedIntents: [],
        intents: [],
      },
    })
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(true)
    // 真实挂载下点页面别处(标题栏本身)才收起。
    await w.find('.delivery-detail-title').trigger('click')
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)
    w.unmount()
  })

  it('终态不渲染入口,菜单敞开期间转终态则一并收起', async () => {
    for (const status of ['delivered', 'cancelled'] as const) {
      const w = mountDetail({ delivery: delivery({ status }), plan: { targets: [] } })
      expect(w.find('[data-testid="delivery-more"]').exists(), status).toBe(false)
      expect(w.find('[data-testid="delivery-cancel-btn"]').exists(), status).toBe(false)
    }
    // 敞开着被广播推到终态:入口消失,菜单不留在空位上。
    const w = mountDetail()
    await w.find('[data-testid="delivery-more-btn"]').trigger('click')
    await w.setProps({ delivery: delivery({ status: 'cancelled' }), plan: { targets: [] } })
    expect(w.find('[data-testid="delivery-more"]').exists()).toBe(false)
    await w.setProps({ delivery: delivery({ status: 'planned' }), plan: PLANNED_PLAN })
    expect(w.find('[data-testid="delivery-more-menu"]').exists()).toBe(false)
  })
})

// ---- 推进按钮文案 ------------------------------------------------------

describe('DeliveryDetail — 推进按钮是动作文案,不是状态名', () => {
  const CASES = [
    { status: 'planned', to: 'integrating', key: 'delivery.action.startIntegrating.label' },
    { status: 'integrating', to: 'verifying', key: 'delivery.action.startVerifying.label' },
    { status: 'verifying', to: 'verified', key: 'delivery.action.confirmVerification.label' },
    { status: 'verifying', to: 'integrating', key: 'delivery.action.rework.label' },
  ] as const

  it('四条人工边各渲染自己的动作键,均不等于目标状态名', () => {
    const t = i18n.global.t as (key: string) => string
    for (const { status, to, key } of CASES) {
      const w = mountDetail({
        delivery: delivery({ status, branchReady: true, integration: { total: 1, merged: 1 } }),
        plan: { targets: [{ to, humanAction: true, guard: 'satisfied', reasons: [] }] },
      })
      const btn = w.find(`[data-testid="delivery-advance-${to}"]`)
      expect(btn.exists(), `${status}→${to}`).toBe(true)
      expect(btn.text(), `${status}→${to}`).toBe(t(key))
      // 徽标仍用状态名,按钮不再复用它。
      expect(btn.text(), `${status}→${to}`).not.toBe(t(DELIVERY_STATUS_LABEL_KEYS[to]))
    }
  })
})

// ---- 编辑弹窗 ----------------------------------------------------------

describe('DeliveryDetail — 交付编辑弹窗', () => {
  const EDITABLE = delivery({
    title: 'Sprint 3',
    description: 'ship the batch',
    startDate: Date.parse('2026-08-01T00:00:00Z'),
    endDate: Date.parse('2026-08-31T00:00:00Z'),
  })

  it('omits the edit button for terminal statuses, renders it for non-terminal', () => {
    for (const status of ['delivered', 'cancelled'] as const) {
      const w = mountDetail({ delivery: delivery({ status }), plan: { targets: [] } })
      expect(w.find('[data-testid="delivery-edit-btn"]').exists(), status).toBe(false)
    }
    // 非终态(planned)仍渲染编辑入口。
    expect(
      mountDetail({ delivery: EDITABLE }).find('[data-testid="delivery-edit-btn"]').exists(),
    ).toBe(true)
  })

  async function openEditor(w: ReturnType<typeof mountDetail>) {
    await w.find('[data-testid="delivery-edit-btn"]').trigger('click')
    return w
  }

  it('opens as a dialog prefilled with the delivery values (no inline form)', async () => {
    const w = await openEditor(mountDetail({ delivery: EDITABLE }))
    expect(w.find('[data-testid="delivery-edit-dialog"]').exists()).toBe(true)
    expect((w.find('[data-testid="delivery-edit-title"]').element as HTMLInputElement).value).toBe(
      'Sprint 3',
    )
    expect(
      (w.find('[data-testid="delivery-edit-desc"]').element as HTMLTextAreaElement).value,
    ).toBe('ship the batch')
    expect((w.find('[data-testid="delivery-edit-start"]').element as HTMLInputElement).value).toBe(
      '2026-08-01',
    )
    expect((w.find('[data-testid="delivery-edit-end"]').element as HTMLInputElement).value).toBe(
      '2026-08-31',
    )
  })

  it('does not render the editor until 「编辑」 is clicked', () => {
    const w = mountDetail({ delivery: EDITABLE })
    expect(w.find('[data-testid="delivery-edit-dialog"]').exists()).toBe(false)
  })

  it('disables save on an empty title and emits the full update payload otherwise', async () => {
    const w = await openEditor(mountDetail({ delivery: EDITABLE }))
    await w.find('[data-testid="delivery-edit-title"]').setValue('   ')
    expect(w.find('[data-testid="delivery-edit-save"]').attributes('disabled')).toBeDefined()

    await w.find('[data-testid="delivery-edit-title"]').setValue('Sprint 4')
    await w.find('[data-testid="delivery-edit-desc"]').setValue('next batch')
    await w.find('[data-testid="delivery-edit-start"]').setValue('2026-09-01')
    await w.find('[data-testid="delivery-edit-end"]').setValue('')
    await w.find('[data-testid="delivery-edit-save"]').trigger('click')

    expect(w.emitted('update')?.[0]).toEqual([
      {
        deliveryId: 'd1',
        title: 'Sprint 4',
        description: 'next batch',
        startDate: Date.parse('2026-09-01T00:00:00Z'),
        endDate: null,
      },
    ])
    expect(w.find('[data-testid="delivery-edit-dialog"]').exists()).toBe(false)
  })

  it('cancels via the cancel button, the overlay and Esc — none of which writes back', async () => {
    for (const dismiss of [
      (w: ReturnType<typeof mountDetail>) =>
        w.find('[data-testid="delivery-edit-cancel"]').trigger('click'),
      (w: ReturnType<typeof mountDetail>) =>
        w.find('[data-testid="delivery-edit-overlay"]').trigger('click'),
      (w: ReturnType<typeof mountDetail>) =>
        w.find('[data-testid="delivery-edit-overlay"]').trigger('keydown.esc'),
    ]) {
      const w = await openEditor(mountDetail({ delivery: EDITABLE }))
      await w.find('[data-testid="delivery-edit-title"]').setValue('draft')
      await dismiss(w)
      expect(w.emitted('update')).toBeFalsy()
      expect(w.find('[data-testid="delivery-edit-dialog"]').exists()).toBe(false)
    }
  })

  it('re-prefills from the delivery on reopen instead of keeping the last draft', async () => {
    const w = await openEditor(mountDetail({ delivery: EDITABLE }))
    await w.find('[data-testid="delivery-edit-title"]').setValue('draft never saved')
    await w.find('[data-testid="delivery-edit-cancel"]').trigger('click')
    await openEditor(w)
    expect((w.find('[data-testid="delivery-edit-title"]').element as HTMLInputElement).value).toBe(
      'Sprint 3',
    )
  })
})

// ---- 右栏铺满样式契约 --------------------------------------------------

// happy-dom 不计算布局,样式契约直接对组件源码里的 CSS 规则做断言。
const detailSrc = readFileSync(
  resolve(process.cwd(), 'web/src/pages/deliveries/components/DeliveryDetail/DeliveryDetail.vue'),
  'utf8',
)

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

const dialogSrc = readFileSync(
  resolve(
    process.cwd(),
    'web/src/pages/deliveries/components/DeliveryDetail/DeliveryEditDialog.vue',
  ),
  'utf8',
)

/** 组件里最后一个 `@media (max-width: 767px)` 块的规则体。 */
function mobileBlock(css: string): string {
  return /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
}

describe('DeliveryDetail.vue — 右栏铺满样式契约', () => {
  it('详情根容器吃掉右栏剩余宽度(flex:1 + min-width:0),镜像 .intent-detail', () => {
    const root = ruleBody(detailSrc, '.delivery-detail')
    expect(root).toMatch(/flex:\s*1/)
    expect(root).toMatch(/min-width:\s*0/)
    // 既有的高度约束保留。
    expect(root).toMatch(/min-height:\s*0/)
  })
})

describe('DeliveryDetail.vue — 标题栏样式契约', () => {
  it('桌面端:标题可截断但不再吃掉剩余宽度,空隙元素接手,动作组不被压扁', () => {
    const title = ruleBody(detailSrc, '.delivery-detail-title')
    expect(title).toMatch(/min-width:\s*0/)
    expect(title).toMatch(/text-overflow:\s*ellipsis/)
    // 徽标要紧贴标题——标题不能再有 flex:1。
    expect(title).not.toMatch(/flex:\s*1/)
    expect(ruleBody(detailSrc, '.delivery-head-spacer')).toMatch(/flex:\s*1/)
    expect(ruleBody(detailSrc, '.delivery-head-actions')).toMatch(/flex-shrink:\s*0/)
  })

  it('推进按钮有按钮感:实底填充 + hover + disabled,不是徽标那种透明底细描边', () => {
    const btn = ruleBody(detailSrc, '.delivery-advance-btn')
    expect(btn).toMatch(/background:\s*var\(--c-primary\)/)
    expect(btn).not.toMatch(/background:\s*transparent/)
    expect(btn).toMatch(/border:\s*1px solid/)
    expect(ruleBody(detailSrc, '.delivery-advance-btn:hover')).not.toBe('')
    expect(ruleBody(detailSrc, '.delivery-advance-btn:disabled')).toMatch(/opacity:/)
    // 返工保留虚线描边作区分,但同样是有实底的按钮。
    const rework = ruleBody(detailSrc, '.delivery-advance-btn.rework')
    expect(rework).toMatch(/dashed/)
    expect(rework).toMatch(/background:\s*var\(--c-input\)/)
  })

  it('「…」入口与菜单项具备按钮样式(底色/描边 + hover),菜单是有投影的浮层', () => {
    const entry = ruleBody(detailSrc, '.delivery-more-btn')
    expect(entry).toMatch(/background:\s*var\(--c-input\)/)
    expect(entry).toMatch(/border:\s*1px solid/)
    expect(entry).toMatch(/cursor:\s*pointer/)
    // hover 与展开态共用同一条加深规则。
    expect(detailSrc).toMatch(
      /\.delivery-more-btn:hover,\s*\n\s*\.delivery-more-btn\[aria-expanded='true'\]/,
    )

    const menu = ruleBody(detailSrc, '.delivery-more-menu')
    expect(menu).toMatch(/position:\s*absolute/)
    expect(menu).toMatch(/background:\s*var\(--c-panel\)/)
    expect(menu).toMatch(/box-shadow:\s*var\(--shadow-mid\)/)

    expect(ruleBody(detailSrc, '.delivery-more-item:hover')).toMatch(/background:/)
    // 危险项走危险色令牌(不再是写死的 #c53030 兜底)。
    expect(ruleBody(detailSrc, '.delivery-more-item.danger')).toMatch(
      /color:\s*var\(--c-error-text\)/,
    )
    // 取消按钮已退出标题栏直排。
    expect(detailSrc).not.toMatch(/\.delivery-cancel-btn/)
  })

  it('移动端:标题栏换行,动作组整体挤到第二行(不隐藏、不降级任何信息)', () => {
    const mobile = mobileBlock(detailSrc)
    expect(ruleBody(mobile, '.delivery-detail-head')).toMatch(/flex-wrap:\s*wrap/)
    expect(ruleBody(mobile, '.delivery-head-actions')).toMatch(/flex-basis:\s*100%/)
    // 移动端不隐藏 N/M 或推进按钮。
    expect(mobile).not.toMatch(/display:\s*none/)
  })
})

describe('DeliveryEditDialog.vue — 弹窗宽度契约', () => {
  it('桌面端默认宽度为页面宽度的二分之一,上下限只兜住极端视口', () => {
    const modal = ruleBody(dialogSrc, '.de-modal')
    expect(modal).toMatch(/width:\s*50vw/)
    expect(modal).toMatch(/min-width:\s*\d/)
    expect(modal).toMatch(/max-width:\s*\d/)
  })

  it('移动端退化为全屏 sheet,页脚按钮吸底', () => {
    const mobile = mobileBlock(dialogSrc)
    const modal = ruleBody(mobile, '.de-modal')
    expect(modal).toMatch(/width:\s*100vw/)
    expect(modal).toMatch(/max-width:\s*none/)
    expect(modal).toMatch(/min-height:\s*100dvh/)
    expect(ruleBody(mobile, '.de-foot')).toMatch(/margin-top:\s*auto/)
  })
})

// ---- 交付 PR 诊断块 -----------------------------------------------------

function pr(over: Partial<DeliveryPr> = {}): DeliveryPr {
  return {
    deliveryId: 'd1',
    forge: null,
    repo: 'owner/repo',
    number: '12',
    url: 'https://example.com/pr/12',
    headBranch: 'delivery/d1',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    status: 'merged',
    blockedReason: null,
    conflictFiles: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('DeliveryDetail — 交付 PR 诊断块', () => {
  it('renders the create button and NO diagnosis when verified + branch ready + no PR', () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verified', branchReady: true, branchName: 'delivery/d1' }),
      plan: { targets: [] },
      deliveryBranchAhead: 3,
    })
    expect(w.find('[data-testid="delivery-merge-block"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-create-pr-btn"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-pr-not-shown-diagnosis"]').exists()).toBe(false)
  })

  it('lists the five facts when the merge block renders without the create button', () => {
    const w = mountDetail({
      delivery: delivery({ status: 'delivered', branchReady: true, branchName: 'delivery/d1' }),
      plan: { targets: [] },
      deliveryPr: pr(),
      deliveryBranchAhead: 0,
    })
    const diag = w.find('[data-testid="delivery-pr-not-shown-diagnosis"]')
    expect(diag.exists()).toBe(true)
    // 五条事实逐行:分支模式 / 状态 / 分支就绪 / 交付 PR / 交付分支领先。
    expect(
      w.findAll('[data-testid^="delivery-pr-diagnosis-"]').map((f) => f.attributes('data-testid')),
    ).toEqual([
      'delivery-pr-diagnosis-branchMode',
      'delivery-pr-diagnosis-status',
      'delivery-pr-diagnosis-branch',
      'delivery-pr-diagnosis-pr',
      'delivery-pr-diagnosis-diff',
    ])
    expect(w.find('[data-testid="delivery-pr-diagnosis-branchMode"]').text()).toContain('Worktree')
    expect(w.find('[data-testid="delivery-pr-diagnosis-status"]').text()).toContain('Delivered')
    expect(w.find('[data-testid="delivery-pr-diagnosis-branch"]').text()).toContain('delivery/d1')
    expect(w.find('[data-testid="delivery-pr-diagnosis-pr"]').text()).toContain('#12')
    expect(w.find('[data-testid="delivery-pr-diagnosis-diff"]').text()).toContain('no difference')
  })

  it('renders the diagnosis alongside the merge block while verifying with a kept PR row', () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verifying', branchReady: true, branchName: 'delivery/d1' }),
      plan: { targets: [] },
      deliveryPr: pr({ status: 'reviewing' }),
      deliveryBranchAhead: 4,
    })
    // verifying + 保留 PR 行:合并区与诊断块都渲染,不加额外状态守卫。
    expect(w.find('[data-testid="delivery-merge-block"]').exists()).toBe(true)
    const diag = w.find('[data-testid="delivery-pr-not-shown-diagnosis"]')
    expect(diag.exists()).toBe(true)
    expect(w.find('[data-testid="delivery-pr-diagnosis-status"]').text()).toContain('Verifying')
    expect(w.find('[data-testid="delivery-pr-diagnosis-pr"]').text()).toContain('#12')
    expect(w.find('[data-testid="delivery-pr-diagnosis-pr"]').text()).toContain('Open')
    expect(w.find('[data-testid="delivery-pr-diagnosis-diff"]').text()).toContain('4 commit')
  })

  it('shows branch-not-ready and an undeterminable diff in the diagnostic lines', () => {
    const w = mountDetail({
      delivery: delivery({ status: 'verified', branchReady: false, branchName: null }),
      plan: { targets: [] },
      deliveryPr: pr({ status: 'reviewing' }),
      deliveryBranchAhead: null,
    })
    const diag = w.find('[data-testid="delivery-pr-not-shown-diagnosis"]')
    expect(diag.exists()).toBe(true)
    expect(w.find('[data-testid="delivery-pr-diagnosis-branch"]').text()).toContain('no')
    expect(w.find('[data-testid="delivery-pr-diagnosis-diff"]').text()).toContain('undeterminable')
  })

  it('omits the diagnosis block in current-branch mode (no merge block at all)', () => {
    const w = mountDetail({
      mode: 'current-branch',
      delivery: delivery({ status: 'verified', branchReady: true, branchName: 'delivery/d1' }),
      plan: { targets: [] },
    })
    expect(w.find('[data-testid="delivery-merge-block"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-pr-not-shown-diagnosis"]').exists()).toBe(false)
  })
})
