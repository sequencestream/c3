import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { Intent, SessionStatus } from '@ccc/shared/protocol'
import {
  useIntentDetailTabs,
  type DetailTab,
  type RequestedDetailSubTab,
} from './useIntentDetailTabs'

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
    ...overrides,
    id: overrides.id,
  }
}

interface Calls {
  readSpec: [string, string][]
  listLogs: string[]
  openIntent: string[]
  openSpec: string[]
  openSpecReview: string[]
  openWork: string[]
  consumed: number
}

function freshCalls(): Calls {
  return {
    readSpec: [],
    listLogs: [],
    openIntent: [],
    openSpec: [],
    openSpecReview: [],
    openWork: [],
    consumed: 0,
  }
}

function mountHost(props: Record<string, unknown>) {
  // calls 用闭包捕获(而非 prop)以记录回调调用,避免测试组件变更 prop。
  const calls = freshCalls()
  // 宿主组件:把 composable 的响应式结果暴露到 vm,并把回调调用记录到闭包的 calls。
  const Host = defineComponent({
    props: {
      intent: { type: Object as () => Intent | null, default: null },
      sddEnabled: { type: Boolean, default: false },
      activeSession: { type: String as () => string | null, default: null },
      requestedSubTab: {
        type: String as () => RequestedDetailSubTab | null,
        default: null,
      },
      intentLogsLength: { type: Number, default: 0 },
      workSessionStatus: { type: String as () => SessionStatus | null, default: null },
      intentSessionStatus: { type: String as () => SessionStatus | null, default: null },
      specSessionStatus: { type: String as () => SessionStatus | null, default: null },
      specReviewSessionStatus: { type: String as () => SessionStatus | null, default: null },
    },
    setup(hostProps) {
      const tabs = useIntentDetailTabs({
        intent: () => hostProps.intent,
        sddEnabled: () => hostProps.sddEnabled,
        activeSession: () => hostProps.activeSession,
        requestedSubTab: () => hostProps.requestedSubTab,
        intentLogsLength: () => hostProps.intentLogsLength,
        workSessionStatus: () => hostProps.workSessionStatus,
        intentSessionStatus: () => hostProps.intentSessionStatus,
        specSessionStatus: () => hostProps.specSessionStatus,
        specReviewSessionStatus: () => hostProps.specReviewSessionStatus,
        onReadSpec: (id, p) => calls.readSpec.push([id, p]),
        onListIntentLogs: (id) => calls.listLogs.push(id),
        onOpenIntentSession: (s) => calls.openIntent.push(s),
        onOpenSpecSession: (id) => calls.openSpec.push(id),
        onOpenSpecReviewSession: (id) => calls.openSpecReview.push(id),
        onOpenWorkSession: (s) => calls.openWork.push(s),
        onRequestedSubTabConsumed: () => (calls.consumed += 1),
      })
      return { tabs }
    },
    render() {
      return h('div')
    },
  })
  const w = mount(Host, { props })
  const tabs = () => (w.vm as unknown as { tabs: ReturnType<typeof useIntentDetailTabs> }).tabs
  const activeTab = () => tabs().activeTab.value
  const visibleKeys = () => tabs().visibleTabs.value.map((t) => t.key)
  const select = async (tab: DetailTab) => {
    tabs().selectTab(tab)
    await w.vm.$nextTick()
  }
  return { w, calls, tabs, activeTab, visibleKeys, select }
}

describe('useIntentDetailTabs', () => {
  it('hides spec tabs when SDD off and no history; shows them with history data', () => {
    const off = mountHost({ intent: intent({ id: 'i1', specPath: null, specSessionId: null }) })
    expect(off.visibleKeys()).toEqual(['intent', 'intentSession', 'changelog'])

    const hist = mountHost({
      intent: intent({ id: 'i2', specPath: '.s/spec.md', specSessionId: null }),
    })
    expect(hist.visibleKeys()).toEqual([
      'intent',
      'intentSession',
      'spec',
      'specSession',
      'changelog',
    ])

    const sdd = mountHost({ intent: intent({ id: 'i3' }), sddEnabled: true })
    expect(sdd.visibleKeys()).toContain('spec')
  })

  it('defaults to intent session for empty content, intent tab otherwise, on intent switch', async () => {
    const { w, activeTab } = mountHost({ intent: intent({ id: 'a', content: 'Body' }) })
    expect(activeTab()).toBe('intent')

    await w.setProps({ intent: intent({ id: 'b', content: '   \n\t' }) })
    expect(activeTab()).toBe('intentSession')

    await w.setProps({ intent: intent({ id: 'c', content: 'Has body' }) })
    expect(activeTab()).toBe('intent')
  })

  it('does not preempt the current tab when only content changes on the same intent', async () => {
    const { w, activeTab, select } = mountHost({ intent: intent({ id: 'i1', content: 'body' }) })
    await select('changelog')
    await w.setProps({ intent: intent({ id: 'i1', content: '', updatedAt: 2 }) })
    expect(activeTab()).toBe('changelog')
  })

  it('lazy-loads spec on read and changelog once when empty', async () => {
    const h1 = mountHost({ intent: intent({ id: 'i1', specPath: '.s/spec.md' }), sddEnabled: true })
    await h1.select('spec')
    expect(h1.calls.readSpec).toEqual([['i1', '.s/spec.md']])
    await h1.select('changelog')
    expect(h1.calls.listLogs).toEqual(['i1'])

    // 已有日志缓存(length>0)不再懒加载。
    const h2 = mountHost({ intent: intent({ id: 'i2' }), intentLogsLength: 3 })
    await h2.select('changelog')
    expect(h2.calls.listLogs).toEqual([])
  })

  it('falls back to the intent tab when the active tab becomes hidden', async () => {
    const { w, activeTab, select } = mountHost({
      intent: intent({ id: 'i1', specSessionId: 'sess-spec' }),
      sddEnabled: false,
    })
    await select('specSession')
    expect(activeTab()).toBe('specSession')

    await w.setProps({ intent: intent({ id: 'i1', specSessionId: null }) })
    expect(activeTab()).toBe('intent')
  })

  it('consumes an external requestedSubTab exactly once and ignores hidden targets', async () => {
    const { w, calls, activeTab } = mountHost({
      intent: intent({ id: 'i1', specSessionId: null, specPath: null }),
      sddEnabled: false,
    })
    // 目标不可见 → 不切换,仍消费一次。
    await w.setProps({ requestedSubTab: 'specSession' })
    expect(activeTab()).toBe('intent')
    expect(calls.openSpec).toEqual([])
    expect(calls.consumed).toBe(1)
  })

  it('backfills a session open when the id arrives after switching, deduping once aligned', async () => {
    const { w, calls, tabs, select } = mountHost({
      intent: intent({ id: 'i1', intentSessionId: null }),
    })
    await select('intentSession')
    expect(calls.openIntent).toEqual([])
    expect(tabs().firstIntentTurn.value).toBe(true)

    // sessionId 异步回填 → 补发一次 open。
    await w.setProps({ intent: intent({ id: 'i1', intentSessionId: 'sess' }) })
    expect(calls.openIntent).toEqual(['sess'])
    expect(tabs().chatReady.value).toBe(false)

    // 活动会话对齐 → chatReady,且不重复补发。
    await w.setProps({ activeSession: 'sess' })
    expect(tabs().chatReady.value).toBe(true)
    expect(calls.openIntent).toEqual(['sess'])
  })

  it('exposes status dots only for non-idle known statuses and mode locking off work tab', async () => {
    const { w, tabs, select } = mountHost({
      intent: intent({ id: 'i1', intentSessionId: 's', lastWorkSessionId: 'w' }),
      intentSessionStatus: 'running',
      workSessionStatus: 'idle',
    })
    expect(tabs().intentSessionStatusDot.value).toBe('running')
    expect(tabs().workSessionStatusDot.value).toBe(null)

    await select('intentSession')
    expect(tabs().modeLocked.value).toBe(true)
    await select('workSession')
    expect(tabs().modeLocked.value).toBe(false)
    void w
  })

  it.each<SessionStatus>(['running', 'awaiting_permission', 'team', 'reconnecting'])(
    'exposes the spec session dot for the non-idle status %s',
    async (status) => {
      const { w, tabs } = mountHost({
        intent: intent({ id: 'i1', specSessionId: 's-spec' }),
        sddEnabled: true,
        specSessionStatus: status,
      })
      expect(tabs().specSessionStatusDot.value).toBe(status)

      // idle / 未知(null)均不产出状态点。
      await w.setProps({ specSessionStatus: 'idle' })
      expect(tabs().specSessionStatusDot.value).toBe(null)
      await w.setProps({ specSessionStatus: null })
      expect(tabs().specSessionStatusDot.value).toBe(null)
    },
  )

  it('keeps the spec session dot independent of the other two session dots', () => {
    const { tabs } = mountHost({
      intent: intent({
        id: 'i1',
        intentSessionId: 's-intent',
        specSessionId: 's-spec',
        lastWorkSessionId: 's-work',
      }),
      sddEnabled: true,
      specSessionStatus: 'running',
      intentSessionStatus: 'idle',
      workSessionStatus: 'idle',
    })
    expect(tabs().specSessionStatusDot.value).toBe('running')
    expect(tabs().intentSessionStatusDot.value).toBe(null)
    expect(tabs().workSessionStatusDot.value).toBe(null)
  })

  it('shows the review tab only with SDD on AND a review session id', async () => {
    // 无评审会话 → 隐藏。
    const none = mountHost({ intent: intent({ id: 'i1' }), sddEnabled: true })
    expect(none.visibleKeys()).not.toContain('specReviewSession')

    // SDD 关闭(即便有历史评审会话)→ 隐藏。
    const sddOff = mountHost({
      intent: intent({ id: 'i2', specReviewSessionId: 'rev-1' }),
      sddEnabled: false,
    })
    expect(sddOff.visibleKeys()).not.toContain('specReviewSession')

    // 两者齐备 → 显示,且排在编写规范会话之后。
    const on = mountHost({
      intent: intent({ id: 'i3', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    expect(on.visibleKeys()).toEqual([
      'intent',
      'intentSession',
      'spec',
      'specSession',
      'specReviewSession',
      'changelog',
    ])
    await on.w.vm.$nextTick()
  })

  it('falls back to the intent tab when the review tab loses visibility', async () => {
    const { w, activeTab, select } = mountHost({
      intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    await select('specReviewSession')
    expect(activeTab()).toBe('specReviewSession')

    await w.setProps({ intent: intent({ id: 'i1', specReviewSessionId: null }) })
    expect(activeTab()).toBe('intent')
  })

  it('opens the review session once per target, backfilling a late id and deduping when aligned', async () => {
    const { w, calls, tabs, select } = mountHost({
      intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    // 打开请求携带的是意图 id(服务端按意图解析评审会话),不是会话 id。
    await select('specReviewSession')
    expect(calls.openSpecReview).toEqual(['i1'])
    // 活动会话尚未对齐 → 不渲染聊天列。
    expect(tabs().chatReady.value).toBe(false)

    await w.setProps({ activeSession: 'rev-1' })
    expect(tabs().chatReady.value).toBe(true)
    // 已对齐 → 不重复发送。
    expect(calls.openSpecReview).toEqual(['i1'])
  })

  it('backfills the review open when the id arrives after the tab is active', async () => {
    const { w, calls, select } = mountHost({
      intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    await select('specReviewSession')
    calls.openSpecReview.length = 0

    // 评审会话被换成新一轮的会话 → 补发一次。
    await w.setProps({ intent: intent({ id: 'i1', specReviewSessionId: 'rev-2' }) })
    expect(calls.openSpecReview).toEqual(['i1'])
  })

  it('marks the review tab read-only and never the other session tabs', async () => {
    const { tabs, select } = mountHost({
      intent: intent({
        id: 'i1',
        specReviewSessionId: 'rev-1',
        specSessionId: 's-spec',
        specPath: '.s/spec.md',
        lastWorkSessionId: 'w-1',
      }),
      sddEnabled: true,
    })
    await select('specReviewSession')
    expect(tabs().chatReadonly.value).toBe(true)
    // 只读不放宽模式锁(评审会话的权限模式同样由服务端钉死)。
    expect(tabs().modeLocked.value).toBe(true)

    await select('specSession')
    expect(tabs().chatReadonly.value).toBe(false)
    await select('workSession')
    expect(tabs().chatReadonly.value).toBe(false)
  })

  it.each<SessionStatus>(['running', 'awaiting_permission', 'team', 'reconnecting'])(
    'exposes the review session dot for the non-idle status %s',
    async (status) => {
      const { w, tabs } = mountHost({
        intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
        sddEnabled: true,
        specReviewSessionStatus: status,
      })
      expect(tabs().specReviewSessionStatusDot.value).toBe(status)

      await w.setProps({ specReviewSessionStatus: 'idle' })
      expect(tabs().specReviewSessionStatusDot.value).toBe(null)
      await w.setProps({ specReviewSessionStatus: null })
      expect(tabs().specReviewSessionStatusDot.value).toBe(null)
    },
  )

  it('routes an external specReviewSession request to the review tab exactly once', async () => {
    const { w, calls, activeTab } = mountHost({
      intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    await w.setProps({ requestedSubTab: 'specReviewSession' })
    expect(activeTab()).toBe('specReviewSession')
    expect(calls.openSpecReview).toEqual(['i1'])
    expect(calls.consumed).toBe(1)
  })

  it('does not open a review session for a different intent after switching', async () => {
    const { w, calls, activeTab, select } = mountHost({
      intent: intent({ id: 'i1', specReviewSessionId: 'rev-1' }),
      sddEnabled: true,
    })
    await select('specReviewSession')
    calls.openSpecReview.length = 0

    // 切到没有评审会话的意图:tab 不可见 → 回到意图正文,且不发打开请求。
    await w.setProps({ intent: intent({ id: 'i2', content: 'body' }) })
    expect(activeTab()).toBe('intent')
    expect(calls.openSpecReview).toEqual([])
  })

  it('auto-switches to spec session after a marked pending switch backfills a new id', async () => {
    const { w, activeTab, tabs, select } = mountHost({
      intent: intent({ id: 'i1', specPath: '.s/spec.md', specSessionId: 'old' }),
    })
    await select('spec')
    tabs().markPendingSpecSwitch('i1', 'old')

    // 未变化 → 不切。
    await w.setProps({ intent: intent({ id: 'i1', specPath: '.s/spec.md', specSessionId: 'old' }) })
    expect(activeTab()).toBe('spec')

    // 新会话回填 → 切到 specSession。
    await w.setProps({ intent: intent({ id: 'i1', specPath: '.s/spec.md', specSessionId: 'new' }) })
    expect(activeTab()).toBe('specSession')
  })
})
