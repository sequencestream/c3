// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation, SessionInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { useGlobalBrowser } from './global-browser'

function session(id: number): SessionInfo {
  return {
    sessionId: `s${String(id).padStart(3, '0')}`,
    title: `Session ${id}`,
    lastModified: 100,
    mode: 'default',
    vendor: 'claude',
    isToolSession: false,
    sessionKind: 'work',
  }
}
function setup() {
  const ctx = {
    globalPage: ref(null),
    globalSessionSelection: ref(null),
    globalSessionCreatingWorkspace: ref(null),
    globalSessionPages: ref({}),
    globalSessionLivePage: ref(null),
    globalSessionRequestIds: ref({}),
    workspaces: ref([{ name: 'alpha' }, { name: 'beta' }]),
    automations: ref({}),
    viewMode: ref('workspace'),
    activeTab: ref('intents'),
    status: ref('open'),
    activeWorkspace: ref(null),
    activeSessionKind: ref('work'),
    personalizedSettingOpen: ref(false),
    workspaceSettingOpen: ref(false),
    selectedAutomationId: ref(null),
    selectedExecutionId: ref(null),
    automationsProject: ref(null),
    automationToolManifest: ref({}),
    automationFormOpen: ref(false),
    flags: { pendingConsoleBind: true },
    send: vi.fn(),
    closeSettings: vi.fn(),
    clearViewedSession: vi.fn(),
    setViewMode: vi.fn(),
    selectSession: vi.fn(),
    onSelectAutomation: vi.fn(),
    openAutomations: vi.fn(),
  } as unknown as AppCtx
  let browser!: ReturnType<typeof useGlobalBrowser>
  const wrapper = mount(
    defineComponent({
      setup() {
        browser = useGlobalBrowser(ctx)
        return () => h('div')
      },
    }),
  )
  return { ctx, browser, wrapper }
}
afterEach(() => vi.useRealTimers())

describe('global browser', () => {
  it('upserts live sessions into global groups while preserving their loaded window', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    ctx.globalSessionPages.value = {
      alpha: { sessions: [session(1)], hasMore: false },
      beta: { sessions: [session(2)], hasMore: true },
    }
    await nextTick()
    ctx.globalSessionLivePage.value = {
      workspaceName: 'beta',
      sessions: Array.from({ length: 7 }, (_, i) => ({ ...session(i + 2), lastModified: 200 + i })),
    }
    await nextTick()
    const beta = browser.sessions.value.filter((row) => row.workspaceName === 'beta')
    expect(beta).toHaveLength(7)
    expect(beta.map((row) => row.lastModified)).toEqual([206, 205, 204, 203, 202, 201, 200])
    expect(browser.paging.value.beta.hasMore).toBe(true)
    expect(browser.sessions.value.find((row) => row.workspaceName === 'alpha')?.sessionId).toBe(
      's001',
    )
    ctx.globalSessionLivePage.value = { workspaceName: 'secret', sessions: [session(9)] }
    await nextTick()
    expect(browser.sessions.value.some((row) => row.workspaceName === 'secret')).toBe(false)
    wrapper.unmount()
  })

  it('replaces a newly created pending session with its bound identity', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    ctx.globalSessionPages.value = { alpha: { sessions: [session(1)], hasMore: false } }
    await nextTick()
    const pending = { ...session(2), sessionId: 'pending:new', lastModified: 200 }
    ctx.globalSessionLivePage.value = { workspaceName: 'alpha', sessions: [pending] }
    ctx.globalSessionLivePage.value = {
      workspaceName: 'alpha',
      sessions: [{ ...pending, sessionId: 'bound' }],
      replaceSessionId: 'pending:new',
    }
    expect(browser.sessions.value.map((row) => row.sessionId)).toEqual(['bound', 's001'])
    wrapper.unmount()
  })

  it('keeps a new session when its live push arrives before an older initial page', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    ctx.globalSessionLivePage.value = {
      workspaceName: 'beta',
      sessions: [{ ...session(20), lastModified: 500 }],
    }
    ctx.globalSessionLivePage.value = {
      workspaceName: 'alpha',
      sessions: [{ ...session(30), lastModified: 600 }],
    }
    ctx.globalSessionPages.value = {
      beta: { sessions: [session(2)], hasMore: false },
      alpha: { sessions: [session(1)], hasMore: false },
    }
    await nextTick()
    expect(browser.sessions.value.map((row) => row.sessionId)).toContain('s020')
    expect(browser.sessions.value.map((row) => row.sessionId)).toContain('s030')
    wrapper.unmount()
  })

  it('loads five per workspace independently and appends only to the requested group', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.flags.pendingConsoleBind).toBe(false)
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceName: 'alpha', limit: 5 }),
    )
    ctx.globalSessionPages.value = {
      alpha: {
        sessions: [session(10), session(9), session(8), session(7), session(6)],
        hasMore: true,
      },
    }
    await nextTick()
    expect(browser.sessions.value).toHaveLength(5)
    expect(browser.paging.value.alpha.loading).toBe(false)
    expect(browser.paging.value.beta.loading).toBe(true)
    ctx.globalSessionPages.value = {
      ...ctx.globalSessionPages.value,
      beta: { sessions: [session(20)], hasMore: false },
    }
    await nextTick()
    const previousCalls = vi.mocked(ctx.send).mock.calls.length
    browser.requestSessions(true, 'alpha')
    browser.requestSessions(true, 'alpha')
    expect(vi.mocked(ctx.send).mock.calls.length).toBe(previousCalls + 1)
    expect(ctx.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceName: 'alpha',
        limit: 5,
        before: { lastModified: 100, sessionId: 's006', workspaceName: 'alpha' },
      }),
    )
    ctx.globalSessionPages.value = {
      ...ctx.globalSessionPages.value,
      alpha: {
        sessions: [session(5), session(4), session(3), session(2), session(1)],
        hasMore: false,
      },
    }
    await nextTick()
    expect(browser.sessions.value.filter((row) => row.workspaceName === 'alpha')).toHaveLength(10)
    expect(browser.sessions.value.filter((row) => row.workspaceName === 'beta')).toHaveLength(1)
    expect(browser.paging.value.alpha.hasMore).toBe(false)
    browser.selectSession(browser.sessions.value[0])
    expect(ctx.selectSession).toHaveBeenCalledWith(
      'beta',
      's020',
      expect.objectContaining({ workspaceName: 'beta' }),
    )
    wrapper.unmount()
  })

  it('opens a notification session before the first page arrives and keeps it last without changing the cursor', async () => {
    const { ctx, browser, wrapper } = setup()
    ctx.openGlobalSession({
      workspaceName: 'alpha',
      sessionKind: 'work',
      sessionId: 'old',
      title: 'Old session',
      updatedAt: 1,
    })
    expect(browser.page.value).toBe('sessions')
    expect(ctx.selectSession).toHaveBeenCalledWith(
      'alpha',
      'old',
      expect.objectContaining({ title: 'Old session' }),
    )
    const first = [session(10), session(9), session(8), session(7), session(6)]
    ctx.globalSessionPages.value = { alpha: { sessions: first, hasMore: true } }
    await nextTick()
    expect(
      browser.sessions.value.filter((r) => r.workspaceName === 'alpha').map((r) => r.sessionId),
    ).toEqual([...first.map((r) => r.sessionId), 'old'])
    browser.requestSessions(true, 'alpha')
    expect(ctx.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        before: { workspaceName: 'alpha', sessionId: 's006', lastModified: 100 },
      }),
    )
    ctx.globalSessionPages.value = { alpha: { sessions: [session(5)], hasMore: true } }
    await nextTick()
    expect(browser.sessions.value.at(-1)?.sessionId).toBe('old')
    ctx.globalSessionLivePage.value = {
      workspaceName: 'alpha',
      sessions: [{ ...session(11), lastModified: 200 }],
    }
    expect(browser.sessions.value.at(-1)?.sessionId).toBe('old')
    browser.requestSessions()
    ctx.globalSessionPages.value = { alpha: { sessions: first, hasMore: true } }
    await nextTick()
    expect(browser.sessions.value.at(-1)?.sessionId).toBe('old')
    wrapper.unmount()
  })

  it('selects an already loaded target once and replaces an inserted row when pagination reaches it', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    ctx.globalSessionPages.value = { alpha: { sessions: [session(10)], hasMore: true } }
    await nextTick()
    ctx.openGlobalSession({ workspaceName: 'alpha', sessionKind: 'work', sessionId: 's010' })
    expect(browser.sessions.value).toHaveLength(1)
    ctx.openGlobalSession({
      workspaceName: 'alpha',
      sessionKind: 'spec_review',
      sessionId: 's001',
      intentId: 'intent-1',
    })
    expect(ctx.selectSession).toHaveBeenLastCalledWith(
      'alpha',
      's001',
      expect.objectContaining({
        ownerKind: 'intent',
        ownerId: 'intent-1',
        sessionKind: 'spec_review',
      }),
    )
    browser.requestSessions(true, 'alpha')
    ctx.globalSessionPages.value = { alpha: { sessions: [session(1)], hasMore: false } }
    await nextTick()
    expect(browser.sessions.value.filter((r) => r.sessionId === 's001')).toHaveLength(1)
    expect(browser.sessions.value.at(-1)?.title).toBe('Session 1')
    wrapper.unmount()
  })

  it('ignores notification targets outside accessible workspaces', () => {
    const { ctx, browser, wrapper } = setup()
    ctx.openGlobalSession({ workspaceName: 'secret', sessionKind: 'work', sessionId: 'hidden' })
    expect(browser.page.value).toBeNull()
    expect(ctx.selectSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('times out and retries one group without resetting successful groups', async () => {
    vi.useFakeTimers()
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    const old = ctx.globalSessionRequestIds.value.beta
    ctx.globalSessionPages.value = { alpha: { sessions: [session(1)], hasMore: false } }
    await nextTick()
    await vi.advanceTimersByTimeAsync(15000)
    expect(browser.paging.value.beta.failed).toBe(true)
    expect(browser.paging.value.alpha.failed).toBe(false)
    expect(ctx.globalSessionRequestIds.value.beta).toBeUndefined()
    browser.requestSessions(true, 'beta')
    expect(ctx.globalSessionRequestIds.value.beta).not.toBe(old)
    expect(browser.sessions.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('only aggregates accessible automations and selects their owning workspace', async () => {
    const { ctx, browser, wrapper } = setup()
    ctx.automations.value = {
      alpha: [{ id: 'a', workspaceName: 'alpha' } as Automation],
      secret: [{ id: 'secret' } as Automation],
    }
    browser.open('automations')
    expect(browser.automations.value.map((a) => a.id)).toEqual(['a'])
    expect(ctx.onSelectAutomation).not.toHaveBeenCalled()
    browser.selectAutomation('a')
    expect(ctx.openAutomations).toHaveBeenCalledWith('alpha')
    expect(ctx.onSelectAutomation).toHaveBeenCalledWith('a')
    ctx.workspaces.value = []
    await nextTick()
    expect(browser.automations.value).toEqual([])
    wrapper.unmount()
  })
})
