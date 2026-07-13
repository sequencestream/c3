import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Automation } from '@ccc/shared/protocol'
import AutomationList from './AutomationList.vue'

function sched(over: Partial<Automation> = {}): Automation {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'Build' },
    maxWallClockMs: null,
    workspaceId: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventFilter: null,
    status: 'active',
    mode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

function mountList(
  automations: Automation[],
  activeId: string | null = null,
  gate: { automationEnabled?: boolean | null; automationEnabledSaving?: boolean } = {},
) {
  return mount(AutomationList, {
    props: {
      automations,
      activeId,
      automationEnabled: 'automationEnabled' in gate ? (gate.automationEnabled ?? null) : true,
      automationEnabledSaving: gate.automationEnabledSaving ?? false,
    },
  })
}

describe('AutomationList.vue — 左栏纯选择列表', () => {
  it('点击行 emit select(携带 id),不再展开行内摘要', async () => {
    const w = mountList([sched({ id: 'a' })])
    // 行内手风琴摘要已移除。
    expect(w.find('.sched-detail-inline').exists()).toBe(false)

    await w.find('.sched-item').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['a'])
    // 选择不展开任何行内详情。
    expect(w.find('.sched-detail-inline').exists()).toBe(false)
  })

  it('键盘 Enter / Space 在行上 emit select', async () => {
    const w = mountList([sched({ id: 'a' })])
    const item = w.find('.sched-item')

    await item.trigger('keydown.enter')
    await item.trigger('keydown.space')
    expect(w.emitted('select')).toHaveLength(2)
    expect(w.emitted('select')?.[0]).toEqual(['a'])
  })

  it('activeId 命中的行加 active 高亮', () => {
    const w = mountList([sched({ id: 'a' }), sched({ id: 'b' })], 'b')
    const items = w.findAll('.sched-item')
    expect(items[0].classes()).not.toContain('active')
    expect(items[1].classes()).toContain('active')
  })

  it('+ 号 emit new-automation', async () => {
    const w = mountList([])
    await w.find('.sched-new-btn').trigger('click')
    expect(w.emitted('new-automation')).toHaveLength(1)
  })

  it('模板按钮展示 PR 状态轮询检查并选择模板', async () => {
    const w = mountList([])
    await w.find('.sched-template-btn').trigger('click')
    expect(w.find('.sched-template-menu').text()).toContain('PR status polling check')
    await w.find('.sched-template-item').trigger('click')
    expect(w.emitted('new-from-template')?.[0]).toEqual(['pr-status-poller'])
  })

  it('行内操作按钮已全部迁出(无 run/edit/delete/toggle)', () => {
    const w = mountList([sched({ id: 'a' })])
    expect(w.find('.sched-run-btn').exists()).toBe(false)
    expect(w.find('.sched-edit-btn').exists()).toBe(false)
    expect(w.find('.sched-delete-btn').exists()).toBe(false)
    expect(w.find('.sched-toggle').exists()).toBe(false)
  })

  it('空列表显示空态文案', () => {
    const w = mountList([])
    expect(w.find('.sched-empty').exists()).toBe(true)
  })

  it('「⋯」菜单含导出/导入,且带 aria-label(非符号)', async () => {
    const w = mountList([sched({ id: 'a' })])
    const more = w.find('.sched-more-btn')
    expect(more.exists()).toBe(true)
    // 无障碍名称走 i18n 文案,不以符号充当可访问名。
    expect(more.attributes('aria-label')).toBe('More actions')
    // 默认收起。
    expect(w.find('.sched-more-menu').exists()).toBe(false)
    await more.trigger('click')
    const menu = w.find('.sched-more-menu')
    expect(menu.exists()).toBe(true)
    const items = w.findAll('.sched-more-item')
    expect(items.map((i) => i.text())).toEqual(['Export', 'Import'])
  })

  it('点击「导出」emit open-export 并收起菜单', async () => {
    const w = mountList([sched({ id: 'a' })])
    await w.find('.sched-more-btn').trigger('click')
    await w.findAll('.sched-more-item')[0].trigger('click')
    expect(w.emitted('open-export')).toHaveLength(1)
    expect(w.find('.sched-more-menu').exists()).toBe(false)
  })

  it('点击「导入」emit open-import 并收起菜单', async () => {
    const w = mountList([sched({ id: 'a' })])
    await w.find('.sched-more-btn').trigger('click')
    await w.findAll('.sched-more-item')[1].trigger('click')
    expect(w.emitted('open-import')).toHaveLength(1)
    expect(w.find('.sched-more-menu').exists()).toBe(false)
  })

  it('行标签为类型前缀 + 名称(有 name 时)', () => {
    const w = mountList([sched({ id: 'a', config: { command: 'x', name: 'Nightly Build' } })])
    expect(w.find('.sched-label').text()).toContain('Nightly Build')
  })

  it('无 name 时回退到 cron 表达式', () => {
    const w = mountList([sched({ id: 'a', config: { command: 'x' }, cronExpression: '0 9 * * *' })])
    expect(w.find('.sched-label').text()).toContain('0 9 * * *')
  })

  it('显示状态 badge', () => {
    const w = mountList([sched({ id: 'a', status: 'paused' })])
    const badge = w.find('.sched-status')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('paused')
  })
})

describe('AutomationList.vue — workspace 自动化总开关', () => {
  it('gate 开启:switch 为 checked,可访问名走 i18n,无关闭提示', () => {
    const w = mountList([sched()], null, { automationEnabled: true })
    const gate = w.find('.sched-gate')
    expect(gate.exists()).toBe(true)
    expect(gate.attributes('role')).toBe('switch')
    expect(gate.attributes('aria-checked')).toBe('true')
    // 无障碍名称走 i18n,而非依赖可见标签文本。
    expect(gate.attributes('aria-label')).toBe('Workspace automation master switch')
    // 可见标签文案同样接入 i18n。
    expect(w.find('.sched-gate-label').text()).toBe('Automation')
    expect(w.find('.sched-gate-banner').exists()).toBe(false)
  })

  it('gate 关闭:switch 未选中,标题区持续显示关闭提示', () => {
    const w = mountList([sched()], null, { automationEnabled: false })
    const gate = w.find('.sched-gate')
    expect(gate.attributes('aria-checked')).toBe('false')
    const banner = w.find('.sched-gate-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Auto-triggering is off')
    // 关闭提示是状态通告,便于无障碍读出。
    expect(banner.attributes('role')).toBe('status')
  })

  it('点击 switch emit set-automation-enabled(取反)', async () => {
    const on = mountList([sched()], null, { automationEnabled: true })
    await on.find('.sched-gate').trigger('click')
    expect(on.emitted('set-automation-enabled')?.[0]).toEqual([false])

    const off = mountList([sched()], null, { automationEnabled: false })
    await off.find('.sched-gate').trigger('click')
    expect(off.emitted('set-automation-enabled')?.[0]).toEqual([true])
  })

  it('加载中(automationEnabled=null):switch 禁用且不 emit,显示 ON 安全默认', async () => {
    const w = mountList([sched()], null, { automationEnabled: null })
    const gate = w.find('.sched-gate')
    expect(gate.attributes('disabled')).toBeDefined()
    expect(gate.attributes('aria-checked')).toBe('true')
    // null 视为加载中,不显示关闭提示,避免误导。
    expect(w.find('.sched-gate-banner').exists()).toBe(false)
    await gate.trigger('click')
    expect(w.emitted('set-automation-enabled')).toBeUndefined()
  })

  it('保存中:switch 禁用且不 emit', async () => {
    const w = mountList([sched()], null, {
      automationEnabled: true,
      automationEnabledSaving: true,
    })
    const gate = w.find('.sched-gate')
    expect(gate.attributes('disabled')).toBeDefined()
    await gate.trigger('click')
    expect(w.emitted('set-automation-enabled')).toBeUndefined()
  })
})
