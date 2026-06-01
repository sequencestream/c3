import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import DiscussionList from './DiscussionList.vue'

function disc(id: string, title: string, over: Partial<Discussion> = {}): Discussion {
  return {
    id,
    projectPath: '/home/proj-a',
    title,
    type: 'design',
    goal: '',
    context: '',
    status: 'in_progress',
    conclusion: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    ...over,
  }
}

function mountList(props: Partial<{ discussions: Discussion[]; activeId: string | null }> = {}) {
  return mount(DiscussionList, {
    props: { discussions: [], activeId: null, ...props },
  })
}

describe('DiscussionList.vue — 讨论列表(读路径)', () => {
  it('渲染讨论列表,点击 → emit open(id)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const items = w.findAll('.disc-item')
    expect(items.length).toBe(2)
    expect(items.map((i) => i.find('.disc-title').text())).toEqual(['Alpha', 'Beta'])
    await items[1].trigger('click')
    expect(w.emitted('open')).toEqual([['d2']])
  })

  it('activeId 对应项标记 active', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')], activeId: 'd2' })
    const items = w.findAll('.disc-item')
    expect(items[0].classes()).not.toContain('active')
    expect(items[1].classes()).toContain('active')
  })

  it('空列表显示占位文案', () => {
    const w = mountList({ discussions: [] })
    expect(w.find('.disc-empty').exists()).toBe(true)
    expect(w.findAll('.disc-item').length).toBe(0)
  })

  it('点击顶部「+」→ emit new-discussion', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    expect(w.emitted('new-discussion')).toEqual([[]])
  })

  it('显示状态标签', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { status: 'completed' })] })
    expect(w.find('.disc-status').text()).toBe('Completed')
    expect(w.find('.disc-item').classes()).toContain('completed')
  })
})
