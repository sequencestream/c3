import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkSessionList from './WorkSessionList.vue'
import type {
  SessionCapabilities,
  SessionInfo,
  SessionStatus,
  VendorId,
} from '@ccc/shared/protocol'

const WS = '/home/proj-a'

function session(id: string, title: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, title, lastModified: 1_700_000_000_000, ...extra } as SessionInfo
}

function mountList(
  opts: {
    sessions?: SessionInfo[]
    status?: Record<string, SessionStatus>
    currentWorkspace?: string | null
    activeSession?: string | null
    vendorSessionCaps?: Partial<Record<VendorId, SessionCapabilities>>
    hasMore?: boolean
    exhausted?: boolean
    activeSessionKind?: 'work' | 'intent' | 'spec' | 'discussion' | 'schedule' | 'tool'
    showToolSessions?: boolean
  } = {},
) {
  return mount(WorkSessionList, {
    props: {
      currentWorkspace: opts.currentWorkspace === undefined ? WS : opts.currentWorkspace,
      sessions: opts.sessions ?? [],
      activeSessionKind: opts.activeSessionKind ?? 'work',
      sessionCounts: { work: 0, intent: 0, spec: 0, discussion: 0, schedule: 0, tool: 0 },
      showToolSessions: opts.showToolSessions ?? false,
      hasMore: opts.hasMore ?? false,
      exhausted: opts.exhausted ?? false,
      sessionStatus: opts.status ?? {},
      activeWorkspace: WS,
      activeSession: opts.activeSession ?? null,
      activeTitle: '',
      vendorSessionCaps: opts.vendorSessionCaps,
    },
  })
}

/** A full SessionCapabilities ledger with the listed overrides applied. */
function caps(overrides: Partial<SessionCapabilities>): SessionCapabilities {
  return {
    list: 'full',
    read: 'full',
    resume: 'full',
    rename: 'full',
    delete: 'full',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkSessionList.vue — 当前工作区会话列表', () => {
  it('无工作区 → 空提示,不渲染列表', () => {
    const w = mountList({ currentWorkspace: null })
    expect(w.find('[data-testid="session-list-empty"]').exists()).toBe(true)
    expect(w.findAll('.session').length).toBe(0)
  })

  it('渲染会话列表,点击 → emit select-session(path, id)', async () => {
    const w = mountList({ sessions: [session('s1', 'Alpha'), session('s2', 'Beta')] })
    const rows = w.findAll('.session')
    expect(rows.length).toBe(2)
    await rows[1].trigger('click')
    expect(w.emitted('select-session')).toEqual([[WS, 's2']])
  })

  it('选中项高亮 active,awaiting_permission 项加 awaiting', () => {
    const w = mountList({
      sessions: [session('s1', 'Alpha'), session('s2', 'Beta')],
      status: { s2: 'awaiting_permission' },
      activeSession: 's1',
    })
    const rows = w.findAll('.session')
    expect(rows[0].classes()).toContain('active')
    expect(rows[1].classes()).toContain('awaiting')
  })

  it('状态徽标:非 idle 才渲染 .session-status,带状态 class', () => {
    const w = mountList({
      sessions: [session('s1', 'Alpha'), session('s2', 'Beta')],
      status: { s1: 'running' },
    })
    const rows = w.findAll('.session')
    const badge = rows[0].find('.session-status')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('running')
    expect(rows[1].find('.session-status').exists()).toBe(false)
  })

  it('分页(服务端驱动):渲染全部已加载会话,不再客户端截断', () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${i}`, `S${i}`))
    const w = mountList({ sessions: many, hasMore: false })
    expect(w.findAll('.session').length).toBe(12)
  })

  it('hasMore=true → 显示「加载更多」,点击 emit load-more-sessions', async () => {
    const w = mountList({ sessions: [session('s1', 'Alpha')], hasMore: true })
    const more = w.find('[data-testid="session-list-more"]')
    expect(more.exists()).toBe(true)
    await more.trigger('click')
    expect(w.emitted('load-more-sessions')).toEqual([[]])
  })

  it('schedule tab is enabled and emits select-session-kind', async () => {
    const w = mountList()
    const scheduleTab = w
      .findAll('.session-kind-tab')
      .find((button) => button.text().includes('Schedule'))
    expect(scheduleTab?.attributes('disabled')).toBeUndefined()
    await scheduleTab!.trigger('click')
    expect(w.emitted('select-session-kind')).toEqual([['schedule']])
  })

  it('标题栏左侧渲染 kind 入口,不再渲染固定会话标题', () => {
    const w = mountList({ showToolSessions: true })
    const headerTabs = w.find('.sidebar-head-left [data-testid="session-kind-tabs"]')
    expect(headerTabs.exists()).toBe(true)
    expect(w.find('.sidebar-title').exists()).toBe(false)
    expect(w.findAll('.sidebar-head-left .session-kind-tab').map((tab) => tab.text())).toEqual([
      'Work',
      'Intent',
      'Spec',
      'Discussion',
      'Schedule',
      'Tool',
    ])
  })

  it('exhausted=true(且有会话)→ 显示「已加载完」,不显示加载更多', () => {
    const w = mountList({
      sessions: [session('s1', 'Alpha')],
      hasMore: false,
      exhausted: true,
    })
    expect(w.find('[data-testid="session-list-more"]').exists()).toBe(false)
    const done = w.find('[data-testid="session-list-exhausted"]')
    expect(done.exists()).toBe(true)
    expect(done.text()).toBe('Fully loaded')
  })

  it('首批短列表(未触发加载更多)→ 既无加载更多也无「已加载完」', () => {
    const w = mountList({ sessions: [session('s1', 'Alpha')], hasMore: false, exhausted: false })
    expect(w.find('[data-testid="session-list-more"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-list-exhausted"]').exists()).toBe(false)
  })

  it('新建 ＋ → emit create-session(path)', async () => {
    const w = mountList()
    const btns = w.findAll('.sidebar-head .icon-btn')
    // work kind 下会话头部为「刷新 + 新建」两枚按钮。
    expect(btns.length).toBe(2)
    await w.find('[data-testid="session-list-new"]').trigger('click')
    expect(w.emitted('create-session')).toEqual([[WS]])
  })

  it.each(['intent', 'spec', 'discussion', 'schedule', 'tool'] as const)(
    '%s kind 下不渲染新建按钮',
    (activeSessionKind) => {
      const w = mountList({ activeSessionKind, showToolSessions: true })
      expect(w.find('[data-testid="session-list-refresh"]').exists()).toBe(true)
      expect(w.find('[data-testid="session-list-new"]').exists()).toBe(false)
    },
  )

  it('工具 tab 只在 showToolSessions 开启时可选', async () => {
    const hidden = mountList()
    const hiddenTool = hidden.findAll('.session-kind-tab').at(5)!
    expect((hiddenTool.element as HTMLButtonElement).disabled).toBe(true)
    await hiddenTool.trigger('click')
    expect(hidden.emitted('select-session-kind')).toBeUndefined()

    const shown = mount(WorkSessionList, {
      props: {
        ...hidden.props(),
        showToolSessions: true,
      },
    })
    const shownTool = shown.findAll('.session-kind-tab').at(5)!
    expect((shownTool.element as HTMLButtonElement).disabled).toBe(false)
    await shownTool.trigger('click')
    expect(shown.emitted('select-session-kind')).toEqual([['tool']])
  })

  it('刷新按钮 → emit refresh-sessions;无工作区时不渲染', async () => {
    const w = mountList()
    await w.find('[data-testid="session-list-refresh"]').trigger('click')
    expect(w.emitted('refresh-sessions')).toEqual([[]])

    const none = mountList({ currentWorkspace: null })
    expect(none.find('[data-testid="session-list-refresh"]').exists()).toBe(false)
  })

  it('讨论 tab 可点击并上抛 select-session-kind', async () => {
    const w = mountList()
    const tabs = w.findAll('.session-kind-tab')
    const discussionTab = tabs.find((tab) => tab.text().includes('Discussion'))!
    expect((discussionTab.element as HTMLButtonElement).disabled).toBe(false)
    await discussionTab.trigger('click')
    expect(w.emitted('select-session-kind')).toEqual([['discussion']])
  })

  it('讨论会话行不渲染重命名/删除动作', () => {
    const w = mountList({
      sessions: [
        session('discussion-agent-session', 'Discussion agent', {
          vendor: 'claude',
          sessionKind: 'discussion',
          ownerKind: 'discussion',
          ownerId: 'discussion-1',
        }),
      ],
    })
    expect(w.find('[data-testid="session-row-rename"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-row-delete"]').exists()).toBe(false)
  })

  it('重命名:prompt 有值 → emit rename-session(path, id, title)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  New Name  ')
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    await w.find('[data-testid="session-row-rename"]').trigger('click')
    expect(w.emitted('rename-session')).toEqual([[WS, 's1', 'New Name']])
  })

  it('重命名:prompt 取消(null)→ 不 emit', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    await w.find('[data-testid="session-row-rename"]').trigger('click')
    expect(w.emitted('rename-session')).toBeUndefined()
  })

  it('删除:confirm 通过 → emit delete-session;取消 → 不 emit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    const delBtn = () => w.find('[data-testid="session-row-delete"]')
    await delBtn().trigger('click')
    expect(w.emitted('delete-session')).toBeUndefined()
    confirm.mockReturnValue(true)
    await delBtn().trigger('click')
    expect(w.emitted('delete-session')).toEqual([[WS, 's1']])
  })

  describe('按能力态降级行操作(ADR-0011,零 if-vendor)', () => {
    it('无 vendorSessionCaps(settings 未到)→ 乐观启用:两枚按钮均渲染且可用', () => {
      const w = mountList({ sessions: [session('s1', 'Alpha', { vendor: 'claude' })] })
      const rename = w.find('[data-testid="session-row-rename"]')
      const del = w.find('[data-testid="session-row-delete"]')
      expect(rename.exists()).toBe(true)
      expect(del.exists()).toBe(true)
      expect((rename.element as HTMLButtonElement).disabled).toBe(false)
      expect((del.element as HTMLButtonElement).disabled).toBe(false)
    })

    it("rename='none'(Codex)→ 重命名按钮隐藏;delete='none' → 删除按钮隐藏", () => {
      const w = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'codex' })],
        vendorSessionCaps: { codex: caps({ rename: 'none', delete: 'none' }) },
      })
      expect(w.find('[data-testid="session-row-rename"]').exists()).toBe(false)
      expect(w.find('[data-testid="session-row-delete"]').exists()).toBe(false)
    })

    it('temporarily-unavailable(Codex)→ 按钮渲染但禁用,tooltip 为暂不可用', () => {
      const w = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'codex' })],
        vendorSessionCaps: {
          codex: caps({ rename: 'temporarily-unavailable', delete: 'temporarily-unavailable' }),
        },
      })
      const del = w.find('[data-testid="session-row-delete"]')
      expect(del.exists()).toBe(true)
      expect((del.element as HTMLButtonElement).disabled).toBe(true)
      // 走的是 unavailable 文案,而非普通 delete 文案。
      expect(del.attributes('title')).toBe('Temporarily unavailable for this agent')
    })

    it('full(Claude)→ 启用,点击照常 emit', async () => {
      vi.spyOn(window, 'prompt').mockReturnValue('New')
      const w = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'claude' })],
        vendorSessionCaps: { claude: caps({}) },
      })
      const rename = w.find('[data-testid="session-row-rename"]')
      expect((rename.element as HTMLButtonElement).disabled).toBe(false)
      await rename.trigger('click')
      expect(w.emitted('rename-session')).toEqual([[WS, 's1', 'New']])
    })
  })

  describe('统一时间流:vendor 色点 + 过滤 chip + title 来源 ⓘ', () => {
    it('每行渲染左侧 vendor 色点,颜色按 vendor 区分', () => {
      const w = mountList({
        sessions: [
          session('s1', 'Alpha', { vendor: 'claude' }),
          session('s2', 'Beta', { vendor: 'codex' }),
        ],
      })
      const dots = w.findAll('[data-testid="session-vendor-dot"]')
      expect(dots.length).toBe(2)
      const c0 = (dots[0].element as HTMLElement).style.backgroundColor
      const c1 = (dots[1].element as HTMLElement).style.backgroundColor
      expect(c0).toBeTruthy()
      expect(c1).toBeTruthy()
      expect(c0).not.toBe(c1)
    })

    it('title 后渲染 ⓘ,tooltip 标注来源 vendor', () => {
      const w = mountList({ sessions: [session('s1', 'Alpha', { vendor: 'claude' })] })
      const info = w.find('.session-title-source')
      expect(info.exists()).toBe(true)
      expect(info.attributes('title')).toContain('Claude')
    })

    it('lastModified=0(Codex 无数据沉底)→ 不渲染日期前缀', () => {
      const w = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'codex', lastModified: 0 })],
      })
      expect(w.find('.session-date').exists()).toBe(false)
    })

    it('多 vendor → 渲染过滤 chip;单 vendor → 不渲染', () => {
      const multi = mountList({
        sessions: [
          session('s1', 'Alpha', { vendor: 'claude' }),
          session('s2', 'Beta', { vendor: 'codex' }),
        ],
      })
      expect(multi.find('[data-testid="vendor-filter"]').exists()).toBe(true)
      expect(multi.findAll('.vendor-chip').length).toBe(2)

      const single = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'claude' })],
      })
      expect(single.find('[data-testid="vendor-filter"]').exists()).toBe(false)
    })

    it('点击 chip 关闭某 vendor → 该 vendor 行从时间流隐藏', async () => {
      const w = mountList({
        sessions: [
          session('s1', 'Alpha', { vendor: 'claude' }),
          session('s2', 'Beta', { vendor: 'codex' }),
        ],
      })
      expect(w.findAll('.session').length).toBe(2)
      await w.find('[data-testid="vendor-chip-codex"]').trigger('click')
      const rows = w.findAll('.session')
      expect(rows.length).toBe(1)
      // 余下的是 claude 行(codex 被过滤)。
      expect(rows[0].find('.session-title').text()).toContain('Alpha')
    })
  })

  describe('来源跳回入口', () => {
    it('有来源的工具会话显示跳回按钮并 emit,无来源不显示', async () => {
      const w = mountList({
        sessions: [
          session('tool-owned', 'Tool owned', {
            sessionKind: 'tool',
            ownerKind: 'intent',
            ownerId: 'intent-1',
            isToolSession: true,
            vendor: 'claude',
          }),
          session('tool-ownerless', 'Tool ownerless', {
            sessionKind: 'tool',
            ownerKind: null,
            ownerId: null,
            isToolSession: true,
            vendor: 'claude',
          }),
        ],
      })

      const jumps = w.findAll('[data-testid="session-row-jump"]')
      expect(jumps).toHaveLength(1)
      await jumps[0].trigger('click')
      expect(w.emitted('jump-session-source')?.[0]).toEqual([
        WS,
        expect.objectContaining({ sessionId: 'tool-owned' }),
      ])
    })
  })
})
