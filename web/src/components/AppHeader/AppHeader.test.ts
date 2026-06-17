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

// `isAdmin` is a module-singleton (defaults true). Restore it after each test so
// the admin-gated cases don't leak into the others.
afterEach(() => {
  useAuth().setIsAdmin(true)
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

  it('移动端底部导航渲染 5 个视图并保留工作台徽标', () => {
    const w = mount(AppHeader, { props: baseProps })
    const tabs = w.findAll('.mobile-bottom-tab')
    expect(tabs.map((t) => t.text())).toEqual([
      'Works',
      'Intents',
      'Discussions',
      'Schedules',
      'Workcenter2',
    ])
    expect(tabs[4].classes()).toContain('has-badge')
    expect(tabs[4].find('.tab-badge').text()).toBe('2')
  })

  it('点击移动端工作台 tab → 切换 viewMode 到 workcenter', async () => {
    const w = mount(AppHeader, { props: baseProps })
    await w.findAll('.mobile-bottom-tab')[4].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workcenter']])
  })

  it('workcenter 模式点击移动端工作区 tab → 先回 workspace 再选择 tab', async () => {
    const w = mount(AppHeader, { props: { ...baseProps, viewMode: 'workcenter' } })
    await w.findAll('.mobile-bottom-tab')[1].trigger('click')
    expect(w.emitted('update:viewMode')).toEqual([['workspace']])
    expect(w.emitted('select-tab')).toEqual([['intents']])
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

  it('无当前工作区时移动端工作区 tab 禁用,工作台 tab 仍可进入', async () => {
    const w = mount(AppHeader, {
      props: { ...baseProps, currentWorkspace: null, tabsEnabled: false },
    })
    const tabs = w.findAll('.mobile-bottom-tab')
    expect(tabs[0].attributes('disabled')).toBeDefined()
    expect(tabs[4].attributes('disabled')).toBeUndefined()
    await tabs[0].trigger('click')
    await tabs[4].trigger('click')
    expect(w.emitted('select-tab')).toBeUndefined()
    expect(w.emitted('update:viewMode')).toEqual([['workcenter']])
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
})
