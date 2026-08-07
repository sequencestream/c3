import { describe, expect, it } from 'vitest'
import { fakeIntentPr } from '@/lib/intent-pr-fixture'
import { mount } from '@vue/test-utils'
import type { Delivery, DeliveryStatus, Intent } from '@ccc/shared/protocol'
import { i18n } from '@/i18n'
import IntentTitleBarActions from './IntentTitleBarActions.vue'
import type { MainAction } from './useSpecApprovalGate'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'Start me',
    shortEnTitle: null,
    content: 'Do work',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    prs: [],
    linkedDeliveries: [],
    specPath: null,
    // 与迁移回填同口径:已批准→approved;有 spec 路径但未批准→pending;其余→raw。
    specStatus: overrides.specApproved ? 'approved' : overrides.specPath ? 'pending' : 'raw',
    specMode: null,
    effectiveSpecMode: 'sdd',
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
    id: overrides.id,
  }
}

function fakeDelivery(id: string, title: string, status: DeliveryStatus): Delivery {
  return {
    id,
    workspaceId: '/proj',
    title,
    description: '',
    status,
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { merged: 0, total: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function mountActions(
  current: Intent,
  opts: {
    workspaceMainBranch?: string | null
    workspaceGitBranchMode?: 'worktree' | 'current-branch'
    intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
    deliveries?: Delivery[]
    standaloneDeliveryPending?: boolean
    mainAction?: MainAction
    mainActionDisabled?: boolean
  } = {},
) {
  return mount(IntentTitleBarActions, {
    props: {
      intent: current,
      workspaceMainBranch: opts.workspaceMainBranch ?? null,
      workspaceGitBranchMode: opts.workspaceGitBranchMode,
      intentPrSync: opts.intentPrSync,
      deliveries: opts.deliveries,
      standaloneDeliveryPending: opts.standaloneDeliveryPending,
      mainAction: opts.mainAction ?? 'startDev',
      mainActionLabel: 'Start Work',
      mainActionDisabled: opts.mainActionDisabled ?? false,
      mainActionTitle: 'Start Work',
    },
  })
}

describe('IntentTitleBarActions.vue', () => {
  it('renders delete last and confirms exactly once through the danger dialog', async () => {
    const w = mountActions(intent({ id: 'i1', status: 'in_progress' }))
    expect(
      w
        .find('[data-testid="intent-detail-actions"]')
        .findAll('button')
        .at(-1)
        ?.attributes('data-testid'),
    ).toBe('intent-detail-delete')

    await w.find('[data-testid="intent-detail-delete"]').trigger('click')
    expect(w.find('[role="alertdialog"]').exists()).toBe(true)
    expect(w.find('[data-testid="confirm-accept"]').classes()).toContain('danger')
    // in_progress → 强化工作产物提示。
    expect(w.find('.cd-message').text()).toContain('work products')

    const accept = w.find('[data-testid="confirm-accept"]')
    await Promise.all([accept.trigger('click'), accept.trigger('click')])
    expect(w.emitted('delete')).toEqual([['i1']])
  })

  it('does not emit delete on cancel and omits the artifacts hint for todo', async () => {
    const w = mountActions(intent({ id: 'i1', status: 'todo' }))
    await w.find('[data-testid="intent-detail-delete"]').trigger('click')
    expect(w.find('.cd-message').text()).not.toContain('work products')
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(w.emitted('delete')).toBeUndefined()
  })

  it('hides delete for done and keeps it for every other status', () => {
    expect(
      mountActions(intent({ id: 'i1', status: 'done' }))
        .find('[data-testid="intent-detail-delete"]')
        .exists(),
    ).toBe(false)

    for (const status of ['draft', 'todo', 'in_progress', 'cancelled'] as const) {
      expect(
        mountActions(intent({ id: 'i1', status }))
          .find('[data-testid="intent-detail-delete"]')
          .exists(),
      ).toBe(true)
    }
  })

  it('drops the delete entry as soon as the intent turns done', async () => {
    const w = mountActions(intent({ id: 'i1', status: 'in_progress' }))
    expect(w.find('[data-testid="intent-detail-delete"]').exists()).toBe(true)

    await w.setProps({ intent: intent({ id: 'i1', status: 'done' }) })
    expect(w.find('[data-testid="intent-detail-delete"]').exists()).toBe(false)
    expect(w.find('[role="alertdialog"]').exists()).toBe(false)
    expect(w.emitted('delete')).toBeUndefined()
  })

  it('closes an open confirm dialog and refuses delete when the intent turns done mid-confirm', async () => {
    const w = mountActions(intent({ id: 'i1', status: 'in_progress' }))
    await w.find('[data-testid="intent-detail-delete"]').trigger('click')
    expect(w.find('[role="alertdialog"]').exists()).toBe(true)

    // 状态在确认框敞开时转 done:弹框应被主动收起,确认动作不得放行删除。
    await w.setProps({ intent: intent({ id: 'i1', status: 'done' }) })
    expect(w.find('[role="alertdialog"]').exists()).toBe(false)
    expect(w.find('[data-testid="confirm-accept"]').exists()).toBe(false)
    expect(w.emitted('delete')).toBeUndefined()
  })

  it('emits main-action on the primary button click without deciding the action itself', async () => {
    const w = mountActions(intent({ id: 'i1', status: 'todo' }))
    await w.find('.req-btn.primary').trigger('click')
    expect(w.emitted('main-action')).toEqual([[]])
  })

  it('reflects the four-state main action props (data-action / disabled)', () => {
    const w = mountActions(intent({ id: 'i1', status: 'todo' }), {
      mainAction: 'approveSpec',
      mainActionDisabled: true,
    })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('approveSpec')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the intent-modify button only without a work session and emits modify', async () => {
    const withWork = mountActions(intent({ id: 'i1', lastWorkSessionId: 'w1' }))
    expect(withWork.find('[data-testid="intent-detail-intent-modify"]').exists()).toBe(false)

    const w = mountActions(intent({ id: 'i1', lastWorkSessionId: null }))
    const modify = w.find('[data-testid="intent-detail-intent-modify"]')
    expect(modify.exists()).toBe(true)
    await modify.trigger('click')
    expect(w.emitted('modify')).toEqual([[]])
  })

  it('emits status transitions from mark-todo / back-to-draft / mark-done / cancel', async () => {
    const draft = mountActions(intent({ id: 'i1', status: 'draft' }))
    await draft.find('[data-testid="intent-detail-mark-todo"]').trigger('click')
    expect(draft.emitted('set-status')).toEqual([['i1', 'todo']])

    const todo = mountActions(intent({ id: 'i1', status: 'todo' }))
    await todo.find('[data-testid="intent-detail-back-to-draft"]').trigger('click')
    expect(todo.emitted('set-status')).toEqual([['i1', 'draft']])

    const running = mountActions(
      intent({ id: 'i1', status: 'in_progress', lastWorkSessionId: 'w1' }),
    )
    await running.find('[data-action="markDone"]').trigger('click')
    expect(running.emitted('set-status')).toEqual([['i1', 'done']])
  })

  it('hides both status buttons and shows no cancel for done/cancelled', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const w = mountActions(intent({ id: 'i1', status }))
      expect(w.find('[data-testid="intent-detail-mark-todo"]').exists()).toBe(false)
      expect(w.find('[data-testid="intent-detail-back-to-draft"]').exists()).toBe(false)
      expect(w.find('[data-action="markDone"]').exists()).toBe(false)
    }
  })

  it('hides mark-done until a work session exists', () => {
    const w = mountActions(intent({ id: 'i1', status: 'in_progress', lastWorkSessionId: null }))
    expect(w.find('[data-action="markDone"]').exists()).toBe(false)
  })

  it('shows create-pr only in worktree mode with branch/session/no-pr/non-main', async () => {
    const w = mountActions(
      intent({ id: 'i1', status: 'in_progress', branchName: 'feature/x', lastWorkSessionId: 'w1' }),
      { workspaceGitBranchMode: 'worktree' },
    )
    await w.find('[data-action="createPr"]').trigger('click')
    // No linked delivery → no delivery id: the PR targets the workspace mainline.
    expect(w.emitted('create-pr')).toEqual([['i1', undefined]])

    // current-branch mode / missing mode → hidden.
    expect(
      mountActions(
        intent({
          id: 'i1',
          status: 'in_progress',
          branchName: 'feature/x',
          lastWorkSessionId: 'w1',
        }),
        { workspaceGitBranchMode: 'current-branch' },
      )
        .find('[data-action="createPr"]')
        .exists(),
    ).toBe(false)
  })

  it('carries the single linked delivery id, and keys the active-PR guard on that pair', async () => {
    const linked = { id: 'd1', title: 'Sprint 3' }
    const base = {
      id: 'i1',
      status: 'in_progress' as const,
      branchName: 'feature/x',
      lastWorkSessionId: 'w1',
    }
    const w = mountActions(intent({ ...base, linkedDeliveries: [linked] }), {
      workspaceGitBranchMode: 'worktree',
    })
    await w.find('[data-action="createPr"]').trigger('click')
    expect(w.emitted('create-pr')).toEqual([['i1', 'd1']])

    // An active MAINLINE PR is a different pair — it must not hide the button.
    expect(
      mountActions(
        intent({
          ...base,
          linkedDeliveries: [linked],
          prs: [fakeIntentPr('reviewing', { number: '7', deliveryId: null })],
        }),
        { workspaceGitBranchMode: 'worktree' },
      )
        .find('[data-action="createPr"]')
        .exists(),
    ).toBe(true)

    // An active PR on the SAME pair does hide it.
    expect(
      mountActions(
        intent({
          ...base,
          linkedDeliveries: [linked],
          prs: [fakeIntentPr('reviewing', { number: '8', deliveryId: 'd1' })],
        }),
        { workspaceGitBranchMode: 'worktree' },
      )
        .find('[data-action="createPr"]')
        .exists(),
    ).toBe(false)
  })

  it('hides create-pr for a multi-linked intent (no unambiguous target)', () => {
    expect(
      mountActions(
        intent({
          id: 'i1',
          status: 'in_progress',
          branchName: 'feature/x',
          lastWorkSessionId: 'w1',
          linkedDeliveries: [
            { id: 'd1', title: 'A' },
            { id: 'd2', title: 'B' },
          ],
        }),
        { workspaceGitBranchMode: 'worktree' },
      )
        .find('[data-action="createPr"]')
        .exists(),
    ).toBe(false)
  })

  it('renders the PR link as an anchor to the PR url, else a copy button', () => {
    const anchor = mountActions(
      intent({
        id: 'i1',
        status: 'in_progress',
        prs: [fakeIntentPr('reviewing', { number: '42', url: 'https://x/pull/42' })],
      }),
    )
    expect(anchor.find('a.req-btn.pr-link').attributes('href')).toBe('https://x/pull/42')

    const copy = mountActions(
      intent({
        id: 'i1',
        status: 'in_progress',
        prs: [fakeIntentPr('reviewing', { number: '42', url: null })],
      }),
    )
    expect(copy.find('a.req-btn.pr-link').exists()).toBe(false)
    expect(copy.find('button.req-btn.pr-link').exists()).toBe(true)
  })

  it('shows sync only for done+reviewing+PR, guards double send while syncing', async () => {
    const w = mountActions(
      intent({ id: 'i1', status: 'done', prs: [fakeIntentPr('reviewing', { number: '5' })] }),
    )
    await w.find('[data-action="syncPrStatus"]').trigger('click')
    expect(w.emitted('sync-pr-status')).toEqual([['i1']])

    const syncing = mountActions(
      intent({ id: 'i1', status: 'done', prs: [fakeIntentPr('reviewing', { number: '5' })] }),
      {
        intentPrSync: { i1: { state: 'syncing', message: 'Syncing...' } },
      },
    )
    expect(syncing.find('[data-action="syncPrStatus"]').attributes('disabled')).toBeDefined()
    await syncing.find('[data-action="syncPrStatus"]').trigger('click')
    expect(syncing.emitted('sync-pr-status')).toBeUndefined()
  })

  it('emits share and toggles automate against the current flag', async () => {
    const w = mountActions(intent({ id: 'i1', automate: false }))
    await w.find('[data-testid="share-button"]').trigger('click')
    expect(w.emitted('share')).toEqual([['i1']])
    await w.find('.req-automate').trigger('click')
    expect(w.emitted('set-automate')).toEqual([['i1', true]])
  })
})

describe('IntentTitleBarActions.vue — 交付归属入口(三态)', () => {
  const SPRINT: Intent['linkedDeliveries'] = [{ id: 'd1', title: 'Sprint 3' }]

  it('未关联时给出「关联交付」,点击先请控制层补拉列表再开弹窗', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: [] }))
    expect(w.find('[data-testid="intent-detail-unlink-delivery"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-link-delivery-overlay"]').exists()).toBe(false)

    await w.find('[data-testid="intent-detail-link-delivery"]').trigger('click')
    // 意图页从不自带交付列表,开框必须同时请控制层补发 list_deliveries。
    expect(w.emitted('open-link-dialog')).toEqual([['/proj']])
    expect(w.find('[data-testid="intent-link-delivery-overlay"]').exists()).toBe(true)
  })

  it('恰好关联一个时展示交付名(可跳转)与「解除关联」,不再给关联入口', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: SPRINT }))
    expect(w.find('[data-testid="intent-detail-link-delivery"]').exists()).toBe(false)

    const link = w.find('[data-testid="intent-detail-delivery-d1"]')
    expect(link.text()).toBe('Sprint 3')
    await link.trigger('click')
    expect(w.emitted('open-delivery')).toEqual([['d1']])
    expect(w.find('[data-testid="intent-detail-unlink-delivery"]').exists()).toBe(true)
  })

  it('多关联只展示,既无关联也无解除入口(与不渲染建 PR 入口同一条裁决)', () => {
    const w = mountActions(
      intent({
        id: 'i1',
        linkedDeliveries: [
          { id: 'd1', title: 'Sprint 3' },
          { id: 'd2', title: 'Sprint 4' },
        ],
      }),
    )
    expect(w.find('[data-testid="intent-detail-delivery-d1"]').exists()).toBe(true)
    expect(w.find('[data-testid="intent-detail-delivery-d2"]').exists()).toBe(true)
    expect(w.find('[data-testid="intent-detail-link-delivery"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-detail-unlink-delivery"]').exists()).toBe(false)
  })

  it('弹窗候选只含未终态交付,选中确认后带全量 id 上抛', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: [] }), {
      deliveries: [
        fakeDelivery('d1', 'Planned one', 'planned'),
        fakeDelivery('d2', 'Integrating one', 'integrating'),
        fakeDelivery('d3', 'Verifying one', 'verifying'),
        fakeDelivery('d4', 'Verified one', 'verified'),
        fakeDelivery('d5', 'Delivered one', 'delivered'),
        fakeDelivery('d6', 'Cancelled one', 'cancelled'),
      ],
    })
    await w.find('[data-testid="intent-detail-link-delivery"]').trigger('click')

    const options = w.findAll('#intent-link-delivery-select option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['d1', 'd2', 'd3', 'd4'])

    await w.find('#intent-link-delivery-select').setValue('d3')
    await w.find('[data-testid="intent-link-delivery-confirm"]').trigger('click')
    expect(w.emitted('link-delivery')).toEqual([['/proj', 'd3', 'i1']])
    // 关联发出即收框,避免对着已提交的选择再点一次。
    expect(w.find('[data-testid="intent-link-delivery-overlay"]').exists()).toBe(false)
  })

  it('没有可关联交付时弹窗给空态而不是一个空下拉', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: [] }), {
      deliveries: [fakeDelivery('d5', 'Delivered one', 'delivered')],
    })
    await w.find('[data-testid="intent-detail-link-delivery"]').trigger('click')
    expect(w.find('#intent-link-delivery-select').exists()).toBe(false)
    expect(w.find('[data-testid="intent-link-delivery-empty"]').exists()).toBe(true)
  })

  it('「当前意图独立交付」仅 worktree 模式渲染,并带意图标题/正文上抛', async () => {
    const current = mountActions(intent({ id: 'i1', linkedDeliveries: [] }), {
      workspaceGitBranchMode: 'current-branch',
    })
    await current.find('[data-testid="intent-detail-link-delivery"]').trigger('click')
    // current-branch 模式下交付侧本就没有分支初始化/交付 PR 入口,一键创建到不了目的。
    expect(current.find('[data-testid="intent-link-delivery-standalone"]').exists()).toBe(false)

    const w = mountActions(
      intent({
        id: 'i1',
        title: 'Fix login',
        content: 'Login breaks on retry',
        linkedDeliveries: [],
      }),
      { workspaceGitBranchMode: 'worktree' },
    )
    await w.find('[data-testid="intent-detail-link-delivery"]').trigger('click')
    await w.find('[data-testid="intent-link-delivery-standalone"]').trigger('click')
    expect(w.emitted('standalone-delivery')).toEqual([
      [
        {
          workspaceId: '/proj',
          intentId: 'i1',
          title: 'Fix login',
          description: 'Login breaks on retry',
        },
      ],
    ])
  })

  it('独立交付在飞行中时按钮禁用,点击不再上抛(防双发)', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: [] }), {
      workspaceGitBranchMode: 'worktree',
      standaloneDeliveryPending: true,
    })
    await w.find('[data-testid="intent-detail-link-delivery"]').trigger('click')
    const btn = w.find('[data-testid="intent-link-delivery-standalone"]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(w.emitted('standalone-delivery')).toBeUndefined()
  })

  it('解除关联走 danger 二次确认,文案说明会关闭该交付下的 PR', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: SPRINT }))
    await w.find('[data-testid="intent-detail-unlink-delivery"]').trigger('click')
    expect(w.emitted('unlink-delivery')).toBeUndefined()

    // 二次确认正文取意图侧自有文案,并把「会关闭 PR」这个副作用讲明白。
    const message = w.find('.cd-message').text()
    expect(message).toBe(i18n.global.t('intent.linkDelivery.unlink.confirm', { title: 'Sprint 3' }))
    expect(message).toContain('PR')

    await w.find('.cd-confirm').trigger('click')
    expect(w.emitted('unlink-delivery')).toEqual([['/proj', 'd1', 'i1']])
  })

  it('关联在弹框敞开期间被别处改掉时收起对应弹框', async () => {
    const w = mountActions(intent({ id: 'i1', linkedDeliveries: SPRINT }))
    await w.find('[data-testid="intent-detail-unlink-delivery"]').trigger('click')
    expect(w.find('.cd-message').exists()).toBe(true)

    // 别的客户端解除了关联:确认框的前提已不成立,不该留着让用户对空气点确认。
    await w.setProps({ intent: intent({ id: 'i1', linkedDeliveries: [] }) })
    expect(w.find('.cd-message').exists()).toBe(false)
  })
})

describe('五语言解除文案', () => {
  // 「会关闭 PR」是解除关联唯一的不可逆副作用,任何一门语言漏讲都等于让用户在
  // 不知情下确认 —— 因此这条按 key 逐语言守住,不随译文润色而放松。
  it('每种语言的解除确认都点明 PR 会被关闭', () => {
    for (const locale of ['en', 'zh', 'ja', 'ko', 'ru'] as const) {
      const copy = i18n.global.t('intent.linkDelivery.unlink.confirm', { title: 'X' }, { locale })
      expect(copy, locale).toContain('PR')
      expect(copy, locale).toContain('X')
    }
  })
})
