// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation, SessionInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { sortGlobalSessions, useGlobalBrowser } from './global-browser'

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
    globalSessionPages: ref({}),
    globalSessionRequestId: ref(null),
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
  it('merges 20 recent sessions then appends 10, retaining equal timestamp rows across projects', async () => {
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.flags.pendingConsoleBind).toBe(false)
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceName: 'alpha', limit: 20 }),
    )
    ctx.globalSessionPages.value = {
      alpha: { sessions: Array.from({ length: 20 }, (_, i) => session(40 - i * 2)), hasMore: true },
    }
    await nextTick()
    expect(browser.sessions.value).toHaveLength(0)
    ctx.globalSessionPages.value = {
      ...ctx.globalSessionPages.value,
      beta: { sessions: Array.from({ length: 20 }, (_, i) => session(39 - i * 2)), hasMore: false },
    }
    await nextTick()
    expect(browser.sessions.value).toHaveLength(20)
    expect(browser.sessions.value.at(-1)?.sessionId).toBe('s021')
    browser.requestSessions(true)
    expect(ctx.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        limit: 10,
        before: { lastModified: 100, sessionId: 's021', workspaceName: 'beta' },
      }),
    )
    ctx.globalSessionPages.value = {
      alpha: {
        sessions: Array.from({ length: 10 }, (_, i) => session(20 - i * 2)),
        hasMore: false,
      },
      beta: { sessions: Array.from({ length: 10 }, (_, i) => session(19 - i * 2)), hasMore: false },
    }
    await nextTick()
    expect(browser.sessions.value).toHaveLength(30)
    expect(browser.sessions.value.at(-1)?.sessionId).toBe('s011')
    expect(browser.hasMore.value).toBe(true)
    browser.selectSession(browser.sessions.value[1])
    expect(ctx.selectSession).toHaveBeenCalledWith(
      'beta',
      's039',
      expect.objectContaining({ workspaceName: 'beta' }),
    )
    wrapper.unmount()
  })

  it('times out missing workspace replies and allows a fresh request', async () => {
    vi.useFakeTimers()
    const { ctx, browser, wrapper } = setup()
    browser.open('sessions')
    const old = ctx.globalSessionRequestId.value
    await vi.advanceTimersByTimeAsync(15000)
    expect(browser.failed.value).toBe(true)
    expect(browser.loading.value).toBe(false)
    expect(ctx.globalSessionRequestId.value).toBeNull()
    browser.requestSessions()
    expect(ctx.globalSessionRequestId.value).not.toBe(old)
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

  it('breaks duplicate native ids by workspace consistently', () => {
    expect(
      sortGlobalSessions([
        { ...session(1), workspaceName: 'beta' },
        { ...session(1), workspaceName: 'alpha' },
      ]).map((row) => row.workspaceName),
    ).toEqual(['alpha', 'beta'])
  })
})
