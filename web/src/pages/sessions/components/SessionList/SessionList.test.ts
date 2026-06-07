import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionList from './SessionList.vue'
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
  } = {},
) {
  return mount(SessionList, {
    props: {
      currentWorkspace: opts.currentWorkspace === undefined ? WS : opts.currentWorkspace,
      sessions: opts.sessions ?? [],
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

describe('SessionList.vue — 当前工作区会话列表', () => {
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

  it('分页:超过 10 条显示 ▾ more,点击后展开下一页', async () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${i}`, `S${i}`))
    const w = mountList({ sessions: many })
    expect(w.findAll('.session').length).toBe(10)
    const more = w.find('.session-more')
    expect(more.exists()).toBe(true)
    await more.trigger('click')
    expect(w.findAll('.session').length).toBe(12)
    expect(w.find('.session-more').exists()).toBe(false)
  })

  it('新建 ＋ → emit create-session(path)', async () => {
    const w = mountList()
    const btns = w.findAll('.sidebar-head .icon-btn')
    // 需求入口已迁至顶栏 tab nav(AppHeader);会话头部为「刷新 + 新建」两枚按钮。
    expect(btns.length).toBe(2)
    await w.find('[data-testid="session-list-new"]').trigger('click')
    expect(w.emitted('create-session')).toEqual([[WS]])
  })

  it('刷新按钮 → emit refresh-sessions;无工作区时不渲染', async () => {
    const w = mountList()
    await w.find('[data-testid="session-list-refresh"]').trigger('click')
    expect(w.emitted('refresh-sessions')).toEqual([[]])

    const none = mountList({ currentWorkspace: null })
    expect(none.find('[data-testid="session-list-refresh"]').exists()).toBe(false)
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

    it('temporarily-unavailable(OpenCode)→ 按钮渲染但禁用,tooltip 为暂不可用', () => {
      const w = mountList({
        sessions: [session('s1', 'Alpha', { vendor: 'opencode' })],
        vendorSessionCaps: {
          opencode: caps({ rename: 'temporarily-unavailable', delete: 'temporarily-unavailable' }),
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
})
