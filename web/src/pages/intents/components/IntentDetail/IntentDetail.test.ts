import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Intent, IntentLog } from '@ccc/shared/protocol'
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
    workspaceGitBranchMode?: 'worktree' | 'current-branch'
    intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
    activeSession?: string | null
    intentSpecContent?: string | null
    intentSpecLoading?: boolean
    specSessionRunning?: boolean
    intentLogs?: IntentLog[]
  } = {},
) {
  return mount(IntentDetail, {
    props: {
      intent: current,
      intents: opts.intents ?? (current ? [current] : []),
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
      sddEnabled: opts.sddEnabled ?? false,
      workspaceMainBranch: opts.workspaceMainBranch ?? null,
      workspaceGitBranchMode: opts.workspaceGitBranchMode,
      intentPrSync: opts.intentPrSync,
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
      specSessionRunning: opts.specSessionRunning ?? false,
      intentLogs: opts.intentLogs ?? [],
      intentLogsLoading: false,
    },
    global: {
      // Keep the chat column inert: we test IntentDetail's tab/gate logic, not it.
      // `showMode` / `modeDisabled` are declared so tab-driven mode locking is assertable.
      stubs: {
        ChatColumn: {
          props: ['showMode', 'modeDisabled'],
          template:
            '<div data-testid="intent-detail-chat" :data-show-mode="String(showMode)" :data-mode-disabled="String(modeDisabled)" />',
        },
      },
    },
  })
}

describe('IntentDetail.vue — empty state', () => {
  it('renders the empty placeholder when no intent is selected', () => {
    const w = mountDetail(null)
    expect(w.find('[data-testid="intent-detail-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="intent-engineering-progress"]').exists()).toBe(false)
  })
})

describe('IntentDetail.vue — engineering progress', () => {
  it('renders three accessible text-labelled stages below the title when SDD is enabled', () => {
    const w = mountDetail(intent({ id: 'i1' }), { sddEnabled: true })
    const progress = w.find('[data-testid="intent-engineering-progress"]')
    const stages = progress.findAll('[data-stage]')

    expect(progress.attributes('aria-label')).toBeTruthy()
    const header = w.find('.intent-detail-head')
    expect(header.element.contains(progress.element)).toBe(true)
    expect(w.find('.intent-detail-titlebar').element.nextElementSibling).toBe(progress.element)
    expect(header.element.nextElementSibling).toBe(w.find('.intent-detail-tabs').element)
    expect(stages.map((stage) => stage.attributes('data-stage'))).toEqual([
      'intent',
      'spec',
      'work',
    ])
    expect(stages.map((stage) => stage.attributes('data-state'))).toEqual([
      'completed',
      'not_started',
      'not_started',
    ])
    expect(stages.every((stage) => stage.find('.intent-engineering-progress-state').text())).toBe(
      true,
    )
    expect(
      stages.every((stage) => {
        const children = Array.from(stage.element.children)
        return (
          children[0]?.classList.contains('intent-engineering-progress-name') &&
          children[1]?.classList.contains('intent-engineering-progress-marker') &&
          children[2]?.classList.contains('intent-engineering-progress-state')
        )
      }),
    ).toBe(true)
  })

  it('omits the spec stage with SDD disabled even when historical spec data exists', () => {
    const w = mountDetail(
      intent({ id: 'i1', specPath: 'spec.md', specSessionId: 'spec-session' }),
      { sddEnabled: false },
    )
    expect(
      w
        .findAll('[data-testid="intent-engineering-progress"] [data-stage]')
        .map((stage) => stage.attributes('data-stage')),
    ).toEqual(['intent', 'work'])
  })

  it('reacts when intent fields are backfilled', async () => {
    const item = intent({ id: 'i1', status: 'draft' })
    const w = mountDetail(item, { sddEnabled: true })

    await w.setProps({
      intent: {
        ...item,
        status: 'in_progress',
        specPath: 'spec.md',
        specApproved: true,
        lastWorkSessionId: 'work-session',
      },
    })

    expect(
      w
        .findAll('[data-testid="intent-engineering-progress"] [data-stage]')
        .map((stage) => stage.attributes('data-state')),
    ).toEqual(['completed', 'completed', 'in_progress'])
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
    const w = mountDetail(item, { sddEnabled: true })
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
  it('SDD off → Start Work (regardless of spec fields)', () => {
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

  it('SDD on + spec written, not approved → Approve Spec opens the spec tab only', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specApproved: false })
    const w = mountDetail(item, { sddEnabled: true })
    const btn = w.find('.req-btn.primary')
    expect(btn.attributes('data-action')).toBe('approveSpec')
    await btn.trigger('click')
    expect(w.find('[data-testid="tab-spec"]').exists()).toBe(true)
    expect(w.emitted('read-spec')).toEqual([['i1', '.specs/x/spec.md']])
    expect(w.emitted('approve-spec')).toBeUndefined()
  })

  it('SDD on + spec approved → Start Work, emits start-dev', async () => {
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

  it('approveSpec gate: hides the spec-tab approve button for 10s after writeSpec', async () => {
    const item = intent({ id: 'guide-gate', specPath: null })
    const w = mountDetail(item, { sddEnabled: true })

    await w.find('.req-btn.primary').trigger('click')
    expect(w.emitted('write-spec')).toEqual([['guide-gate']])

    // specPath 回填 → mainAction 进入 approveSpec 态;头部入口仍显示,但只负责打开 spec tab。
    await w.setProps({ intent: { ...item, specPath: '.specs/x/spec.md', specApproved: false } })
    expect(w.find('.intent-detail-actions [data-action="approveSpec"]').exists()).toBe(true)
    await w.find('.intent-detail-actions [data-action="approveSpec"]').trigger('click')
    expect(w.find('[data-testid="tab-spec"]').exists()).toBe(true)
    expect(w.find('[data-testid="intent-detail-spec-approve"]').exists()).toBe(false)

    // 不足 10 秒仍不可见。
    vi.advanceTimersByTime(9999)
    await nextTick()
    expect(w.find('[data-testid="intent-detail-spec-approve"]').exists()).toBe(false)

    // 满 10 秒展示,点击才真正批准。
    vi.advanceTimersByTime(1)
    await nextTick()
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    const approve = w.find('[data-testid="intent-detail-spec-approve"]')
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
    await w2.find('.intent-detail-actions [data-action="approveSpec"]').trigger('click')
    // 累计未满 10 秒 → spec tab 的真正批准入口仍隐藏。
    expect(w2.find('[data-testid="intent-detail-spec-approve"]').exists()).toBe(false)

    vi.advanceTimersByTime(6000)
    await nextTick()
    expect(w2.find('[data-testid="intent-detail-spec-approve"]').exists()).toBe(true)
  })

  it('gate not armed when writeSpec was never clicked → spec approve visible immediately', async () => {
    const w = mountDetail(
      intent({ id: 'guide-noarm', specPath: '.specs/x/spec.md', specApproved: false }),
      { sddEnabled: true },
    )
    await w.find('.intent-detail-actions [data-action="approveSpec"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-spec-approve"]').exists()).toBe(true)
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
    const item = intent({ id: 'intent-1', status: 'in_progress', lastWorkSessionId: 'dev-1' })
    const w = mountDetail(item)

    await w.find('[data-action="markDone"]').trigger('click')

    expect(w.emitted('set-status')).toEqual([['intent-1', 'done']])
  })

  it('hides mark-done until a work session exists', () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', lastWorkSessionId: null })
    const w = mountDetail(item)

    expect(w.find('[data-action="markDone"]').exists()).toBe(false)
  })

  it('emits set-automate toggling the current flag', async () => {
    const item = intent({ id: 'intent-1', automate: false })
    const w = mountDetail(item)

    await w.find('.req-automate').trigger('click')

    expect(w.emitted('set-automate')).toEqual([['intent-1', true]])
  })

  it('emits create-pr in worktree mode when branch/session/no-pr/non-main and any non-done status', async () => {
    for (const status of ['todo', 'in_progress'] as const) {
      const item = intent({
        id: 'intent-1',
        status,
        branchName: 'feature/work',
        lastWorkSessionId: 'dev-1',
      })
      const w = mountDetail(item, { workspaceGitBranchMode: 'worktree' })

      await w.find('[data-action="createPr"]').trigger('click')

      expect(w.emitted('create-pr')).toEqual([['intent-1']])
    }
  })

  it('hides create-pr in current-branch mode even when branch/session/no-pr', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastWorkSessionId: 'dev-1',
    })
    const w = mountDetail(item, { workspaceGitBranchMode: 'current-branch' })

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('hides create-pr when the workspace git branch mode is missing (treated as non-worktree)', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastWorkSessionId: 'dev-1',
    })
    const w = mountDetail(item)

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('hides create-pr when the intent branch is empty', () => {
    const item = intent({ id: 'intent-1', status: 'in_progress', branchName: null })
    const w = mountDetail(item, { workspaceGitBranchMode: 'worktree' })

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('hides create-pr when no work session exists', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastWorkSessionId: null,
    })
    const w = mountDetail(item, { workspaceGitBranchMode: 'worktree' })

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })

  it('hides create-pr when the intent already has a PR', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'feature/work',
      lastWorkSessionId: 'dev-1',
      prId: '9',
    })
    const w = mountDetail(item, { workspaceGitBranchMode: 'worktree' })

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

  it('links the PR number in metadata to prUrl when present', () => {
    const item = intent({
      id: 'intent-1',
      status: 'done',
      prId: '38',
      prUrl: 'https://github.com/o/r/pull/38',
      prStatus: 'merged',
    })
    const w = mountDetail(item)
    const link = w.find('.req-meta-pr-link')

    expect(link.text()).toBe('#38')
    expect(link.attributes('href')).toBe('https://github.com/o/r/pull/38')
    expect(link.attributes('target')).toBe('_blank')
  })

  it('shows sync PR status actions only for done reviewing intents with a PR', async () => {
    const item = intent({
      id: 'intent-1',
      status: 'done',
      prId: '38',
      prUrl: 'https://github.com/o/r/pull/38',
      prStatus: 'reviewing',
    })
    const w = mountDetail(item)

    expect(w.find('[data-action="syncPrStatus"]').exists()).toBe(true)
    expect(w.find('.req-pr-sync-btn').exists()).toBe(true)

    await w.find('[data-action="syncPrStatus"]').trigger('click')
    expect(w.emitted('sync-pr-status')).toEqual([['intent-1']])
  })

  it('hides sync PR status when status is not done, PR is missing, or PR is already merged', () => {
    expect(
      mountDetail(intent({ id: 'a', status: 'in_progress', prId: '1', prStatus: 'reviewing' }))
        .find('[data-action="syncPrStatus"]')
        .exists(),
    ).toBe(false)
    expect(
      mountDetail(intent({ id: 'b', status: 'done', prId: null, prStatus: 'reviewing' }))
        .find('[data-action="syncPrStatus"]')
        .exists(),
    ).toBe(false)
    expect(
      mountDetail(intent({ id: 'c', status: 'done', prId: '1', prStatus: 'merged' }))
        .find('[data-action="syncPrStatus"]')
        .exists(),
    ).toBe(false)
  })

  it('disables sync PR status and renders inline feedback while syncing', () => {
    const item = intent({
      id: 'intent-1',
      status: 'done',
      prId: '38',
      prStatus: 'reviewing',
    })
    const w = mountDetail(item, {
      intentPrSync: { 'intent-1': { state: 'syncing', message: 'Syncing...' } },
    })

    expect(w.find('[data-action="syncPrStatus"]').attributes('disabled')).toBeDefined()
    expect(w.find('.req-pr-sync-feedback').text()).toBe('Syncing...')
  })

  it('hides create-pr when the intent branch matches the workspace main branch', () => {
    const item = intent({
      id: 'intent-1',
      status: 'in_progress',
      branchName: 'origin/main',
      lastWorkSessionId: 'dev-1',
    })
    const w = mountDetail(item, {
      workspaceGitBranchMode: 'worktree',
      workspaceMainBranch: 'refs/heads/main',
    })

    expect(w.find('[data-action="createPr"]').exists()).toBe(false)
  })
})

describe('IntentDetail.vue — draft ↔ todo status transition buttons', () => {
  it('draft: shows the Todo button (not back-to-draft); click emits set-status todo', async () => {
    const item = intent({ id: 'i1', status: 'draft' })
    const w = mountDetail(item)

    const todoBtn = w.find('[data-testid="intent-detail-mark-todo"]')
    expect(todoBtn.exists()).toBe(true)
    expect(w.find('[data-testid="intent-detail-back-to-draft"]').exists()).toBe(false)

    await todoBtn.trigger('click')
    expect(w.emitted('set-status')).toEqual([['i1', 'todo']])
  })

  it('todo: shows the back-to-draft button (not Todo); click emits set-status draft', async () => {
    const item = intent({ id: 'i1', status: 'todo' })
    const w = mountDetail(item)

    const backBtn = w.find('[data-testid="intent-detail-back-to-draft"]')
    expect(backBtn.exists()).toBe(true)
    expect(w.find('[data-testid="intent-detail-mark-todo"]').exists()).toBe(false)

    await backBtn.trigger('click')
    expect(w.emitted('set-status')).toEqual([['i1', 'draft']])
  })

  it('renders neither button for in_progress / done / cancelled', () => {
    for (const status of ['in_progress', 'done', 'cancelled'] as const) {
      const w = mountDetail(intent({ id: 'i1', status }))
      expect(w.find('[data-testid="intent-detail-mark-todo"]').exists()).toBe(false)
      expect(w.find('[data-testid="intent-detail-back-to-draft"]').exists()).toBe(false)
    }
  })
})

describe('IntentDetail.vue — meta block position and field order', () => {
  // 顶部区域字段的稳定顺序:ID → 分支 → PR → 已创建 → 已完成 → 已更新 → 依赖明细。
  function metaLabels(w: ReturnType<typeof mountDetail>): string[] {
    return w.findAll('.req-meta > .req-meta-item').map((el) => el.text())
  }

  it('renders req-meta before the body/edit action area within the intent tab', () => {
    const item = intent({ id: 'i1', status: 'todo', content: 'body text' })
    const w = mountDetail(item)
    const body = w.find('[data-testid="tab-intent"]').element
    const meta = w.find('.req-meta').element
    const detail = w.find('.req-detail').element
    const actions = w.find('.intent-detail-section-actions').element

    // req-meta 是意图 tab 的第一个子节点,且位于正文与正文操作区之前。
    expect(body.firstElementChild).toBe(meta)
    expect(meta.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(meta.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('orders all present fields as ID → branch → PR → created → completed → updated → deps', () => {
    const current = intent({
      id: 'the-intent-id',
      status: 'done',
      branchName: 'feature/x',
      latestCommitHash: 'abcdef1234567',
      prId: '42',
      prUrl: 'https://github.com/o/r/pull/42',
      prStatus: 'reviewing',
      completedAt: 5,
      dependsOn: ['dep1'],
      dependsOnTypes: { dep1: 'blocks' },
    })
    const w = mountDetail(current, {
      intents: [current, intent({ id: 'dep1', title: 'Dep one' })],
    })
    const labels = metaLabels(w)

    expect(labels).toHaveLength(7)
    expect(labels[0]).toContain('the-intent-id')
    expect(labels[1]).toContain('feature/x')
    expect(labels[1]).toContain('abcdef1') // commit 前 7 位
    expect(labels[2]).toContain('#42')
    expect(labels[3]).toContain('Created:')
    expect(labels[4]).toContain('Completed:')
    expect(labels[5]).toContain('Updated:')
    expect(w.findAll('.req-meta > .req-meta-item').at(6)!.classes()).toContain(
      'req-meta-dependencies',
    )
  })

  it('omits empty branch/PR/completed/deps while keeping the surviving field order', () => {
    const item = intent({
      id: 'only-id',
      status: 'todo',
      branchName: null,
      prId: null,
      completedAt: null,
      dependsOn: [],
    })
    const w = mountDetail(item)
    const labels = metaLabels(w)

    // 仅 ID / 已创建 / 已更新 恒显示,空字段不占位。
    expect(labels).toHaveLength(3)
    expect(labels[0]).toContain('only-id')
    expect(labels[1]).toContain('Created:')
    expect(labels[2]).toContain('Updated:')
    expect(w.find('.req-meta-dependencies').exists()).toBe(false)
    expect(w.find('.req-meta-pr-link').exists()).toBe(false)
  })

  it('shows the branch without a commit suffix when latestCommitHash is empty', () => {
    const item = intent({ id: 'i1', branchName: 'feature/y', latestCommitHash: null })
    const w = mountDetail(item)
    const branch = w.findAll('.req-meta > .req-meta-item').at(1)!
    expect(branch.text()).toContain('feature/y')
    expect(branch.text()).not.toContain('·')
  })
})

describe('IntentDetail.vue — dependency metadata', () => {
  it('renders each dependency with title, text status, type, and an edit button', () => {
    const current = intent({
      id: 'current',
      dependsOn: ['done-dep', 'pending-dep'],
      dependsOnTypes: { 'done-dep': 'blocks', 'pending-dep': 'informs' },
    })
    const w = mountDetail(current, {
      intents: [
        current,
        intent({ id: 'done-dep', title: 'Completed dependency', status: 'done' }),
        intent({ id: 'pending-dep', title: 'Pending dependency' }),
      ],
    })

    const rows = w.findAll('.req-dependency-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Completed dependency')
    expect(rows[0].text()).toContain('Completed')
    expect(rows[0].text()).toContain('Blocks')
    expect(rows[1].text()).toContain('Pending dependency')
    expect(rows[1].text()).toContain('Not completed')
    expect(rows[1].text()).toContain('Informs')
    expect(rows.every((row) => row.find('.req-dep-edit-btn').exists())).toBe(true)
    expect(w.find('.req-meta-dependencies').exists()).toBe(true)
  })

  it('emits the selected dependency id when its title is clicked', async () => {
    const current = intent({ id: 'current', dependsOn: ['dependency'] })
    const w = mountDetail(current, {
      intents: [current, intent({ id: 'dependency', title: 'Dependency' })],
    })

    await w.find('.req-dependency-title').trigger('click')

    expect(w.emitted('select-dependency')).toEqual([['dependency']])
  })

  it('edits one dependency type while emitting the complete unchanged group', async () => {
    const current = intent({
      id: 'current',
      dependsOn: ['first', 'second'],
      dependsOnTypes: { first: 'blocks', second: 'informs' },
    })
    const w = mountDetail(current, {
      intents: [
        current,
        intent({ id: 'first', title: 'First' }),
        intent({ id: 'second', title: 'Second' }),
      ],
    })

    await w.findAll('.req-dep-edit-btn')[1].trigger('click')
    expect(w.findAll('.dep-edit-row')).toHaveLength(1)
    expect(w.find('.dep-edit-dep-title').text()).toBe('Second')
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

  it('does not render dependency metadata when there are no dependencies', () => {
    const w = mountDetail(intent({ id: 'current' }))
    expect(w.find('.req-meta-dependencies').exists()).toBe(false)
  })
})

describe('IntentDetail.vue — tabs', () => {
  it('renders five tabs and defaults to the intent tab when SDD is on', () => {
    const w = mountDetail(intent({ id: 'i1' }), { sddEnabled: true })
    expect(w.findAll('.intent-detail-tab')).toHaveLength(5)
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
  })

  it('intent session tab: offers first-message input when no session, without opening one', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: null }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(true)
    expect(w.emitted('open-intent-session')).toBeUndefined()
  })

  it('intent session tab: emits open-intent-session when a session exists', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: 'sess-refine' }))
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.emitted('open-intent-session')).toEqual([['sess-refine']])
  })

  it('intent session tab: opens automatically when its session id is backfilled after switching', async () => {
    const item = intent({ id: 'i1', intentSessionId: null })
    const w = mountDetail(item)
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.emitted('open-intent-session')).toBeUndefined()

    await w.setProps({ intent: { ...item, intentSessionId: 'sess-refine' } })
    expect(w.emitted('open-intent-session')).toEqual([['sess-refine']])
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(false)

    await w.setProps({ activeSession: 'sess-refine' })
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(true)
  })

  it('intent session tab: renders the chat column once the active session aligns', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: 'sess-refine' }), {
      activeSession: 'sess-refine',
    })
    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(true)
  })

  it('会话 tab 都展示权限模式:意图/spec 会话只读,工作会话可切换', async () => {
    const item = intent({
      id: 'i1',
      intentSessionId: 'sess-refine',
      specSessionId: 'sess-spec',
      lastWorkSessionId: 'sess-work',
    })
    const w = mountDetail(item, { sddEnabled: true, activeSession: 'sess-refine' })
    const chat = () => w.find('[data-testid="intent-detail-chat"]').attributes()

    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(chat()['data-show-mode']).toBe('true')
    expect(chat()['data-mode-disabled']).toBe('true')

    await w.setProps({ activeSession: 'sess-spec' })
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(chat()['data-mode-disabled']).toBe('true')

    await w.setProps({ activeSession: 'sess-work' })
    await w.find('.intent-detail-tab[data-tab="workSession"]').trigger('click')
    expect(chat()['data-show-mode']).toBe('true')
    expect(chat()['data-mode-disabled']).toBe('false')
  })

  it('spec tab: empty state when no spec path, emits read-spec when present', async () => {
    const noSpec = mountDetail(intent({ id: 'i1', specPath: null }), { sddEnabled: true })
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

  it('spec session tab: opens automatically when its session id is backfilled after switching', async () => {
    const item = intent({ id: 'i1', specSessionId: null })
    const w = mountDetail(item, { sddEnabled: true })
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.emitted('open-spec-session')).toBeUndefined()

    await w.setProps({ intent: { ...item, specSessionId: 'sess-spec' } })
    expect(w.emitted('open-spec-session')).toEqual([['i1']])
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(false)

    await w.setProps({ activeSession: 'sess-spec' })
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(true)
  })

  it('does not reopen an already aligned session after unrelated intent updates', async () => {
    const item = intent({ id: 'i1', specSessionId: 'sess-spec' })
    const w = mountDetail(item, { activeSession: 'sess-spec' })
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')

    await w.setProps({ intent: { ...item, title: 'Updated title' } })
    expect(w.emitted('open-spec-session')).toBeUndefined()
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
  it('header modify → input → emits reset-intent-session with the typed input', async () => {
    const w = mountDetail(intent({ id: 'i1', intentSessionId: null }))

    const modifyBtn = w.find('[data-testid="intent-detail-intent-modify"]')
    expect(modifyBtn.exists()).toBe(true)
    await modifyBtn.trigger('click')

    await w.find('[data-testid="reset-input"]').setValue('please narrow the scope')
    await w.find('[data-testid="reset-accept"]').trigger('click')

    expect(w.emitted('reset-intent-session')).toEqual([['i1', 'please narrow the scope']])
    // Dialog closes after confirm.
    expect(w.find('[data-testid="reset-overlay"]').exists()).toBe(false)
  })

  it('spec tab modify emits reset-spec-session when a spec exists', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: null }))
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')

    const modifyBtn = w.find('[data-testid="intent-detail-spec-modify"]')
    expect(modifyBtn.exists()).toBe(true)
    await modifyBtn.trigger('click')

    await w.find('[data-testid="reset-input"]').setValue('tighten acceptance')
    await w.find('[data-testid="reset-accept"]').trigger('click')

    expect(w.emitted('reset-spec-session')).toEqual([['i1', 'tighten acceptance']])
  })

  it('spec tab: no modify button when no spec has been written', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null }), { sddEnabled: true })
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-spec-modify"]').exists()).toBe(false)
  })

  it('spec tab modify is visible but disabled when spec dependencies are blocking', async () => {
    const dep = intent({ id: 'dep', status: 'todo', title: 'Blocking dep' })
    const current = intent({
      id: 'i1',
      specPath: '.specs/x/spec.md',
      dependsOn: ['dep'],
      dependsOnTypes: { dep: 'blocks' },
      lastWorkSessionId: 'dev-1',
    })
    const w = mountDetail(current, {
      intents: [dep, current],
      workspaceGitBranchMode: 'worktree',
      workspaceMainBranch: 'main',
    })

    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    const modify = w.find('[data-testid="intent-detail-spec-modify"]')
    expect(modify.exists()).toBe(true)
    expect((modify.element as HTMLButtonElement).disabled).toBe(true)
    expect(modify.attributes('title')).toBeTruthy()
  })

  it('hides modify buttons once a work session exists', async () => {
    const item = intent({
      id: 'i1',
      intentSessionId: 'sess-refine',
      specPath: '.specs/x/spec.md',
      specSessionId: 'sess-spec',
      lastWorkSessionId: 'dev-1',
    })
    const w = mountDetail(item)

    expect(w.find('[data-testid="intent-detail-intent-modify"]').exists()).toBe(false)

    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-spec-modify"]').exists()).toBe(false)
  })

  it('confirm is disabled until the user types input', async () => {
    const w = mountDetail(intent({ id: 'i1' }))
    await w.find('[data-testid="intent-detail-intent-modify"]').trigger('click')

    const accept = w.find('[data-testid="reset-accept"]')
    expect((accept.element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-testid="reset-input"]').setValue('hello')
    expect((accept.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('session tabs no longer render the old reset button', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: '.specs/x/spec.md' }))

    await w.find('.intent-detail-tab[data-tab="intentSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-reset-session"]').exists()).toBe(false)

    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.find('[data-testid="intent-detail-reset-session"]').exists()).toBe(false)
  })
})

describe('IntentDetail.vue — auto-switch to spec session tab after change request', () => {
  async function submitSpecChange(w: ReturnType<typeof mountDetail>): Promise<void> {
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    await w.find('[data-testid="intent-detail-spec-modify"]').trigger('click')
    await w.find('[data-testid="reset-input"]').setValue('tighten acceptance')
    await w.find('[data-testid="reset-accept"]').trigger('click')
  }

  it('switches to spec session tab once specSessionId is backfilled to a new value', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: null })
    const w = mountDetail(item)
    await submitSpecChange(w)
    expect(w.emitted('reset-spec-session')).toEqual([['i1', 'tighten acceptance']])

    // 提交后仍在 spec tab,新会话尚未回填。
    expect(w.find('[data-testid="tab-spec"]').exists()).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).not.toContain('active')

    // 新 spec 会话创建成功 → specSessionId 回填为新值 → 自动切到 spec session tab 并打开会话。
    await w.setProps({ intent: { ...item, specSessionId: 'sess-new' } })
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).toContain('active')
    expect(w.emitted('open-spec-session')).toEqual([['i1']])
  })

  it('switches when an existing spec session is replaced by a different one', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: 'sess-old' })
    const w = mountDetail(item)
    await submitSpecChange(w)

    await w.setProps({ intent: { ...item, specSessionId: 'sess-new' } })
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).toContain('active')
  })

  it('does not switch when specSessionId stays unchanged (submit failed / session not created)', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: null })
    const w = mountDetail(item)
    await submitSpecChange(w)

    // 失败/未创建:specSessionId 仍为 null(仅其它字段更新)→ 不切换,留在 spec tab。
    await w.setProps({ intent: { ...item, specSessionId: null, title: 'Updated title' } })
    expect(w.find('[data-testid="tab-spec"]').exists()).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).not.toContain('active')
    expect(w.emitted('open-spec-session')).toBeUndefined()
  })

  it('does not switch back after the user moves to another intent before backfill', async () => {
    const a = intent({ id: 'a', specPath: '.specs/a/spec.md', specSessionId: null })
    const b = intent({ id: 'b', specPath: '.specs/b/spec.md', specSessionId: null })
    const w = mountDetail(a, { intents: [a, b] })
    await submitSpecChange(w)

    // 回填前切到另一意图(复位到 intent tab,清除待切状态)。
    await w.setProps({ intent: b })
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)

    // 即便回到原意图并回填新会话,也不再自动切(待切状态已清)。
    await w.setProps({ intent: { ...a, specSessionId: 'sess-new' } })
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).not.toContain('active')
  })
})

describe('IntentDetail.vue — spec/spec-session tab visibility by SDD', () => {
  function tabKeys(w: ReturnType<typeof mountDetail>): string[] {
    return w.findAll('.intent-detail-tab').map((b) => b.attributes('data-tab') ?? '')
  }

  it('SDD off + no history spec data → only intent/intentSession/changelog', () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null, specSessionId: null }), {
      sddEnabled: false,
    })
    expect(tabKeys(w)).toEqual(['intent', 'intentSession', 'changelog'])
  })

  it('SDD off but a spec path exists → all five tabs render', () => {
    const w = mountDetail(intent({ id: 'i1', specPath: '.specs/x/spec.md', specSessionId: null }), {
      sddEnabled: false,
    })
    expect(tabKeys(w)).toEqual(['intent', 'intentSession', 'spec', 'specSession', 'changelog'])
  })

  it('SDD off but a spec session id exists → all five tabs render', () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null, specSessionId: 'sess-spec' }), {
      sddEnabled: false,
    })
    expect(tabKeys(w)).toEqual(['intent', 'intentSession', 'spec', 'specSession', 'changelog'])
  })

  it('SDD on → all five tabs render regardless of spec data', () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null, specSessionId: null }), {
      sddEnabled: true,
    })
    expect(tabKeys(w)).toEqual(['intent', 'intentSession', 'spec', 'specSession', 'changelog'])
  })

  it('falls back to the intent tab when the active tab becomes hidden', async () => {
    const item = intent({ id: 'i1', specPath: null, specSessionId: 'sess-spec' })
    const w = mountDetail(item, { sddEnabled: false })
    // spec session 可见 → 切过去。
    await w.find('.intent-detail-tab[data-tab="specSession"]').trigger('click')
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').classes()).toContain('active')

    // 历史 spec 数据消失且 SDD 仍关闭 → specSession 隐藏 → 回退到 intent tab。
    await w.setProps({ intent: { ...item, specSessionId: null } })
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
  })

  it('requestedSubTab=specSession while hidden: stays on intent, no open, still consumes', async () => {
    const w = mountDetail(intent({ id: 'i1', specPath: null, specSessionId: null }), {
      sddEnabled: false,
    })

    await w.setProps({ requestedSubTab: 'specSession' })

    // 目标 tab 不可见 → 不切换(停在 intent)、不发出 open-spec-session,但仍消费一次性请求。
    expect(w.find('[data-testid="tab-intent"]').exists()).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="specSession"]').exists()).toBe(false)
    expect(w.emitted('open-spec-session')).toBeUndefined()
    expect(w.emitted('requested-subtab-consumed')).toEqual([[]])
  })
})

describe('IntentDetail.vue — spec tab approval actions', () => {
  it('spec tab approve emits approve-spec from the dedicated action', async () => {
    const item = intent({ id: 'i1', specPath: '.specs/x/spec.md', specApproved: false })
    const w = mountDetail(item, { sddEnabled: true })

    await w.find('.req-btn.primary[data-action="approveSpec"]').trigger('click')
    expect(w.emitted('approve-spec')).toBeUndefined()

    await w.find('[data-testid="intent-detail-spec-approve"]').trigger('click')
    expect(w.emitted('approve-spec')).toEqual([['i1']])
  })
})

describe('IntentDetail.vue — inline content edit', () => {
  const EDIT = '[data-testid="intent-detail-edit-content"]'
  const EDITOR = '[data-testid="intent-detail-content-editor"]'
  const TEXTAREA = '[data-testid="intent-detail-content-textarea"]'
  const SAVE = '[data-testid="intent-detail-content-save"]'
  const CANCEL = '[data-testid="intent-detail-content-cancel"]'

  it('shows the Edit button for draft and todo, not for in_progress/done/cancelled', () => {
    for (const status of ['draft', 'todo'] as const) {
      expect(
        mountDetail(intent({ id: 'i1', status }))
          .find(EDIT)
          .exists(),
      ).toBe(true)
    }
    for (const status of ['in_progress', 'done', 'cancelled'] as const) {
      expect(
        mountDetail(intent({ id: 'i1', status }))
          .find(EDIT)
          .exists(),
      ).toBe(false)
    }
  })

  it('clicking Edit swaps the rendered body for a textarea prefilled with current content', async () => {
    const w = mountDetail(intent({ id: 'i1', status: 'todo', content: 'original body' }))
    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)

    await w.find(EDIT).trigger('click')

    expect(w.find(EDITOR).exists()).toBe(true)
    expect(w.find('.req-detail').exists()).toBe(false)
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('original body')
    // Edit button hidden while editing (its action area is replaced by the editor).
    expect(w.find(EDIT).exists()).toBe(false)
  })

  it('Save emits save-intent-content with the intent id and the edited draft', async () => {
    const w = mountDetail(intent({ id: 'i1', status: 'todo', content: 'original body' }))
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('edited body')
    await w.find(SAVE).trigger('click')

    expect(w.emitted('save-intent-content')).toEqual([['i1', 'edited body']])
    // Stays in edit mode (disabled) until the server refills the intent.
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)
  })

  it('Cancel discards the draft, restores the rendered body, and emits nothing', async () => {
    const w = mountDetail(intent({ id: 'i1', status: 'todo', content: 'original body' }))
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('scrapped edit')
    await w.find(CANCEL).trigger('click')

    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)
    expect(w.emitted('save-intent-content')).toBeUndefined()
    // Re-opening the editor shows the original content, not the scrapped draft.
    await w.find(EDIT).trigger('click')
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('original body')
  })

  it('leaves edit mode once the server refills the intent (updatedAt bump)', async () => {
    const item = intent({ id: 'i1', status: 'todo', content: 'original body', updatedAt: 1 })
    const w = mountDetail(item)
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('new body')
    await w.find(SAVE).trigger('click')
    expect(w.find(EDITOR).exists()).toBe(true)

    // Server broadcast: fresh intent with the new content + bumped updatedAt.
    await w.setProps({ intent: { ...item, content: 'new body', updatedAt: 2 } })

    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)
  })

  it('discards an in-progress edit when the selected intent changes', async () => {
    const a = intent({ id: 'a', status: 'todo', content: 'A body' })
    const b = intent({ id: 'b', status: 'todo', content: 'B body' })
    const w = mountDetail(a, { intents: [a, b] })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('dirty draft')

    await w.setProps({ intent: b })

    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)
  })
})

describe('IntentDetail.vue — inline spec edit', () => {
  const SPEC_ABS = '/home/u/.c3/specs/proj/2026/07/07/2026-07-07-001-x/spec.md'
  const EDIT = '[data-testid="intent-detail-spec-edit"]'
  const EDITOR = '[data-testid="intent-detail-spec-editor"]'
  const TEXTAREA = '[data-testid="intent-detail-spec-textarea"]'
  const SAVE = '[data-testid="intent-detail-spec-save"]'
  const CANCEL = '[data-testid="intent-detail-spec-cancel"]'
  const APPROVE = '[data-testid="intent-detail-spec-approve"]'
  const MODIFY = '[data-testid="intent-detail-spec-modify"]'

  // Mount on a spec-bearing intent, switch to the spec tab, and (by default)
  // provide loaded spec content so the editor can prefill.
  async function mountSpecTab(
    over: Partial<Intent> & { id: string },
    opts: { intentSpecContent?: string | null; specSessionRunning?: boolean } = {},
  ) {
    const item = intent({ specPath: SPEC_ABS, ...over })
    const w = mountDetail(item, {
      intentSpecContent: opts.intentSpecContent ?? '# spec source',
      specSessionRunning: opts.specSessionRunning,
    })
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    return { w, item }
  }

  it('shows the Edit entry only when specPath + todo + no lastWorkSessionId + no live spec session', async () => {
    // All three gates satisfied → visible.
    const { w } = await mountSpecTab({ id: 'ok', status: 'todo' })
    expect(w.find(EDIT).exists()).toBe(true)

    // No specPath → the tab renders empty and there is no edit entry.
    const noSpec = mountDetail(intent({ id: 'nospec', specPath: null }), { sddEnabled: true })
    await noSpec.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(noSpec.find(EDIT).exists()).toBe(false)

    // Development started (status not todo) → hidden.
    const started = await mountSpecTab({ id: 's1', status: 'in_progress' })
    expect(started.w.find(EDIT).exists()).toBe(false)

    // lastWorkSessionId set (started) even while todo → hidden.
    const hasWork = await mountSpecTab({ id: 's2', status: 'todo', lastWorkSessionId: 'w1' })
    expect(hasWork.w.find(EDIT).exists()).toBe(false)

    // A running spec session → hidden.
    const live = await mountSpecTab({ id: 's3', status: 'todo' }, { specSessionRunning: true })
    expect(live.w.find(EDIT).exists()).toBe(false)
  })

  it('clicking Edit swaps the rendered spec for a textarea prefilled with the loaded spec content', async () => {
    const { w } = await mountSpecTab({ id: 'i1' }, { intentSpecContent: '# original spec' })
    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)

    await w.find(EDIT).trigger('click')

    expect(w.find(EDITOR).exists()).toBe(true)
    expect(w.find('.req-detail').exists()).toBe(false)
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('# original spec')
    // Approve / modify / edit actions are hidden while editing (no concurrent approve/save).
    expect(w.find(EDIT).exists()).toBe(false)
    expect(w.find(MODIFY).exists()).toBe(false)
  })

  it('Save emits save-spec-content with the intent id and edited draft, then disables until refill', async () => {
    const { w } = await mountSpecTab({ id: 'i1' }, { intentSpecContent: '# original spec' })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# edited spec')
    await w.find(SAVE).trigger('click')

    expect(w.emitted('save-spec-content')).toEqual([['i1', '# edited spec']])
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)
  })

  it('Cancel discards the draft, restores the rendered spec, and emits nothing', async () => {
    const { w } = await mountSpecTab({ id: 'i1' }, { intentSpecContent: '# original spec' })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# scrapped')
    await w.find(CANCEL).trigger('click')

    expect(w.find(EDITOR).exists()).toBe(false)
    expect(w.find('.req-detail').exists()).toBe(true)
    expect(w.emitted('save-spec-content')).toBeUndefined()
    await w.find(EDIT).trigger('click')
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('# original spec')
  })

  it('leaves edit mode and re-reads once the server refills the intent (updatedAt bump)', async () => {
    const { w, item } = await mountSpecTab({ id: 'i1', updatedAt: 1 }, { intentSpecContent: '# a' })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# b')
    await w.find(SAVE).trigger('click')
    expect(w.find(EDITOR).exists()).toBe(true)

    // Success broadcast: same intent with a bumped updatedAt (approval reset also bumps it).
    await w.setProps({ intent: { ...item, updatedAt: 2, specApproved: false } })

    expect(w.find(EDITOR).exists()).toBe(false)
    // A read-spec is re-fired to render the freshly-saved content.
    const reads = w.emitted('read-spec') as unknown[][] | undefined
    expect(reads?.some((c) => c[0] === 'i1' && c[1] === SPEC_ABS)).toBe(true)
  })

  it('releases the save guard on a rejected save (error seq bump), keeping the editor open', async () => {
    const { w } = await mountSpecTab({ id: 'i1' }, { intentSpecContent: '# a' })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# b')
    await w.find(SAVE).trigger('click')
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)

    // A server rejection bumps the intent-action error seq.
    await w.setProps({ intentActionErrorSeq: 1 })

    // Editor stays open (draft preserved) but the save button is clickable again.
    expect(w.find(EDITOR).exists()).toBe(true)
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(false)
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('# b')
  })

  it('discards an in-progress spec edit when the selected intent changes', async () => {
    const a = intent({ id: 'a', specPath: SPEC_ABS })
    const b = intent({ id: 'b', specPath: SPEC_ABS })
    const w = mountDetail(a, { intents: [a, b], intentSpecContent: '# A spec' })
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# dirty')

    await w.setProps({ intent: b })

    // Back on the intent tab (reset) with no lingering spec editor.
    expect(w.find(EDITOR).exists()).toBe(false)
  })

  it('hides the approve action while editing the spec', async () => {
    // approveSpec state needs SDD on + specPath + unapproved; approve entry appears in spec tab.
    const item = intent({ id: 'i1', specPath: SPEC_ABS, specApproved: false })
    const w = mountDetail(item, { sddEnabled: true, intentSpecContent: '# a' })
    await w.find('.intent-detail-tab[data-tab="spec"]').trigger('click')
    expect(w.find(APPROVE).exists()).toBe(true)

    await w.find(EDIT).trigger('click')
    expect(w.find(APPROVE).exists()).toBe(false)
  })
})
