import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AppHeader from './AppHeader.vue'

const TABS = [
  { key: 'console', label: '会话' },
  { key: 'requirements', label: '需求' },
]

const baseProps = {
  workspaces: [],
  currentWorkspace: '/home/proj-a',
  status: 'open' as const,
  tabs: TABS,
  activeTab: 'console',
  tabsEnabled: true,
}

describe('AppHeader.vue — top-bar tabs', () => {
  it('按 tabs 数据渲染全部 tab,标记当前 tab', () => {
    const w = mount(AppHeader, { props: baseProps })
    const tabs = w.findAll('.header-tab')
    expect(tabs.map((t) => t.text())).toEqual(['会话', '需求'])
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
  })

  it('activeTab 变化 → 高亮跟随', () => {
    const w = mount(AppHeader, { props: { ...baseProps, activeTab: 'requirements' } })
    const tabs = w.findAll('.header-tab')
    expect(tabs[0].classes()).not.toContain('active')
    expect(tabs[1].classes()).toContain('active')
  })

  it('点击 tab → emit select-tab(key)', async () => {
    const w = mount(AppHeader, { props: baseProps })
    await w.findAll('.header-tab')[1].trigger('click')
    expect(w.emitted('select-tab')).toEqual([['requirements']])
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
})
