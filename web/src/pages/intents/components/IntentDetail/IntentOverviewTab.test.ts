import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import IntentOverviewTab from './IntentOverviewTab.vue'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'T',
    shortEnTitle: null,
    content: 'Body',
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
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    // 与迁移回填同口径:已批准→approved;有 spec 路径但未批准→pending;其余→raw。
    specStatus: overrides.specApproved ? 'approved' : overrides.specPath ? 'pending' : 'raw',
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

function mountTab(
  current: Intent,
  opts: { intents?: Intent[]; intentActionErrorSeq?: number } = {},
) {
  return mount(IntentOverviewTab, {
    props: {
      intent: current,
      intents: opts.intents ?? [current],
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
    },
    global: { stubs: { MarkdownText: { template: '<div class="md" />' } } },
  })
}

const EDIT = '[data-testid="intent-detail-edit-content"]'
const TEXTAREA = '[data-testid="intent-detail-content-textarea"]'
const SAVE = '[data-testid="intent-detail-content-save"]'
const CANCEL = '[data-testid="intent-detail-content-cancel"]'
const DEP_DELETE = '[data-testid="dep-edit-delete"]'
const CONFIRM_OVERLAY = '[data-testid="confirm-overlay"]'
const CONFIRM_ACCEPT = '[data-testid="confirm-accept"]'
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]'

function depEditFixture() {
  const current = intent({
    id: 'current',
    dependsOn: ['first', 'second'],
    dependsOnTypes: { first: 'blocks', second: 'informs' },
  })
  return {
    current,
    intents: [
      current,
      intent({ id: 'first', title: 'First' }),
      intent({ id: 'second', title: 'Second' }),
    ],
  }
}

describe('IntentOverviewTab.vue', () => {
  it('renders meta fields in the stable order ID → branch → PR → created → completed → updated → deps', () => {
    const current = intent({
      id: 'the-id',
      status: 'done',
      branchName: 'feature/x',
      latestCommitHash: 'abcdef1234',
      prId: '42',
      prUrl: 'https://x/pull/42',
      prStatus: 'reviewing',
      completedAt: 5,
      dependsOn: ['dep1'],
      dependsOnTypes: { dep1: 'blocks' },
    })
    const w = mountTab(current, { intents: [current, intent({ id: 'dep1', title: 'Dep one' })] })
    const labels = w.findAll('.req-meta > .req-meta-item').map((el) => el.text())
    expect(labels).toHaveLength(7)
    expect(labels[0]).toContain('the-id')
    expect(labels[1]).toContain('feature/x')
    expect(labels[1]).toContain('abcdef1')
    expect(labels[2]).toContain('#42')
    expect(w.find('.req-meta-pr-link').attributes('href')).toBe('https://x/pull/42')
    expect(w.findAll('.req-meta > .req-meta-item').at(6)!.classes()).toContain(
      'req-meta-dependencies',
    )
  })

  it('shows the Edit entry only for draft/todo and runs the save/cancel lifecycle', async () => {
    for (const status of ['in_progress', 'done', 'cancelled'] as const) {
      expect(
        mountTab(intent({ id: 'i', status }))
          .find(EDIT)
          .exists(),
      ).toBe(false)
    }
    const w = mountTab(intent({ id: 'i1', status: 'todo', content: 'original' }))
    await w.find(EDIT).trigger('click')
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('original')

    await w.find(TEXTAREA).setValue('edited')
    await w.find(SAVE).trigger('click')
    expect(w.emitted('save-intent-content')).toEqual([['i1', 'edited']])
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)

    // updatedAt bump → 退出编辑态。
    await w.setProps({
      intent: intent({ id: 'i1', status: 'todo', content: 'edited', updatedAt: 2 }),
    })
    expect(w.find(TEXTAREA).exists()).toBe(false)
  })

  it('cancel discards the draft; error seq releases the guard but keeps the editor', async () => {
    const w = mountTab(intent({ id: 'i1', status: 'todo', content: 'orig' }))
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('scrapped')
    await w.find(CANCEL).trigger('click')
    expect(w.find(TEXTAREA).exists()).toBe(false)
    await w.find(EDIT).trigger('click')
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('orig')

    await w.find(TEXTAREA).setValue('again')
    await w.find(SAVE).trigger('click')
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)
    await w.setProps({ intentActionErrorSeq: 1 })
    expect(w.find(TEXTAREA).exists()).toBe(true)
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(false)
  })

  it('emits refine, select-dependency, and one edited dep type within the full group', async () => {
    const current = intent({
      id: 'current',
      dependsOn: ['first', 'second'],
      dependsOnTypes: { first: 'blocks', second: 'informs' },
    })
    const w = mountTab(current, {
      intents: [
        current,
        intent({ id: 'first', title: 'First' }),
        intent({ id: 'second', title: 'Second' }),
      ],
    })
    // refine 是 section-actions 内的第一个动作(todo 下 refine 在前、editContent 在后)。
    await w.findAll('.intent-detail-section-actions .req-btn')[0].trigger('click')
    expect(w.emitted('refine')).toEqual([['current']])

    await w.find('.req-dependency-title').trigger('click')
    expect(w.emitted('select-dependency')).toEqual([['first']])

    await w.findAll('.req-dep-edit-btn')[1].trigger('click')
    await w.find('.dep-edit-select').setValue('soft_after')
    await w.find('.dep-edit-save').trigger('click')
    expect(w.emitted('update-deps')).toEqual([
      [
        'current',
        [
          { dependsOnId: 'first', depType: 'blocks' },
          { dependsOnId: 'second', depType: 'soft_after' },
        ],
      ],
    ])
  })

  it('shows the meta PR sync button for done reviewing PRs and emits sync-pr-status', async () => {
    const w = mountTab(intent({ id: 'i1', status: 'done', prId: '5', prStatus: 'reviewing' }))
    await w.find('.req-pr-sync-btn').trigger('click')
    expect(w.emitted('sync-pr-status')).toEqual([['i1']])
  })

  it('delete dep: danger ConfirmDialog above the edit modal; confirm emits remaining deps once and closes both layers', async () => {
    const { current, intents } = depEditFixture()
    const w = mountTab(current, { intents })
    await w.findAll('.req-dep-edit-btn')[1].trigger('click') // 编辑 second
    expect(w.find(CONFIRM_OVERLAY).exists()).toBe(false)

    await w.find(DEP_DELETE).trigger('click')
    const overlay = w.find(CONFIRM_OVERLAY)
    expect(overlay.exists()).toBe(true)
    // 层叠:确认层渲染在 dep-edit-overlay 子树内,借其 z-index: 1000 层叠上下文盖住编辑弹窗。
    expect(overlay.element.closest('.dep-edit-overlay')).not.toBeNull()
    // 正文含被删依赖标题,确认按钮为危险色。
    expect(overlay.text()).toContain('Second')
    expect(w.find(CONFIRM_ACCEPT).classes()).toContain('danger')
    expect(w.emitted('update-deps')).toBeUndefined()

    await w.find(CONFIRM_ACCEPT).trigger('click')
    expect(w.emitted('update-deps')).toEqual([
      ['current', [{ dependsOnId: 'first', depType: 'blocks' }]],
    ])
    expect(w.find(CONFIRM_OVERLAY).exists()).toBe(false)
    expect(w.find('.dep-edit-overlay').exists()).toBe(false)
  })

  it('deleting the only dep emits an empty dep set and closes the edit modal', async () => {
    const current = intent({
      id: 'current',
      dependsOn: ['only'],
      dependsOnTypes: { only: 'blocks' },
    })
    const w = mountTab(current, { intents: [current, intent({ id: 'only', title: 'Only' })] })
    await w.find('.req-dep-edit-btn').trigger('click')
    await w.find(DEP_DELETE).trigger('click')
    await w.find(CONFIRM_ACCEPT).trigger('click')
    expect(w.emitted('update-deps')).toEqual([['current', []]])
    expect(w.find('.dep-edit-overlay').exists()).toBe(false)
  })

  it('delete cancel via cancel button / mask / Esc keeps the edit modal, the dep and the unsaved type', async () => {
    const { current, intents } = depEditFixture()
    const w = mountTab(current, { intents })
    await w.findAll('.req-dep-edit-btn')[1].trigger('click')
    await w.find('.dep-edit-select').setValue('soft_after')

    for (const cancel of [
      () => w.find(CONFIRM_CANCEL).trigger('click'),
      () => w.find(CONFIRM_OVERLAY).trigger('click'),
      () => w.find(CONFIRM_OVERLAY).trigger('keydown.esc'),
    ]) {
      await w.find(DEP_DELETE).trigger('click')
      expect(w.find(CONFIRM_OVERLAY).exists()).toBe(true)
      await cancel()
      expect(w.emitted('update-deps')).toBeUndefined()
      expect(w.find(CONFIRM_OVERLAY).exists()).toBe(false)
      // 编辑弹窗仍在,目标依赖与未保存的类型选择保持原样。
      expect(w.find('.dep-edit-overlay').exists()).toBe(true)
      expect(w.find('.dep-edit-dep-title').text()).toBe('Second')
      expect((w.find('.dep-edit-select').element as HTMLSelectElement).value).toBe('soft_after')
    }

    // 取消不丢编辑态:保存仍整组回写(含未保存的类型修改)。
    await w.find('.dep-edit-save').trigger('click')
    expect(w.emitted('update-deps')).toEqual([
      [
        'current',
        [
          { dependsOnId: 'first', depType: 'blocks' },
          { dependsOnId: 'second', depType: 'soft_after' },
        ],
      ],
    ])
  })

  it('delete confirm message falls back to the dep id when no intent title resolves', async () => {
    const current = intent({ id: 'current', dependsOn: ['ghost'], dependsOnTypes: {} })
    // intents 只含 current:ghost 解析不到标题,回退显示 id。
    const w = mountTab(current)
    await w.find('.req-dep-edit-btn').trigger('click')
    await w.find(DEP_DELETE).trigger('click')
    expect(w.find(CONFIRM_OVERLAY).text()).toContain('ghost')
    await w.find(CONFIRM_ACCEPT).trigger('click')
    expect(w.emitted('update-deps')).toEqual([['current', []]])
  })

  it('after delete, broadcast backfill hides the deps meta block and the unfinished hint', async () => {
    const current = intent({
      id: 'current',
      dependsOn: ['first'],
      dependsOnTypes: { first: 'blocks' },
    })
    const first = intent({ id: 'first', title: 'First' })
    const w = mountTab(current, { intents: [current, first] })
    expect(w.find('.req-meta-dependencies').exists()).toBe(true)
    expect(w.find('.req-deps').exists()).toBe(true) // first 非 done → 未完成依赖提示

    await w.find('.req-dep-edit-btn').trigger('click')
    await w.find(DEP_DELETE).trigger('click')
    await w.find(CONFIRM_ACCEPT).trigger('click')
    expect(w.emitted('update-deps')).toEqual([['current', []]])

    // 服务端全量替换后广播回填:dependsOn 为空。
    const backfilled = intent({ id: 'current', dependsOn: [], updatedAt: 2 })
    await w.setProps({ intent: backfilled, intents: [backfilled, first] })
    expect(w.find('.req-meta-dependencies').exists()).toBe(false)
    expect(w.find('.req-deps').exists()).toBe(false)
  })
})
