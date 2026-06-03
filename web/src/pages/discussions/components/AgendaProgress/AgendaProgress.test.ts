import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import AgendaProgress from './AgendaProgress.vue'

function disc(over: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    projectPath: '/proj',
    title: 'T',
    type: 'design',
    goal: '',
    context: '',
    status: 'in_progress',
    agenda: [],
    agendaIndex: 0,
    conclusion: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...over,
  }
}

describe('AgendaProgress.vue — 议程进度展示', () => {
  it('无议程(null / 空)→ 不渲染面板', () => {
    expect(
      mount(AgendaProgress, { props: { discussion: null } })
        .find('.agenda-panel')
        .exists(),
    ).toBe(false)
    const w = mount(AgendaProgress, { props: { discussion: disc({ agenda: [] }) } })
    expect(w.find('.agenda-panel').exists()).toBe(false)
  })

  it('渲染子题列表、当前子题标记与完成度', () => {
    const w = mount(AgendaProgress, {
      props: { discussion: disc({ agenda: ['A', 'B', 'C', 'D'], agendaIndex: 1 }) },
    })
    expect(w.find('.agenda-panel').exists()).toBe(true)
    const rows = w.findAll('.agenda-row')
    expect(rows.length).toBe(4)
    expect(rows.map((r) => r.find('.agenda-subject').text())).toEqual(['A', 'B', 'C', 'D'])
    // 状态类:done / current / upcoming
    expect(rows[0].classes()).toContain('agenda-done')
    expect(rows[1].classes()).toContain('agenda-current')
    expect(rows[2].classes()).toContain('agenda-upcoming')
    // 完成度文案 + 进度条宽度
    expect(w.find('.agenda-count').text()).toBe('1/4 (25%)')
    expect(w.find('.agenda-bar-fill').attributes('style')).toContain('width: 25%')
  })

  it('随 prop 更新实时刷新(议程下标前移 → 标记 / 完成度同步)', async () => {
    const w = mount(AgendaProgress, {
      props: { discussion: disc({ agenda: ['A', 'B', 'C'], agendaIndex: 0 }) },
    })
    expect(w.findAll('.agenda-row')[0].classes()).toContain('agenda-current')
    expect(w.find('.agenda-count').text()).toBe('0/3 (0%)')

    await w.setProps({ discussion: disc({ agenda: ['A', 'B', 'C'], agendaIndex: 2 }) })
    const rows = w.findAll('.agenda-row')
    expect(rows[0].classes()).toContain('agenda-done')
    expect(rows[1].classes()).toContain('agenda-done')
    expect(rows[2].classes()).toContain('agenda-current')
    expect(w.find('.agenda-count').text()).toBe('2/3 (67%)')

    // 全部完成:100%、无 current 行
    await w.setProps({ discussion: disc({ agenda: ['A', 'B', 'C'], agendaIndex: 3 }) })
    expect(w.find('.agenda-count').text()).toBe('3/3 (100%)')
    expect(w.findAll('.agenda-row.agenda-current').length).toBe(0)
  })
})
