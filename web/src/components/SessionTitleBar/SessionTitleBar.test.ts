import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionTitleBar from './SessionTitleBar.vue'
import BaseDropdown from '../BaseDropdown/BaseDropdown.vue'
import { i18n } from '@/i18n'
import type { ModeToken } from '@ccc/shared/protocol'

// Resolve a source label's expected copy in the test's active locale (the global
// i18n instance, default 'en') so assertions never hard-code visible text.
const sourceText = (key: string): string => i18n.global.t(`session.titleBar.${key}.label`)

const MODE_OPTIONS: { value: ModeToken; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'plan', label: '计划' },
]

function mountBar(props: Partial<Record<string, unknown>> = {}) {
  return mount(SessionTitleBar, {
    props: {
      activeTitle: 'Alpha',
      mode: 'default' as ModeToken,
      modeOptions: MODE_OPTIONS,
      ...props,
    },
  })
}

describe('SessionTitleBar.vue — 会话标题行', () => {
  it('左侧渲染会话标题', () => {
    const w = mountBar({ activeTitle: 'My Session' })
    expect(w.find('.session-title-text').text()).toBe('My Session')
  })

  it('右侧渲染权限模式下拉', () => {
    const w = mountBar()
    expect(w.find('.mode').exists()).toBe(true)
    expect(w.findComponent(BaseDropdown).exists()).toBe(true)
  })

  it('切换模式 → emit set-mode(mode)', async () => {
    const w = mountBar()
    await w.find('.dd-trigger').trigger('click')
    const items = w.findAll('.dd-item')
    await items[1].trigger('click') // plan
    expect(w.emitted('set-mode')).toEqual([['plan']])
  })

  it('有 vendor 时渲染色点(颜色取自 VENDOR_COLOR)', () => {
    const w = mountBar({ vendor: 'codex' })
    const dot = w.find('[data-testid="session-vendor-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('style')).toContain('#a855f7') // codex brand colour
  })

  it('无 vendor 时不渲染色点', () => {
    const w = mountBar({ vendor: null })
    expect(w.find('[data-testid="session-vendor-dot"]').exists()).toBe(false)
  })

  it('per-vendor modeOptions 渲染为下拉项', async () => {
    const codexOptions: { value: ModeToken; label: string }[] = [
      { value: 'read-only', label: '只读' },
      { value: 'auto', label: '自动' },
      { value: 'full-access', label: '完全访问' },
    ]
    const w = mountBar({ modeOptions: codexOptions })
    await w.find('.dd-trigger').trigger('click')
    const labels = w.findAll('.dd-item .dd-label').map((n) => n.text())
    expect(labels).toEqual(['只读', '自动', '完全访问'])
  })

  it('showMode=false 不渲染模式下拉', () => {
    const w = mountBar({ showMode: false })
    expect(w.find('.mode').exists()).toBe(false)
  })
})

describe('SessionTitleBar.vue — 标题栏溯源按钮', () => {
  it('无 sourceLabel 时不渲染按钮', () => {
    const w = mountBar({ sourceLabel: null })
    expect(w.find('[data-testid="session-source-jump"]').exists()).toBe(false)
  })

  it.each(['intent', 'discussion', 'schedule', 'trace'] as const)(
    'sourceLabel=%s 渲染对应 i18n 文案',
    (label) => {
      const w = mountBar({ sourceLabel: label })
      const button = w.find('[data-testid="session-source-jump"]')
      expect(button.exists()).toBe(true)
      expect(button.text()).toBe(sourceText(label))
    },
  )

  it('点击按钮 → emit open-source(无参)', async () => {
    const w = mountBar({ sourceLabel: 'intent' })
    await w.find('[data-testid="session-source-jump"]').trigger('click')
    expect(w.emitted('open-source')).toEqual([[]])
  })
})

const SWITCH = {
  current: { id: 'a1', displayName: 'Agent 1' },
  candidates: [{ id: 'a2', displayName: 'Agent 2' }],
  currentUnavailable: false,
}

describe('SessionTitleBar.vue — 同 vendor agent 切换器', () => {
  it('无 agentSwitch 时不渲染切换器', () => {
    const w = mountBar()
    expect(w.find('[data-testid="session-agent-switch"]').exists()).toBe(false)
  })

  it('有 agentSwitch 时只列出 current + 同 vendor 候选', async () => {
    const w = mountBar({ vendor: 'claude', agentSwitch: SWITCH })
    const dd = w.find('[data-testid="session-agent-switch"]')
    expect(dd.exists()).toBe(true)
    await dd.find('.dd-trigger').trigger('click')
    const labels = dd.findAll('.dd-item .dd-label').map((n) => n.text())
    // current first, then the same-vendor candidate — cross-vendor never appears.
    expect(labels).toEqual(['Agent 1', 'Agent 2'])
  })

  it('选择另一同 vendor agent → emit set-session-agent(id)', async () => {
    const w = mountBar({ vendor: 'claude', agentSwitch: SWITCH })
    const dd = w.find('[data-testid="session-agent-switch"]')
    await dd.find('.dd-trigger').trigger('click')
    await dd.findAll('.dd-item')[1].trigger('click') // Agent 2
    expect(w.emitted('set-session-agent')).toEqual([['a2']])
  })

  it('选择当前 agent 不触发切换', async () => {
    const w = mountBar({ vendor: 'claude', agentSwitch: SWITCH })
    const dd = w.find('[data-testid="session-agent-switch"]')
    await dd.find('.dd-trigger').trigger('click')
    await dd.findAll('.dd-item')[0].trigger('click') // Agent 1 (current)
    expect(w.emitted('set-session-agent')).toBeUndefined()
  })

  it('current agent 不可用时渲染提示条', () => {
    const w = mountBar({
      vendor: 'claude',
      agentSwitch: { ...SWITCH, currentUnavailable: true },
    })
    expect(w.find('[data-testid="session-agent-unavailable"]').exists()).toBe(true)
  })

  it('current agent 可用时不渲染提示条', () => {
    const w = mountBar({ vendor: 'claude', agentSwitch: SWITCH })
    expect(w.find('[data-testid="session-agent-unavailable"]').exists()).toBe(false)
  })
})
