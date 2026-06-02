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
    agenda: [],
    agendaIndex: 0,
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
  it('渲染讨论列表,点击行内 Open chat → emit open(id)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const items = w.findAll('.disc-item')
    expect(items.length).toBe(2)
    expect(items.map((i) => i.find('.disc-title').text())).toEqual(['Alpha', 'Beta'])
    await items[1].find('.disc-open-btn').trigger('click')
    expect(w.emitted('open')).toEqual([['d2']])
  })

  it('点击标题区只展开手风琴,不触发 open', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toBeUndefined()
    expect(w.find('.disc-detail-meta').exists()).toBe(true)
  })

  it('手风琴互斥:至多一项展开,再次点击收起', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const mains = w.findAll('.disc-item-main')
    await mains[0].trigger('click')
    expect(w.findAll('.disc-detail-meta').length).toBe(1)
    // 展开第二项 → 第一项自动收起(互斥)
    await mains[1].trigger('click')
    const metas = w.findAll('.disc-detail-meta')
    expect(metas.length).toBe(1)
    // 再次点击第二项 → 全部收起
    await mains[1].trigger('click')
    expect(w.findAll('.disc-detail-meta').length).toBe(0)
  })

  it('展开详情显示 goal/context/conclusion 与元信息', async () => {
    const w = mountList({
      discussions: [
        disc('d1', 'Alpha', {
          goal: 'Decide TTL',
          context: 'Redis',
          conclusion: 'Use 60s',
          status: 'completed',
          completedAt: 1_700_000_100_000,
        }),
      ],
    })
    await w.find('.disc-item-main').trigger('click')
    const detail = w.find('.disc-detail').text()
    expect(detail).toContain('Decide TTL')
    expect(detail).toContain('Redis')
    expect(detail).toContain('Use 60s')
    const meta = w.find('.disc-detail-meta').text()
    expect(meta).toContain('Created:')
    expect(meta).toContain('Completed:')
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

  it('点击顶部「+」展开新建表单,填写后提交 → emit create(payload)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    // 默认不显示表单
    expect(w.find('.disc-form').exists()).toBe(false)
    await w.find('.disc-new-btn').trigger('click')
    expect(w.find('.disc-form').exists()).toBe(true)
    // 选类型 + 填目标/上下文,提交
    const options = w.findAll('.disc-form select option')
    expect(options.length).toBeGreaterThan(0)
    const firstValue = (options[0].element as HTMLOptionElement).value
    await w.find('.disc-form select').setValue(firstValue)
    await w.findAll('.disc-form textarea')[0].setValue('Decide cache TTL')
    await w.findAll('.disc-form textarea')[1].setValue('Redis today')
    await w.find('.disc-form').trigger('submit')
    expect(w.emitted('create')).toEqual([
      [{ type: firstValue, goal: 'Decide cache TTL', context: 'Redis today' }],
    ])
    // 提交后表单收起
    expect(w.find('.disc-form').exists()).toBe(false)
  })

  it('目标为空时不提交,「+」可再次点击收起表单', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    await w.find('.disc-form').trigger('submit')
    expect(w.emitted('create')).toBeUndefined()
    // 再次点击「+」收起
    await w.find('.disc-new-btn').trigger('click')
    expect(w.find('.disc-form').exists()).toBe(false)
  })

  it('状态以彩色 pill 呈现:文案 + 状态 CSS 类', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { status: 'completed' })] })
    const pill = w.find('.disc-status')
    expect(pill.text()).toBe('Completed')
    expect(pill.classes()).toContain('completed')
    expect(w.find('.disc-item').classes()).toContain('completed')
  })

  it('Goal/Context textarea auto-grow:高度跟随内容并在 200px 上限处出现内部滚动', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    const goal = w.findAll('.disc-form textarea')[0]
    const el = goal.element as HTMLTextAreaElement
    // happy-dom 不做布局,scrollHeight 恒为 0;桩入它以验证 auto-grow 接线。
    let fakeScrollHeight = 80
    Object.defineProperty(el, 'scrollHeight', { get: () => fakeScrollHeight, configurable: true })

    // 内容低于上限:高度跟随内容,内部不滚动。
    await goal.setValue('a\nb\nc')
    expect(el.style.height).toBe('80px')
    expect(el.style.overflowY).toBe('hidden')

    // 内容超过上限:高度封顶 200px 并出现内部滚动条。
    fakeScrollHeight = 360
    await goal.setValue('many\nmany\nlines\nof\ntext')
    expect(el.style.height).toBe('200px')
    expect(el.style.overflowY).toBe('auto')

    // 清空内容:高度收缩复位。
    fakeScrollHeight = 0
    await goal.setValue('')
    expect(el.style.height).toBe('0px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('关闭后重开表单:textarea 为全新元素,无残留内联高度', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    const el = w.findAll('.disc-form textarea')[0].element as HTMLTextAreaElement
    Object.defineProperty(el, 'scrollHeight', { get: () => 360, configurable: true })
    await w.findAll('.disc-form textarea')[0].setValue('lots of text')
    expect(el.style.height).toBe('200px')
    // 关闭(Cancel)后表单 v-if 移除,重开为全新 DOM,高度复位。
    await w.find('.disc-form button.disc-btn').trigger('click')
    expect(w.find('.disc-form').exists()).toBe(false)
    await w.find('.disc-new-btn').trigger('click')
    const reopened = w.findAll('.disc-form textarea')[0].element as HTMLTextAreaElement
    expect(reopened.style.height).toBe('')
  })

  it('收缩/展开按钮:切换 collapsed 并隐藏行内次要信息(type)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { type: 'design' })] })
    // 默认展开态:type 可见
    expect(w.find('.disc-list').classes()).not.toContain('collapsed')
    expect(w.find('.disc-type').exists()).toBe(true)
    // 收缩:面板加 collapsed 类,type 隐藏
    await w.find('.disc-collapse-btn').trigger('click')
    expect(w.find('.disc-list').classes()).toContain('collapsed')
    expect(w.find('.disc-type').exists()).toBe(false)
    // 收缩态下 Open chat 入口仍可用
    await w.find('.disc-open-btn').trigger('click')
    expect(w.emitted('open')).toEqual([['d1']])
    // 再次点击恢复展开态
    await w.find('.disc-collapse-btn').trigger('click')
    expect(w.find('.disc-list').classes()).not.toContain('collapsed')
  })
})
