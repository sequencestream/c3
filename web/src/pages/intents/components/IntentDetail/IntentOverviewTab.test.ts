import { describe, expect, it } from 'vitest'
import { fakeIntentPr } from '@/lib/intent-pr-fixture'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import { i18n } from '@/i18n'
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
    baseBranch: 'main',
    baseBranchFallback: false,
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

function mountTab(
  current: Intent,
  opts: { intents?: Intent[]; intentActionErrorSeq?: number; sddEnabled?: boolean } = {},
) {
  return mount(IntentOverviewTab, {
    props: {
      intent: current,
      intents: opts.intents ?? [current],
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
      ...(opts.sddEnabled === undefined ? {} : { sddEnabled: opts.sddEnabled }),
    },
    global: { stubs: { MarkdownText: { template: '<div class="md" />' } } },
  })
}

const EDIT = '[data-testid="intent-detail-edit-content"]'
const TEXTAREA = '[data-testid="intent-detail-content-textarea"]'
const SAVE = '[data-testid="intent-detail-content-save"]'
const CANCEL = '[data-testid="intent-detail-content-cancel"]'
const SPEC_MODE_SELECT = '[data-testid="intent-meta-spec-mode-select"]'
const SPEC_MODE_DERIVED = '[data-testid="intent-meta-spec-mode-derived"]'
const SPEC_MODE_OFF_HINT = '[data-testid="intent-meta-spec-mode-off-hint"]'
const SPEC_MODE_READONLY = '[data-testid="intent-meta-spec-mode-readonly"]'
const SPEC_MODE_LOCKED_HINT = '[data-testid="intent-meta-spec-mode-locked-hint"]'
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
  it('renders meta fields in the stable order ID → spec mode → branch → base → PR → created → completed → updated → deps', () => {
    const current = intent({
      id: 'the-id',
      status: 'done',
      branchName: 'feature/x',
      baseBranch: 'delivery/alpha',
      latestCommitHash: 'abcdef1234',
      prs: [fakeIntentPr('reviewing', { number: '42', url: 'https://x/pull/42' })],
      completedAt: 5,
      dependsOn: ['dep1'],
      dependsOnTypes: { dep1: 'blocks' },
    })
    const w = mountTab(current, { intents: [current, intent({ id: 'dep1', title: 'Dep one' })] })
    const labels = w.findAll('.req-meta > .req-meta-item').map((el) => el.text())
    expect(labels).toHaveLength(9)
    expect(labels[0]).toContain('the-id')
    expect(w.findAll('.req-meta > .req-meta-item').at(1)!.attributes('data-testid')).toBe(
      'intent-meta-spec-mode',
    )
    expect(labels[2]).toContain('feature/x')
    expect(labels[2]).toContain('abcdef1')
    // 基准分支是持久快照,与开发分支并列展示,而不是从交付现算。
    expect(labels[3]).toContain('delivery/alpha')
    expect(w.find('[data-testid="intent-meta-base-branch"]').find('.req-meta-note').exists()).toBe(
      false,
    )
    expect(labels[4]).toContain('#42')
    expect(w.find('.req-meta-pr-link').attributes('href')).toBe('https://x/pull/42')
    expect(w.findAll('.req-meta > .req-meta-item').at(8)!.classes()).toContain(
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
    const w = mountTab(
      intent({ id: 'i1', status: 'done', prs: [fakeIntentPr('reviewing', { number: '5' })] }),
    )
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

describe('IntentOverviewTab — 关联交付 in the meta strip', () => {
  it('places 关联交付 AFTER branch+commit and BEFORE PR', () => {
    const w = mountTab(
      intent({
        id: 'r1',
        branchName: 'feat/x',
        latestCommitHash: 'abcdef1234',
        linkedDeliveries: [{ id: 'd1', title: 'Sprint 3' }],
        prs: [fakeIntentPr('reviewing', { intentId: 'r1', deliveryId: 'd1', number: '7' })],
      }),
    )
    const items = w.findAll('.req-meta > *')
    const html = items.map((n) => n.html())
    const branchAt = html.findIndex((h) => h.includes('feat/x'))
    const deliveryAt = html.findIndex((h) => h.includes('data-testid="intent-meta-delivery"'))
    const prAt = html.findIndex((h) => h.includes('data-testid="intent-meta-pr"'))

    expect(branchAt).toBeGreaterThanOrEqual(0)
    expect(deliveryAt).toBeGreaterThan(branchAt)
    expect(prAt).toBeGreaterThan(deliveryAt)
  })

  it('renders no 关联交付 row when the intent belongs to no delivery', () => {
    const w = mountTab(intent({ id: 'r1' }))
    expect(w.find('[data-testid="intent-meta-delivery"]').exists()).toBe(false)
  })

  it('emits open-delivery when a linked delivery is clicked', async () => {
    const w = mountTab(intent({ id: 'r1', linkedDeliveries: [{ id: 'd1', title: 'Sprint 3' }] }))
    await w.find('[data-testid="intent-meta-delivery-d1"]').trigger('click')
    expect(w.emitted('open-delivery')).toEqual([['d1']])
  })

  it('groups PRs by delivery, with the delivery-less ones in their own group', () => {
    const w = mountTab(
      intent({
        id: 'r1',
        linkedDeliveries: [{ id: 'd1', title: 'Sprint 3' }],
        prs: [
          fakeIntentPr('reviewing', { intentId: 'r1', deliveryId: 'd1', number: '7' }),
          fakeIntentPr('merged', { intentId: 'r1', deliveryId: null, number: '8' }),
        ],
      }),
    )
    const groups = w.findAll('.req-meta-pr-group').map((n) => n.text())
    expect(groups.length).toBe(2)
    expect(groups[0]).toBe('Sprint 3')
    // The second group is the delivery-less one; its copy comes from i18n.
    expect(groups[1]).not.toBe('Sprint 3')
  })

  it('shows no group labels for a single delivery-less PR (no noise in the common case)', () => {
    const w = mountTab(
      intent({
        id: 'r1',
        prs: [fakeIntentPr('merged', { intentId: 'r1', deliveryId: null, number: '8' })],
      }),
    )
    expect(w.findAll('.req-meta-pr-group').length).toBe(0)
  })
})

describe('IntentOverviewTab — 解除关联(自标题栏迁入元信息区)', () => {
  const SPRINT: Intent['linkedDeliveries'] = [{ id: 'd1', title: 'Sprint 3' }]
  const UNLINK = '[data-testid="intent-detail-unlink-delivery"]'

  it('恰好关联 1 个时,解除入口渲染在交付名之后', () => {
    const w = mountTab(intent({ id: 'r1', linkedDeliveries: SPRINT }))
    const row = w.find('[data-testid="intent-meta-delivery"]')
    const buttons = row.findAll('button').map((b) => b.attributes('data-testid'))
    expect(buttons).toEqual(['intent-meta-delivery-d1', 'intent-detail-unlink-delivery'])
  })

  it('多关联只展示交付名,不给解除路径(目标不唯一不给操作路径)', () => {
    const w = mountTab(
      intent({
        id: 'r1',
        linkedDeliveries: [
          { id: 'd1', title: 'Sprint 3' },
          { id: 'd2', title: 'Sprint 4' },
        ],
      }),
    )
    expect(w.find('[data-testid="intent-meta-delivery-d1"]').exists()).toBe(true)
    expect(w.find('[data-testid="intent-meta-delivery-d2"]').exists()).toBe(true)
    expect(w.find(UNLINK).exists()).toBe(false)
  })

  it('走 danger 二次确认,文案说明会关闭该交付下的 PR,确认后上抛', async () => {
    const w = mountTab(intent({ id: 'r1', linkedDeliveries: SPRINT }))
    await w.find(UNLINK).trigger('click')
    expect(w.emitted('unlink-delivery')).toBeUndefined()
    expect(w.find(CONFIRM_ACCEPT).classes()).toContain('danger')

    // 二次确认正文取意图侧自有文案,并把「会关闭 PR」这个副作用讲明白。
    const message = w.find('.cd-message').text()
    expect(message).toBe(i18n.global.t('intent.linkDelivery.unlink.confirm', { title: 'Sprint 3' }))
    expect(message).toContain('PR')

    await w.find(CONFIRM_ACCEPT).trigger('click')
    expect(w.emitted('unlink-delivery')).toEqual([['/proj', 'd1', 'r1']])
  })

  it('取消按钮 / 遮罩 / Esc 都不上抛', async () => {
    const w = mountTab(intent({ id: 'r1', linkedDeliveries: SPRINT }))
    for (const dismiss of [
      () => w.find(CONFIRM_CANCEL).trigger('click'),
      () => w.find(CONFIRM_OVERLAY).trigger('click'),
      () => w.find(CONFIRM_OVERLAY).trigger('keydown.esc'),
    ]) {
      await w.find(UNLINK).trigger('click')
      expect(w.find(CONFIRM_OVERLAY).exists()).toBe(true)
      await dismiss()
      expect(w.find(CONFIRM_OVERLAY).exists()).toBe(false)
      expect(w.emitted('unlink-delivery')).toBeUndefined()
    }
  })

  it('关联条数在确认框敞开期间被别处改掉时收框', async () => {
    const w = mountTab(intent({ id: 'r1', linkedDeliveries: SPRINT }))
    await w.find(UNLINK).trigger('click')
    expect(w.find(CONFIRM_OVERLAY).exists()).toBe(true)

    // 别的客户端解除了关联:确认框的前提已不成立,不该留着让用户对空气点确认。
    await w.setProps({ intent: intent({ id: 'r1', linkedDeliveries: [] }) })
    expect(w.find(CONFIRM_OVERLAY).exists()).toBe(false)
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

describe('IntentOverviewTab — 是否需要规范(每意图 specMode 覆盖)', () => {
  it('未显式设置时选中「继承工作区」并把服务端派生值作为副标展示', () => {
    for (const derived of ['sdd', 'fast'] as const) {
      const w = mountTab(intent({ id: 'r1', specMode: null, effectiveSpecMode: derived }))
      expect((w.find(SPEC_MODE_SELECT).element as HTMLSelectElement).value).toBe('inherit')
      const hint = w.find(SPEC_MODE_DERIVED)
      expect(hint.exists()).toBe(true)
      expect(hint.text()).toContain(i18n.global.t(`intent.meta.specMode.option.${derived}`))
    }
  })

  it('显式设置时选中该档,且不再展示「当前生效」副标(已无信息量)', () => {
    for (const mode of ['sdd', 'fast'] as const) {
      // 派生值故意与显式值相反,以证明选中态读的是 specMode 而不是 effectiveSpecMode。
      const w = mountTab(
        intent({ id: 'r1', specMode: mode, effectiveSpecMode: mode === 'sdd' ? 'fast' : 'sdd' }),
      )
      expect((w.find(SPEC_MODE_SELECT).element as HTMLSelectElement).value).toBe(mode)
      expect(w.find(SPEC_MODE_DERIVED).exists()).toBe(false)
    }
  })

  it('选择 sdd / fast 即 emit set-spec-mode,且不本地改选中值(等服务端广播回填)', async () => {
    for (const mode of ['sdd', 'fast'] as const) {
      const w = mountTab(intent({ id: 'r1', specMode: null, effectiveSpecMode: 'sdd' }))
      const select = w.find(SPEC_MODE_SELECT)
      await select.setValue(mode)
      expect(w.emitted('set-spec-mode')).toEqual([['r1', mode]])
      // props 未变 ⇒ 渲染值仍回到 inherit,不留一个服务端没确认过的假选中态。
      await w.setProps({ intent: intent({ id: 'r1', specMode: null, effectiveSpecMode: 'sdd' }) })
      expect((w.find(SPEC_MODE_SELECT).element as HTMLSelectElement).value).toBe('inherit')
    }
  })

  it('从显式档选回「继承工作区」emit null 以清除覆盖', async () => {
    const w = mountTab(intent({ id: 'r1', specMode: 'fast', effectiveSpecMode: 'fast' }))
    await w.find(SPEC_MODE_SELECT).setValue('inherit')
    expect(w.emitted('set-spec-mode')).toEqual([['r1', null]])
  })

  it('广播把派生值改掉后展示跟随(未显式设置的意图随工作区 sddEnabled 变化)', async () => {
    const w = mountTab(intent({ id: 'r1', specMode: null, effectiveSpecMode: 'sdd' }))
    expect(w.find(SPEC_MODE_DERIVED).text()).toContain(
      i18n.global.t('intent.meta.specMode.option.sdd'),
    )
    await w.setProps({ intent: intent({ id: 'r1', specMode: null, effectiveSpecMode: 'fast' }) })
    expect(w.find(SPEC_MODE_DERIVED).text()).toContain(
      i18n.global.t('intent.meta.specMode.option.fast'),
    )
  })

  it('已显式设置的意图不受工作区开关广播影响', async () => {
    const w = mountTab(intent({ id: 'r1', specMode: 'sdd', effectiveSpecMode: 'sdd' }))
    // sddEnabled 关掉后服务端仍把显式 sdd 解析成 sdd —— 显式覆盖不随工作区变。
    await w.setProps({ intent: intent({ id: 'r1', specMode: 'sdd', effectiveSpecMode: 'sdd' }) })
    expect((w.find(SPEC_MODE_SELECT).element as HTMLSelectElement).value).toBe('sdd')
  })

  it('sddEnabled=false:开关不隐藏、仍可设置,并附「当前无行为差异」提示', async () => {
    const w = mountTab(intent({ id: 'r1', specMode: null, effectiveSpecMode: 'fast' }), {
      sddEnabled: false,
    })
    const select = w.find(SPEC_MODE_SELECT)
    expect(select.exists()).toBe(true)
    expect(select.attributes('disabled')).toBeUndefined()
    expect(w.find(SPEC_MODE_OFF_HINT).exists()).toBe(true)
    await select.setValue('sdd')
    expect(w.emitted('set-spec-mode')).toEqual([['r1', 'sdd']])
  })

  it('sddEnabled=true 时不出现关闭提示', () => {
    const w = mountTab(intent({ id: 'r1' }), { sddEnabled: true })
    expect(w.find(SPEC_MODE_OFF_HINT).exists()).toBe(false)
  })

  it('五种语言都给出三档文案与关闭态提示', () => {
    for (const locale of ['en', 'zh', 'ja', 'ko', 'ru'] as const) {
      for (const key of ['inherit', 'sdd', 'fast'] as const) {
        expect(
          i18n.global.t(`intent.meta.specMode.option.${key}`, {}, { locale }),
          `${locale}/${key}`,
        ).toBeTruthy()
      }
      expect(i18n.global.t('intent.meta.specMode.workspaceOff', {}, { locale })).toBeTruthy()
      expect(i18n.global.t('intent.meta.specMode.derived', { mode: 'X' }, { locale })).toContain(
        'X',
      )
    }
  })
})

describe('IntentOverviewTab — specMode 在规范/开发已起步后锁定为只读', () => {
  /** 四类锁定信号,各自单独成立即应锁定(不靠彼此叠加)。 */
  const LOCK_CASES = [
    // specStatus 显式钉回 raw,以证明是路径本身在锁,而不是工厂顺带推出的 pending。
    { name: 'specPath 非空', patch: { specPath: 'doc/spec.md', specStatus: 'raw' as const } },
    { name: 'specStatus=pending', patch: { specStatus: 'pending' as const } },
    { name: 'specStatus=approved', patch: { specStatus: 'approved' as const } },
    { name: 'specSessionId 非空', patch: { specSessionId: 'spec-sess' } },
    { name: 'specReviewSessionId 非空', patch: { specReviewSessionId: 'review-sess' } },
    { name: 'lastWorkSessionId 非空', patch: { lastWorkSessionId: 'work-sess' } },
  ]

  it('每类锁定信号都收起下拉,改渲染只读文本,不附锁定提示', () => {
    for (const { name, patch } of LOCK_CASES) {
      const w = mountTab(intent({ id: 'r1', specMode: 'sdd', effectiveSpecMode: 'sdd', ...patch }))
      expect(w.find(SPEC_MODE_SELECT).exists(), name).toBe(false)
      expect(w.find(SPEC_MODE_READONLY).exists(), name).toBe(true)
      expect(w.find(SPEC_MODE_LOCKED_HINT).exists(), name).toBe(false)
    }
  })

  it('锁定态下显式覆盖展示对应档位文案', () => {
    for (const mode of ['sdd', 'fast'] as const) {
      const w = mountTab(
        intent({ id: 'r1', specMode: mode, effectiveSpecMode: mode, lastWorkSessionId: 'w1' }),
      )
      expect(w.find(SPEC_MODE_READONLY).text(), mode).toBe(
        i18n.global.t(`intent.meta.specMode.option.${mode}`),
      )
      // 显式覆盖时「当前生效」副标仍无信息量,不渲染。
      expect(w.find(SPEC_MODE_DERIVED).exists(), mode).toBe(false)
    }
  })

  it('锁定态下继承态展示「继承工作区」并保留服务端派生的「当前生效」副标', () => {
    for (const derived of ['sdd', 'fast'] as const) {
      const w = mountTab(
        intent({
          id: 'r1',
          specMode: null,
          effectiveSpecMode: derived,
          lastWorkSessionId: 'w1',
        }),
      )
      expect(w.find(SPEC_MODE_READONLY).text(), derived).toBe(
        i18n.global.t('intent.meta.specMode.option.inherit'),
      )
      const hint = w.find(SPEC_MODE_DERIVED)
      expect(hint.exists(), derived).toBe(true)
      // 生效值直读服务端的 effectiveSpecMode,前端不本地重算。
      expect(hint.text(), derived).toContain(
        i18n.global.t(`intent.meta.specMode.option.${derived}`),
      )
    }
  })

  it('已 merged 的意图进概览 Tab 即为只读态(经工作会话命中,不另设 PR 判据)', () => {
    const w = mountTab(
      intent({
        id: 'r1',
        specMode: 'sdd',
        effectiveSpecMode: 'sdd',
        lastWorkSessionId: 'work-sess',
        prs: [fakeIntentPr('merged', { number: '42', url: 'https://x/pull/42' })],
      }),
    )
    expect(w.find(SPEC_MODE_SELECT).exists()).toBe(false)
    expect(w.find(SPEC_MODE_READONLY).exists()).toBe(true)
    expect(w.find(SPEC_MODE_LOCKED_HINT).exists()).toBe(false)
  })

  it('锁定态下 sddEnabled=false 的「当前无行为差异」提示仍照常渲染', () => {
    const w = mountTab(
      intent({ id: 'r1', specMode: null, effectiveSpecMode: 'fast', lastWorkSessionId: 'w1' }),
      { sddEnabled: false },
    )
    expect(w.find(SPEC_MODE_OFF_HINT).exists()).toBe(true)
    expect(w.find(SPEC_MODE_LOCKED_HINT).exists()).toBe(false)
  })

  it('未起步的意图不显示锁定提示,下拉照常可用', () => {
    const w = mountTab(intent({ id: 'r1' }))
    expect(w.find(SPEC_MODE_SELECT).exists()).toBe(true)
    expect(w.find(SPEC_MODE_READONLY).exists()).toBe(false)
    expect(w.find(SPEC_MODE_LOCKED_HINT).exists()).toBe(false)
  })

  it('空白 specPath 不算规范内容,仍可编辑', () => {
    const w = mountTab(intent({ id: 'r1', specPath: '   ', specStatus: 'raw' }))
    expect(w.find(SPEC_MODE_SELECT).exists()).toBe(true)
    expect(w.find(SPEC_MODE_LOCKED_HINT).exists()).toBe(false)
  })

  it('五种语言服务端拒绝文案仍保留起步原因(概览不再渲染锁定提示)', () => {
    const locales = ['en', 'zh', 'ja', 'ko', 'ru'] as const
    const reasonPhrases: Record<(typeof locales)[number], RegExp> = {
      en: /already started/i,
      zh: /已.?起步/,
      ja: /始まって/,
      ko: /시작되었/,
      ru: /уже начат/i,
    }
    for (const locale of locales) {
      const rejected = String(i18n.global.t('error.intent.specModeLocked', {}, { locale }))
      expect(rejected, locale).toBeTruthy()
      expect(rejected, locale).toMatch(reasonPhrases[locale])
    }
  })
})
