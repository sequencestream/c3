import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppHeader from './AppHeader.vue'
import { useAuth } from '@/composables/useAuth'

const TABS = [
  { key: 'console', label: 'Works' },
  { key: 'intents', label: 'Intents' },
  { key: 'discussion', label: 'Discussions' },
  { key: 'schedules', label: 'Schedules' },
]

const baseProps = {
  workspaces: [],
  currentWorkspace: '/home/proj-a',
  status: 'open' as const,
  tabs: TABS,
  activeTab: 'console',
  tabsEnabled: true,
  viewMode: 'workspace' as const,
  workcenterBadgeCount: 2,
}

// `isAdmin` / `subject` are module-singletons (default true / null). Restore them
// after each test so the auth-gated cases don't leak into the others.
afterEach(() => {
  useAuth().setIsAdmin(true)
  useAuth().setSubject(null)
})

describe('AppHeader.vue — top-bar tabs', () => {
  it('按 tabs 数据渲染全部 tab,标记当前 tab', () => {
    const w = mount(AppHeader, { props: baseProps })
    const tabs = w.findAll('.header-tab')
    expect(tabs.map((t) => t.text())).toEqual(['Works', 'Intents', 'Discussions', 'Schedules'])
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
    expect(tabs[2].classes()).not.toContain('active')
  })

  it('activeTab 变化 → 高亮跟随(discussion)', () => {
    const w = mount(AppHeader, { props: { ...baseProps, activeTab: 'discussion' } })
    const tabs = w.findAll('.header-tab')
    expect(tabs[0].classes()).not.toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
    expect(tabs[2].classes()).toContain('active')
  })

  it('点击 tab → emit select-tab(key)', async () => {
    const w = mount(AppHeader, { props: baseProps })
    await w.findAll('.header-tab')[2].trigger('click')
    expect(w.emitted('select-tab')).toEqual([['discussion']])
  })

  it('无当前工作区(tabsEnabled=false)→ tab 禁用,点击不 emit', async () => {
    const w = mount(AppHeader, {
      props: { ...baseProps, currentWorkspace: null, tabsEnabled: false },
    })
    const tabs = w.findAll('.header-tab')
    expect(tabs[0].attributes('disabled')).toBeDefined()
    await tabs[1].trigger('click')
    expect(w.emitted('select-tab')).toBeUndefined()
  })

  it('顶栏不再渲染会话面包屑 / 权限模式下拉(已下移到 SessionTitleBar)', () => {
    const w = mount(AppHeader, { props: { ...baseProps, activeTab: 'console' } })
    expect(w.find('.crumbs').exists()).toBe(false)
    expect(w.find('.mode').exists()).toBe(false)
  })

  it('移动端底部导航仅渲染工作区子 tab,不含工作台', () => {
    const w = mount(AppHeader, { props: baseProps })
    const tabs = w.findAll('.mobile-bottom-tab')
    expect(tabs.map((t) => t.text())).toEqual(['Works', 'Intents', 'Discussions', 'Schedules'])
  })

  it('管理员显示系统设置入口(桌面 ⚙ + 移动端菜单项)', () => {
    useAuth().setIsAdmin(true)
    const w = mount(AppHeader, { props: baseProps })
    expect(w.find('.settings-btn').exists()).toBe(true)
  })

  it('非管理员隐藏系统设置入口(ADR-0023 authz)', () => {
    useAuth().setIsAdmin(false)
    const w = mount(AppHeader, { props: baseProps })
    expect(w.find('.settings-btn').exists()).toBe(false)
  })

  it('无当前工作区(tabsEnabled=false)→ 移动端底部工作区 tab 全部禁用且点击不 emit', async () => {
    const w = mount(AppHeader, {
      props: { ...baseProps, currentWorkspace: null, tabsEnabled: false },
    })
    const tabs = w.findAll('.mobile-bottom-tab')
    expect(tabs[0].attributes('disabled')).toBeDefined()
    await tabs[0].trigger('click')
    expect(w.emitted('select-tab')).toBeUndefined()
  })

  it('workcenter 模式点击移动端底部工作区 tab → 先回 workspace 再选择 tab', async () => {
    const w = mount(AppHeader, { props: { ...baseProps, viewMode: 'workcenter' } })
    await w.findAll('.mobile-bottom-tab')[1].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workspace']])
    expect(w.emitted('select-tab')).toEqual([['intents']])
  })
})

describe('AppHeader.vue — 顶部 viewMode 图标切换器', () => {
  it('桌面切换器渲染为 desktop-header-row 第一个元素,header-right 不再含切换器', () => {
    const w = mount(AppHeader, { props: baseProps })
    const row = w.find('.desktop-header-row')
    expect(row.element.firstElementChild?.classList.contains('view-mode-toggle')).toBe(true)
    expect(w.find('.header-right .view-mode-toggle').exists()).toBe(false)
  })

  it('移动端顶栏左侧出现同款两图标切换器', () => {
    const w = mount(AppHeader, { props: baseProps })
    const btns = w.findAll('.mobile-header-row .vm-toggle-btn')
    expect(btns).toHaveLength(2)
  })

  it('生效模式图标带 active 类、另一个不带(蓝/灰由 .active 驱动),随 viewMode 互换', () => {
    const ws = mount(AppHeader, { props: baseProps })
    const dWs = ws.findAll('.desktop-header-row .vm-toggle-btn')
    expect(dWs[0].classes()).toContain('active')
    expect(dWs[1].classes()).not.toContain('active')

    const wc = mount(AppHeader, { props: { ...baseProps, viewMode: 'workcenter' } })
    const dWc = wc.findAll('.desktop-header-row .vm-toggle-btn')
    expect(dWc[0].classes()).not.toContain('active')
    expect(dWc[1].classes()).toContain('active')
  })

  it('点击桌面工作台图标 → emit update:viewMode(workcenter)', async () => {
    const w = mount(AppHeader, { props: baseProps })
    await w.findAll('.desktop-header-row .vm-toggle-btn')[1].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workcenter']])
  })

  it('点击移动端工作台图标 → emit update:viewMode(workcenter)', async () => {
    const w = mount(AppHeader, { props: baseProps })
    await w.findAll('.mobile-header-row .vm-toggle-btn')[1].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workcenter']])
  })

  it('workcenter 模式点击工作区图标 → emit update:viewMode(workspace)', async () => {
    const w = mount(AppHeader, { props: { ...baseProps, viewMode: 'workcenter' } })
    await w.findAll('.desktop-header-row .vm-toggle-btn')[0].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workspace']])
  })

  it('工作台徽标(workcenterBadgeCount)显示在工作台图标上(桌面 + 移动端)', () => {
    const w = mount(AppHeader, { props: baseProps })
    const badges = w.findAll('.vm-badge')
    expect(badges).toHaveLength(2)
    expect(badges.every((b) => b.text() === '2')).toBe(true)
  })

  it('徽标计数为 0 时不渲染', () => {
    const w = mount(AppHeader, { props: { ...baseProps, workcenterBadgeCount: 0 } })
    expect(w.findAll('.vm-badge')).toHaveLength(0)
  })
})

describe('AppHeader.vue — 账户菜单(ADR-0023)', () => {
  it('未认证(showLogout 缺省)→ 桌面不渲染账户菜单触发器', () => {
    const w = mount(AppHeader, { props: baseProps })
    expect(w.find('.account-trigger').exists()).toBe(false)
  })

  it('已认证 → 桌面渲染人形图标触发器', () => {
    const w = mount(AppHeader, { props: { ...baseProps, showLogout: true } })
    const trigger = w.find('.account-trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.find('.account-icon').exists()).toBe(true)
  })

  it('展开下拉展示登录名', () => {
    useAuth().setSubject('alice')
    const w = mount(AppHeader, { props: { ...baseProps, showLogout: true } })
    expect(w.find('.account-name').text()).toBe('alice')
  })

  it('点击下拉内登出按钮 → emit logout', async () => {
    useAuth().setSubject('alice')
    const w = mount(AppHeader, { props: { ...baseProps, showLogout: true } })
    await w.find('.account-logout-btn').trigger('click')
    expect(w.emitted('logout')).toHaveLength(1)
  })

  it('移动端溢出菜单同样展示登录名与登出项', () => {
    useAuth().setSubject('alice')
    const w = mount(AppHeader, { props: { ...baseProps, showLogout: true } })
    expect(w.find('.account-name-static').text()).toBe('alice')
    const logoutItems = w.findAll('.mobile-action-item').filter((b) => b.text() === 'Sign out')
    expect(logoutItems).toHaveLength(1)
  })
})

describe('AppHeader.vue — license badge 有效期(PL-R7)', () => {
  // 2024-06-15T00:00:00Z(unix 秒);断言只 key 在年份等数据派生值上,不耦合本地化排布。
  const TERM_END = 1_718_409_600
  function licenseProps(license: object | null) {
    return { ...baseProps, license }
  }

  it('active 且 termEnd>0 → badge 旁渲染有效期(含年份)', () => {
    const w = mount(AppHeader, {
      props: licenseProps({
        state: 'active',
        entitled: true,
        termEnd: TERM_END,
        installationId: 'i',
        licenseKey: 'lk',
      }),
    } as never)
    const term = w.find('.license-term')
    expect(term.exists()).toBe(true)
    expect(term.text()).toContain('2024')
  })

  it('grace 态同样渲染有效期', () => {
    const w = mount(AppHeader, {
      props: licenseProps({
        state: 'grace',
        entitled: true,
        termEnd: TERM_END,
        installationId: 'i',
        licenseKey: 'lk',
      }),
    } as never)
    expect(w.find('.license-term').exists()).toBe(true)
  })

  it('termEnd=0(缺省)→ 不渲染有效期', () => {
    const w = mount(AppHeader, {
      props: licenseProps({
        state: 'active',
        entitled: true,
        termEnd: 0,
        installationId: 'i',
        licenseKey: 'lk',
      }),
    } as never)
    expect(w.find('.license-term').exists()).toBe(false)
  })

  it('expired/unactivated 态沿用状态文案,不渲染有效期', () => {
    for (const state of ['expired', 'unactivated', 'disabled'] as const) {
      const w = mount(AppHeader, {
        props: licenseProps({
          state,
          entitled: false,
          termEnd: TERM_END,
          installationId: 'i',
          licenseKey: 'lk',
        }),
      } as never)
      expect(w.find('.license-term').exists()).toBe(false)
    }
  })

  it('按 plan 层级在右上角 badge 展示 free / paid / enterprise', () => {
    for (const [plan, label] of [
      ['free', 'Free'],
      ['paid', 'Paid'],
      ['enterprise', 'Enterprise'],
    ] as const) {
      const w = mount(AppHeader, {
        props: licenseProps({
          state: 'active',
          plan,
          entitled: true,
          termEnd: TERM_END,
          installationId: 'i',
          licenseKey: 'lk',
        }),
      } as never)
      expect(w.find('.license-plan').text()).toBe(label)
      expect(w.find('.license-info-row').text()).toBe(label)
    }
  })

  it('移动端操作菜单展示当前付费层级', () => {
    const w = mount(AppHeader, {
      props: licenseProps({
        state: 'active',
        plan: 'enterprise',
        entitled: true,
        termEnd: TERM_END,
        installationId: 'i',
        licenseKey: 'lk',
      }),
    } as never)
    expect(w.find('.license-info-static').text()).toContain('Enterprise')
  })
})

describe('AppHeader.vue — license 有效期手动刷新(PL-R7)', () => {
  const TERM_END = 1_718_409_600
  const entitledLicense = {
    state: 'active',
    entitled: true,
    termEnd: TERM_END,
    installationId: 'i',
    licenseKey: 'lk',
  }
  function refreshProps(extra: object = {}) {
    return { ...baseProps, license: entitledLicense, ...extra }
  }

  it('entitled 且展示有效期时,有效期行旁渲染刷新按钮', () => {
    const w = mount(AppHeader, { props: refreshProps() } as never)
    const term = w.find('.license-term')
    expect(term.find('.license-refresh-btn').exists()).toBe(true)
  })

  it('点击刷新按钮 → emit refresh-license', async () => {
    const w = mount(AppHeader, { props: refreshProps() } as never)
    await w.find('.license-refresh-btn').trigger('click')
    expect(w.emitted('refresh-license')).toHaveLength(1)
  })

  it('在途(licenseRefreshing)→ 按钮禁用 + 图标旋转', () => {
    const w = mount(AppHeader, { props: refreshProps({ licenseRefreshing: true }) } as never)
    const btn = w.find('.license-refresh-btn')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(w.find('.license-refresh-icon').classes()).toContain('spinning')
  })

  it('在途期间点击不再 emit(防连点)', async () => {
    const w = mount(AppHeader, { props: refreshProps({ licenseRefreshing: true }) } as never)
    await w.find('.license-refresh-btn').trigger('click')
    expect(w.emitted('refresh-license')).toBeUndefined()
  })

  it('点击后进入最小冷却 → 按钮即时禁用防连点', async () => {
    const w = mount(AppHeader, { props: refreshProps() } as never)
    const btn = w.find('.license-refresh-btn')
    await btn.trigger('click')
    expect(btn.attributes('disabled')).toBeDefined()
    // 冷却期内再次点击不再 emit。
    await btn.trigger('click')
    expect(w.emitted('refresh-license')).toHaveLength(1)
  })

  it('刷新失败 → 按钮旁 inline 显示可读错误文案', () => {
    const w = mount(AppHeader, {
      props: refreshProps({ licenseRefreshError: '刷新失败,请重试' }),
    } as never)
    const err = w.find('.license-refresh-error')
    expect(err.exists()).toBe(true)
    expect(err.text()).toBe('刷新失败,请重试')
  })

  it('无错误时不渲染 inline 提示', () => {
    const w = mount(AppHeader, { props: refreshProps() } as never)
    expect(w.find('.license-refresh-error').exists()).toBe(false)
  })
})
