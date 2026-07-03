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
    eventTopic: null,
    eventReasonFilter: null,
    eventPrFilter: null,
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

function mountList(automations: Automation[], activeId: string | null = null) {
  return mount(AutomationList, { props: { automations, activeId } })
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
