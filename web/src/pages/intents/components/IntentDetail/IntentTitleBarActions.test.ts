import { describe, expect, it } from 'vitest'
import { fakeIntentPr } from '@/lib/intent-pr-fixture'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
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

function mountActions(
  current: Intent,
  opts: {
    workspaceMainBranch?: string | null
    workspaceGitBranchMode?: 'worktree' | 'current-branch'
    intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
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
    expect(w.emitted('create-pr')).toEqual([['i1']])

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

describe('IntentTitleBarActions.vue — delivery association adds nothing here', () => {
  it('renders the SAME button set whether or not the intent is linked to a delivery', () => {
    const buttonsOf = (linked: Intent['linkedDeliveries']) =>
      mountActions(intent({ id: 'i1', status: 'in_progress', linkedDeliveries: linked }))
        .find('[data-testid="intent-detail-actions"]')
        .findAll('button')
        .map((b) => b.attributes('data-testid'))

    // 关联/解除只在交付详情页操作;意图详情页对此纯只读,标题栏一个按钮都不加。
    expect(buttonsOf([{ id: 'd1', title: 'Sprint 3' }])).toEqual(buttonsOf([]))
  })
})
