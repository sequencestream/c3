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
    globalSessionPages: ref({}),
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
