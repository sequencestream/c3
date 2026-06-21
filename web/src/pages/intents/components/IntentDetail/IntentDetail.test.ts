import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Intent } from '@ccc/shared/protocol'
import IntentDetail, { __resetWriteSpecGuards } from './IntentDetail.vue'

// 模块级防误审门状态在用例间共享 → 每个用例前清空,避免相互污染。
beforeEach(() => {
  __resetWriteSpecGuards()
})

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
    lastDevSessionId: null,
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
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    intentSessionId: null,
    ...overrides,
    id: overrides.id,
  }
}

// All non-chat props default to an inert chat column; tests override per case.
function mountDetail(
  current: Intent | null,
  opts: {
    intents?: Intent[]
    intentActionErrorSeq?: number
    sddEnabled?: boolean
    workspaceMainBranch?: string | null
    activeSession?: string | null
    intentSpecContent?: string | null
    intentSpecLoading?: boolean
  } = {},
) {
  return mount(IntentDetail, {
    props: {
      intent: current,
      intents: opts.intents ?? (current ? [current] : []),
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
      sddEnabled: opts.sddEnabled ?? false,
      workspaceMainBranch: opts.workspaceMainBranch ?? null,
      activeSession: opts.activeSession ?? null,
      activeTitle: 'Title',
      vendor: null,
      agentSwitch: null,
      hasActiveSession: opts.activeSession != null,
      messages: [],
      actionablePermissionId: null,
      taskModel: { tasks: [] },
      hasTaskStore: true,
      running: false,
      teamActive: false,
      connection: 'open' as const,
      activity: { phase: 'idle' as const },
      queue: [],
      availableCommands: [],
      voiceLang: 'en-US',
      intentSpecContent: opts.intentSpecContent ?? null,
      intentSpecLoading: opts.intentSpecLoading ?? false,
    },
    global: {
      // Keep the chat column inert: we test IntentDetail's tab/gate logic, not it.
      stubs: { ChatColumn: { template: '<div data-testid="intent-detail-chat" />' } },
    },
  })
}

describe('IntentDetail.vue — empty state', () => {
  it('renders the empty placeholder when no intent is selected', () => {
    const w = mountDetail(null)
    expect(w.find('[data-testid="intent-detail-empty"]').exists()).toBe(true)
  })
})

describe('IntentDetail.vue — persistent header', () => {
  it('shows title metadata and right-side actions on every tab', async () => {
    const item = intent({
      id: 'i1',
      title: 'My intent',
      module: 'billing',
      priority: 'P0',
      status: 'todo',
      runStatus: 'running',
    })
    const w = mountDetail(item)
    expect(w.find('.intent-detail-title').text()).toBe('My intent')
    expect(w.find('.intent-detail-title-main .req-module').text()).toBe('billing')
    expect(w.find('.intent-detail-title-main .req-priority').text()).toBe('P0')
    expect(w.find('.intent-detail-title-main .req-status').text()).toBeTruthy()
    expect(w.find('.intent-detail-title-meta [data-testid="intent-detail-actions"]').exists()).toBe(
      true,
    )
    expect(w.find('.intent-detail-head .req-date').exists()).toBe(false)
    expect(w.find('.intent-detail-head .req-run-status').exists()).toBe(false)

    // Switch to the spec tab — header (title + actions) stays put.
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(w.find('.intent-detail-title').text()).toBe('My intent')
    expect(w.find('.intent-detail-title-meta [data-testid="intent-detail-actions"]').exists()).toBe(
      true,
    )
  })
})

describe('IntentDetail.vue — start dev in-flight guard', () => {
  it('disables immediately and emits one start-dev on rapid double click', async () => {
    const item = intent({ id: 'intent-1' })
    const w = mountDetail(item)
    const start = w.find('.req-btn.primary')

    await start.trigger('click')
    await start.trigger('click')

    expect(w.emitted('start-dev')).toEqual([['intent-1', false]])
    expect((start.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('restores the button when status changes or an intent error arrives', async () => {
    const item = intent({ id: 'intent-1' })
    const w = mountDetail(item)

    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intent: { ...item, status: 'in_progress' }, intents: [item] })
    expect(w.find('.req-btn.primary').exists()).toBe(false)

    await w.setProps({ intent: item, intents: [item] })
    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intentActionErrorSeq: 1 })
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not enter in-flight when unfinished dependency confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const dep = intent({ id: 'dep', status: 'in_progress', title: 'Dependency' })
    const child = intent({ id: 'child', dependsOn: ['dep'] })
    const w = mountDetail(child, { intents: [dep, child] })

    await w.find('.req-btn.primary').trigger('click')

    expect(w.emitted('start-dev')).toBeUndefined()
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('IntentDetail.vue — SDD four-state main action', () => {
  it('SDD off → Start Dev (regardless of spec fields)', () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specApproved: false })
    const w = mountDetail(item, { sddEnabled: false })
    expect(w.find('.req-btn.primary').attributes('data-action')).toBe('startDev')
  })

  it('SDD on + no spec → Write Spec, emits write-spec', async () => {
    const item = intent({ id: 'i1', specPath: null })
    const w = mountDetail(item, { sddEnabled: true })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('writeSpec')
    await btn.trigger('click')
    expect(w.emitted('write-spec')).toEqual([['i1']])
  })

  it('SDD on + spec written, not approved → Approve Spec, emits approve-spec', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specApproved: false })
    const w = mountDetail(item, { sddEnabled: true })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('approveSpec')
    await btn.trigger('click')
    expect(w.emitted('approve-spec')).toEqual([['i1']])
  })

  it('SDD on + spec approved → Start Dev, emits start-dev', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specApproved: true })
    const w = mountDetail(item, { sddEnabled: true })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('startDev')
    await btn.trigger('click')
    expect(w.emitted('start-dev')).toEqual([['i1', false]])
  })
})

describe('IntentDetail.vue — spec action guidance (auto-switch + approve gate + colors)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writeSpec: switches to the spec session tab after ~1s and opens the session', async () => {
    const item = intent({ id: 'guide-tab', specPath: null, specSessionId: 'sess-spec' })
    const w = mountDetail(item, { sddEnabled: true })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('writeSpec')

    await btn.trigger('click')
    expect(w.emitted('write-spec')).toEqual([['guide-tab']])

    // 不足 1 秒不切。
    vi.advanceTimersByTime(999)
    await nextTick()
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).not.toContain('active')

    // 满 1 秒切到 spec session,并打开会话。
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).toContain('active')
    expect(w.emitted('open-spec-session')).toEqual([['guide-tab']])
  })

  it('writeSpec: does not steal the tab back if the user switches intent within 1s', async () => {
    const a = intent({ id: 'guide-a', specPath: null })
    const b = intent({ id: 'guide-b', specPath: null })
    const w = mountDetail(a, { intents: [a, b], sddEnabled: true })

    await w.find('.req-btn.primary').trigger('click')
    // 1 秒内切到另一个意图。
    await w.setProps({ intent: b })

    vi.advanceTimersByTime(1000)
    await nextTick()
    // 仍停在默认 intent tab,未被抢切到 specSession。
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).not.toContain('active')
  })

  it('approveSpec gate: hidden for 10s after writeSpec, then shown and clickable', async () => {
    const item = intent({ id: 'guide-gate', specPath: null })
    const w = mountDetail(item, { sddEnabled: true })

    await w.find('.req-btn.primary').trigger('click')
    expect(w.emitted('write-spec')).toEqual([['guide-gate']])

    // specPath 回填 → mainAction 进入 approveSpec 态,但门未到点 → 主按钮不渲染。
    await w.setProps({ intent: { ...item, specPath: '.specs/x/spec.md', specApproved: false } })
    expect(w.find('[data-action="approveSpec"]').exists()).toBe(false)

    // 不足 10 秒仍不可见。
    vi.advanceTimersByTime(9999)
    await nextTick()
    expect(w.find('[data-action="approveSpec"]').exists()).toBe(false)

    // 满 10 秒展示并可点击 emit approve-spec。
    vi.advanceTimersByTime(1)
    await nextTick()
    const approve = w.find('[data-action="approveSpec"]')
    expect(approve.exists()).toBe(true)
    await approve.trigger('click')
    expect(w.emitted('approve-spec')).toEqual([['guide-gate']])
  })

  it('approveSpec gate: survives remount within the 10s window (refresh does not bypass)', async () => {
    const item = intent({ id: 'guide-remount', specPath: null })
    const w = mountDetail(item, { sddEnabled: true })
    await w.find('.req-btn.primary').trigger('click')

    vi.advanceTimersByTime(4000)
    w.unmount()

    // 重新挂载同一意图(已带 specPath,模拟刷新后的状态)。
    const w2 = mountDetail(
      intent({ id: 'guide-remount', specPath: '.specs/x/spec.md', specApproved: false }),
      { sddEnabled: true },
    )
    // 累计未满 10 秒 → 仍隐藏。
    expect(w2.find('[data-action="approveSpec"]').exists()).toBe(false)

    vi.advanceTimersByTime(6000)
    await nextTick()
    expect(w2.find('[data-action="approveSpec"]').exists()).toBe(true)
  })

  it('gate not armed when writeSpec was never clicked → approveSpec visible immediately', () => {
    const w = mountDetail(
      intent({ id: 'guide-noarm', specPath: '.specs/x/spec.md', specApproved: false }),
      { sddEnabled: true },
    )
    expect(w.find('[data-action="approveSpec"]').exists()).toBe(true)
  })

  it('cleanup: pending timers are cleared on unmount without switching or erroring', async () => {
    const item = intent({ id: 'guide-clean', specPath: null, specSessionId: 'sess-spec' })
    const w = mountDetail(item, { sddEnabled: true })
    await w.find('.req-btn.primary').trigger('click')

    w.unmount()
    // 已卸载,1s 切 Tab / 10s 门定时器均已清:推进时钟不触发切 Tab、不报错。
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow()
  })

  it('semantic colors: writeSpec vs approveSpec expose distinct, stable data-action + aria-label', () => {
    const writing = mountDetail(intent({ id: 'guide-sem-w', specPath: null }), { sddEnabled: true })
    const wb = writing.find('.req-btn.primary')
    expect(wb.attributes('data-action')).toBe('writeSpec')
    const writeLabel = wb.attributes('aria-label')

    const approving = mountDetail(
      intent({ id: 'guide-sem-a', specPath: '.specs/x/spec.md', specApproved: false }),
      { sddEnabled: true },
    )
    const ab = approving.find('.req-btn.primary')
    expect(ab.attributes('data-action')).toBe('approveSpec')
    const approveLabel = ab.attributes('aria-label')

    expect(writeLabel).toBeTruthy()
    expect(approveLabel).toBeTruthy()
    expect(writeLabel).not.toBe(approveLabel)
  })
})

describe('IntentDetail.vue — actions', () => {
  it('emits set-status done from the mark-done button', async () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', lastDevSessionId: 'dev-1' })
    const w = mountDetail(item)

    await w.find('[data-action="markDone"]').trigger('click')

    expect(w.emitted('set-status')).toEqual([['intent-1', 'done']])
  })

  it('hides mark-done until a dev session exists', () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', lastDevSessionId: null })
    const w = mountDetail(item)

    expect(w.find('[data-action="markDone"]').exists()).toBe(false)
  })

  it('emits set-automate toggling the current flag', async () => {
    const item = intent({ id: 'intent-1', automate: false })
    const w = mountDetail(item)

    await w.find('.req-automate').trigger('click')

    expect(w.emitted('set-automate')).toEqual([['intent-1', true]])
  })

  it('emits create-pr when the intent branch differs from the workspace main branch and no pr exists', async () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastDevSessionId: 'dev-1',
    })
    const w = mountDetail(item)

    await w.find('[data-action="createPr"]').trigger('click')

    expect(w.emitted('create-pr')).toEqual([['intent-1']])
  })

  it('hides create-pr when the intent branch is empty', () => {
    const item = intent({ id: 'intent-1', status: 'done', completedAt: 2, branchName: null })
    const w = mountDetail(item)

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('hides create-pr when no dev session exists', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastDevSessionId: null,
    })
    const w = mountDetail(item)

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('renders the PR link as a jumpable anchor to prUrl when present', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      prId: '42',
      prUrl: 'https://github.com/o/r/pull/42',
      prStatus: 'reviewing',
    })
    const w = mountDetail(item)
    const link = w.find('a.req-btn.pr-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('https://github.com/o/r/pull/42')
    expect(link.attributes('target')).toBe('_blank')
  })

  it('falls back to the copy button when a PR exists without a prUrl', () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', prId: '42', prUrl: null })
    const w = mountDetail(item)
    expect(w.find('a.req-btn.pr-link').exists()).toBe(false)
    expect(w.find('button.req-btn.pr-link').exists()).toBe(true)
  })

  it('shows no PR link when there is no PR (empty prUrl does not break layout)', () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', prId: null, prUrl: null })
    const w = mountDetail(item)
    expect(w.find('.req-btn.pr-link').exists()).toBe(false)
  })

  it('hides create-pr when the intent branch matches the workspace main branch', () => {
    const item = intent({
      id: 'intent-1',
      status: 'done',
      completedAt: 2,
      branchName: 'origin/main',
    })
    const w = mountDetail(item, { workspaceMainBranch: 'refs/heads/main' })

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })
})

describe('IntentDetail.vue — tabs', () => {
  it('renders four tabs and defaults to the intent tab', () => {
    const w = mountDetail(intent({ id: 'i1' }))
    expect(w.findAll('.intent-detail-tab')).toHaveLength(4)
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
  })

  it('intent session tab: empty state when no intent session, no open emit', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: null }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-intent-session-empty"]').exists()).toBe(true)
    expect(w.emitted('open-intent-session')).toBeUndefined()
  })

  it('intent session tab: emits open-intent-session when a session exists', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: 'sess-refine' }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.emitted('open-intent-session')).toEqual([['sess-refine']])
  })

  it('intent session tab: renders the chat column once the active session aligns', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: 'sess-refine' }), {
      activeSession: 'sess-refine',
    })
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(true)
  })

  it('spec tab: empty state when no spec path, emits read-spec when present', async () => {
    const noSpec = mountDetail(intent({ id: 'i1', specPath: null }))
    await noSpec.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(noSpec.find('[data-testid="intent-detail-spec-empty"]').exists()).toBe(true)
    expect(noSpec.emitted('read-spec')).toBeUndefined()

    const specAbs = '/home/u/.c3/specs/proj/2026/06/20/2026-06-20-001-x/spec.md'
    const withSpec = mountDetail(intent({ id: 'i2', specPath: specAbs }), {
      intentSpecContent: '# Hello spec',
    })
    await withSpec.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    // read-spec now carries (intentId, absolute specPath) — specs are centralized.
    expect(withSpec.emitted('read-spec')).toEqual([['i2', specAbs]])
  })

  it('spec session tab: emits open-spec-session when a spec session exists', async () => {
    const w = mountDetail(intent({ id: 'i1', specSessionId: 'sess-spec' }))
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.emitted('open-spec-session')).toEqual([['i1']])
  })

  it('resets to the intent tab when the selected intent changes', async () => {
    const a = intent({ id: 'a', specPath: '.specs/a/spec.md' })
    const b = intent({ id: 'b', specPath: '.specs/b/spec.md' })
    const w = mountDetail(a, { intents: [a, b] })
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(w.find('[data-testid="tab-spec"]').exists()).toBe(true)

    await w.setProps({ intent: b })
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
  })
})

describe('IntentDetail.vue — session reset', () => {
  it('intent session tab: reset → input → emits reset-intent-session with the typed input', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: null }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')

    // Reset button is always available on the intent-session tab (content exists).
    const resetBtn = w.find('[data-testid="intent-detail-reset-session"]')
    expect(resetBtn.exists()).toBe(true)
    await resetBtn.trigger('click')

    await w.find('[data-testid="reset-input"]').setValue('please narrow the scope')
    await w.find('[data-testid="reset-accept"]').trigger('click')

    expect(w.emitted('reset-intent-session')).toEqual([['i1', 'please narrow the scope']])
    // Dialog closes after confirm.
    expect(w.find('[data-testid="reset-overlay"]').exists()).toBe(false)
  })

  it('spec session tab: reset emits reset-spec-session when a spec exists', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: null }))
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')

    const resetBtn = w.find('[data-testid="intent-detail-reset-session"]')
    expect(resetBtn.exists()).toBe(true)
    await resetBtn.trigger('click')

    await w.find('[data-testid="reset-input"]').setValue('tighten acceptance')
    await w.find('[data-testid="reset-accept"]').trigger('click')

    expect(w.emitted('reset-spec-session')).toEqual([['i1', 'tighten acceptance']])
  })

  it('spec session tab: no reset button when no spec has been written', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null }))
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-reset-session"]').exists()).toBe(false)
  })

  it('hides session reset buttons once a dev session exists', async () => {
    const item = intent({
      id: 'i1',
      intentSessionId: 'sess-refine',
      specPath: '.specs/x/spec.md',
      specSessionId: 'sess-spec',
      lastDevSessionId: 'dev-1',
    })
    const w = mountDetail(item)

    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-reset-session"]').exists()).toBe(false)

    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-reset-session"]').exists()).toBe(false)
  })

  it('confirm is disabled until the user types input', async () => {
    const w = mountDetail(intent({ id: 'i1' }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    await w.find('[data-testid="intent-detail-reset-session"]').trigger('click')

    const accept = w.find('[data-testid="reset-accept"]')
    expect((accept.element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-testid="reset-input"]').setValue('hello')
    expect((accept.element as HTMLButtonElement).disabled).toBe(false)
  })
})
