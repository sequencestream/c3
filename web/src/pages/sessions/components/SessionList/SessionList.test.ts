import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionList from './SessionList.vue'
import type { SessionInfo, SessionStatus } from '@ccc/shared/protocol'

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
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionList.vue — 当前工作区会话列表', () => {
  it('无工作区 → 空提示,不渲染列表', () => {
    const w = mountList({ currentWorkspace: null })
    expect(w.find('.empty-hint').text()).toContain('No workspace selected')
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
    // 需求入口已迁至顶栏 tab nav(AppHeader),会话头部只剩 ＋ 新建。
    expect(btns.length).toBe(1)
    await btns[0].trigger('click')
    expect(w.emitted('create-session')).toEqual([[WS]])
  })

  it('重命名:prompt 有值 → emit rename-session(path, id, title)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  New Name  ')
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    await w.find('.session-actions .icon-btn[title="Rename"]').trigger('click')
    expect(w.emitted('rename-session')).toEqual([[WS, 's1', 'New Name']])
  })

  it('重命名:prompt 取消(null)→ 不 emit', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    await w.find('.session-actions .icon-btn[title="Rename"]').trigger('click')
    expect(w.emitted('rename-session')).toBeUndefined()
  })

  it('删除:confirm 通过 → emit delete-session;取消 → 不 emit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mountList({ sessions: [session('s1', 'Alpha')] })
    const delBtn = () => w.find('.session-actions .icon-btn[title="Delete"]')
    await delBtn().trigger('click')
    expect(w.emitted('delete-session')).toBeUndefined()
    confirm.mockReturnValue(true)
    await delBtn().trigger('click')
    expect(w.emitted('delete-session')).toEqual([[WS, 's1']])
  })
})
