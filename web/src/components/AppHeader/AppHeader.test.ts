import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppHeader from './AppHeader.vue'
import { useAuth } from '@/composables/useAuth'
import { i18n } from '@/i18n'

const TABS = [
  { key: 'console', label: 'Works' },
  { key: 'intents', label: 'Intents' },
  { key: 'discussion', label: 'Discussions' },
  { key: 'automations', label: 'Automations' },
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
    expect(tabs.map((t) => t.text())).toEqual(['Works', 'Intents', 'Discussions', 'Automations'])
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
    expect(tabs.map((t) => t.text())).toEqual(['Works', 'Intents', 'Discussions', 'Automations'])
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

describe('AppHeader.vue — 「会话」tab 进行中会话数角标', () => {
  // console tab 带 badgeCount(顶部六类求和由 state.HEADER_TABS 注入);其余 tab 无。
  const tabsWithBadge = [{ key: 'console', label: 'Sessions', badgeCount: 3 }, ...TABS.slice(1)]

  it('console tab badgeCount>0 → 桌面 .header-tab 角标渲染且文本正确', () => {
    const w = mount(AppHeader, { props: { ...baseProps, tabs: tabsWithBadge } })
    const badge = w.find('.header-tab .tab-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('3')
  })

  it('console tab badgeCount>0 → 移动端底部 tab 角标渲染且文本正确', () => {
    const w = mount(AppHeader, { props: { ...baseProps, tabs: tabsWithBadge } })
    const badge = w.find('.mobile-bottom-tab .tab-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('3')
  })

  it('角标带 i18n aria-label,含进行中计数', () => {
    const w = mount(AppHeader, { props: { ...baseProps, tabs: tabsWithBadge } })
    const aria = w.find('.header-tab .tab-badge').attributes('aria-label')
    expect(aria).toBeDefined()
    expect(aria).toContain('3')
  })

  it('badgeCount 为 0 时桌面/移动端均不渲染角标', () => {
    const tabs = [{ key: 'console', label: 'Sessions', badgeCount: 0 }, ...TABS.slice(1)]
    const w = mount(AppHeader, { props: { ...baseProps, tabs } })
    expect(w.find('.header-tab .tab-badge').exists()).toBe(false)
    expect(w.find('.mobile-bottom-tab .tab-badge').exists()).toBe(false)
  })

  it('has-badge class 在 badgeCount>0 的 console tab 上可观察到', () => {
    const w = mount(AppHeader, { props: { ...baseProps, tabs: tabsWithBadge } })
    expect(w.findAll('.header-tab')[0].classes()).toContain('has-badge')
    expect(w.findAll('.mobile-bottom-tab')[0].classes()).toContain('has-badge')
  })
})

describe('i18n — nav.tab.console.ariaLabel 插值', () => {
  it('en 下正确插值 count', () => {
    expect(i18n.global.t('nav.tab.console.ariaLabel', { count: 3 })).toBe('Sessions (3 running)')
  })

  it('zh 下正确插值 count', () => {
    expect(i18n.global.t('nav.tab.console.ariaLabel', { count: 3 }, { locale: 'zh' })).toBe(
      '会话(3 个进行中)',
    )
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

describe('AppHeader.vue — 新版本提示(header upgrade hint)', () => {
  const UPGRADE_URL = 'https://github.com/sequencestream/c3#upgrade'

  it('有更新时桌面渲染提示外链,文案含版本号,新标签页跳转升级文档', () => {
    const w = mount(AppHeader, {
      props: {
        ...baseProps,
        updateStatus: { available: true, latestVersion: '1.2.3', checkedAt: 1 },
      },
    } as never)
    const link = w.find('.desktop-header-row .update-hint')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('1.2.3')
    expect(link.attributes('href')).toBe(UPGRADE_URL)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
  })

  it('有更新时移动端操作菜单同样渲染提示外链', () => {
    const w = mount(AppHeader, {
      props: {
        ...baseProps,
        updateStatus: { available: true, latestVersion: '1.2.3', checkedAt: 1 },
      },
    } as never)
    const link = w.find('.mobile-actions-menu .update-hint-mobile')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(UPGRADE_URL)
    expect(link.attributes('target')).toBe('_blank')
  })

  it('无更新(available=false)→ 桌面与移动端均不渲染', () => {
    const w = mount(AppHeader, {
      props: {
        ...baseProps,
        updateStatus: { available: false, latestVersion: '1.2.3', checkedAt: 1 },
      },
    } as never)
    expect(w.find('.update-hint').exists()).toBe(false)
    expect(w.find('.update-hint-mobile').exists()).toBe(false)
  })

  it('available=true 但无 latestVersion → 不渲染', () => {
    const w = mount(AppHeader, {
      props: {
        ...baseProps,
        updateStatus: { available: true, latestVersion: null, checkedAt: 1 },
      },
    } as never)
    expect(w.find('.update-hint').exists()).toBe(false)
    expect(w.find('.update-hint-mobile').exists()).toBe(false)
  })

  it('updateStatus 缺省(未知)→ 不渲染', () => {
    const w = mount(AppHeader, { props: baseProps })
    expect(w.find('.update-hint').exists()).toBe(false)
    expect(w.find('.update-hint-mobile').exists()).toBe(false)
  })
})
