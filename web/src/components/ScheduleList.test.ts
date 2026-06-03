import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Schedule } from '@ccc/shared/protocol'
import ScheduleList from './ScheduleList.vue'

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'Build' },
    workspacePath: '/home/proj',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    status: 'active',
    mcpMode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

function mountList(schedules: Schedule[]) {
  return mount(ScheduleList, { props: { schedules, activeId: null } })
}

describe('ScheduleList.vue — 左栏列表交互', () => {
  it('点击行展开行内摘要,再次点击收起(accordion)', async () => {
    const w = mountList([sched({ id: 'a' })])
    const main = w.find('.sched-item-main')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)

    await main.trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(true)

    await main.trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)
  })

  it('展开新行自动收起旧行(单开)', async () => {
    const w = mountList([sched({ id: 'a' }), sched({ id: 'b' })])
    const mains = w.findAll('.sched-item-main')

    await mains[0].trigger('click')
    expect(w.findAll('.sched-detail-inline')).toHaveLength(1)

    await mains[1].trigger('click')
    const open = w.findAll('.sched-detail-inline')
    expect(open).toHaveLength(1)
    // 展开的是第二行:其所在 item 的 main aria-expanded 为 true,首行为 false。
    expect(mains[0].attributes('aria-expanded')).toBe('false')
    expect(mains[1].attributes('aria-expanded')).toBe('true')
  })

  it('展开行同时 emit select(联动右栏)', async () => {
    const w = mountList([sched({ id: 'a' })])
    await w.find('.sched-item-main').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['a'])
  })

  it('开关 emit toggle-enabled:active→false,paused→true', async () => {
    const w = mountList([
      sched({ id: 'a', status: 'active' }),
      sched({ id: 'b', status: 'paused' }),
    ])
    const toggles = w.findAll('.sched-toggle')

    await toggles[0].trigger('click')
    expect(w.emitted('toggle-enabled')?.[0]).toEqual(['a', false])

    await toggles[1].trigger('click')
    expect(w.emitted('toggle-enabled')?.[1]).toEqual(['b', true])
  })

  it('开关点击不触发行展开(stop propagation)', async () => {
    const w = mountList([sched({ id: 'a', status: 'active' })])
    await w.find('.sched-toggle').trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)
    expect(w.emitted('select')).toBeUndefined()
  })

  it('+ 号 emit new-schedule', async () => {
    const w = mountList([])
    await w.find('.sched-new-btn').trigger('click')
    expect(w.emitted('new-schedule')).toHaveLength(1)
  })
})
