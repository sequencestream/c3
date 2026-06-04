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
    researchResult: '',
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

function mountList(
  props: Partial<{
    discussions: Discussion[]
    activeId: string | null
    runState: Record<string, 'running' | 'paused'>
  }> = {},
) {
  return mount(DiscussionList, {
    props: { discussions: [], activeId: null, ...props },
  })
}

// Click the detail tab by its stable kind (goal/context/conclusion/details) — never by
// the visible label, so the assertion survives i18n extraction of the tab copy.
async function clickTab(w: ReturnType<typeof mountList>, kind: string): Promise<void> {
  const tab = w.find(`[data-testid="disc-tab-${kind}"]`)
  if (!tab.exists()) throw new Error(`tab not found: ${kind}`)
  await tab.trigger('click')
}

describe('DiscussionList.vue — 讨论列表(读路径)', () => {
  it('渲染讨论列表,点击行主体 → emit open(id),且不再有 Open chat 按钮', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const items = w.findAll('.disc-item')
    expect(items.length).toBe(2)
    expect(items.map((i) => i.find('.disc-title').text())).toEqual(['Alpha', 'Beta'])
    // Open chat 按钮已删除
    expect(w.find('.disc-open-btn').exists()).toBe(false)
    // 点击行主体即在右侧打开 chat
    await items[1].find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toEqual([['d2']])
  })

  it('键盘 Enter / Space 聚焦行主体 → emit open(id)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-item-main').trigger('keydown.enter')
    await w.find('.disc-item-main').trigger('keydown.space')
    expect(w.emitted('open')).toEqual([['d1'], ['d1']])
  })

  it('点击行主体:同时 emit open 并展开内联详情(无 chevron)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    // 行首箭头已移除
    expect(w.find('.disc-chevron').exists()).toBe(false)
    // 点击行主体:既打开 chat,又展开内联详情
    await w.find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toEqual([['d1']])
    // 无 goal/context/conclusion → 仅 Details Tab,展开即显示结构化元信息列表。
    expect(w.find('.disc-detail').exists()).toBe(true)
    expect(w.find('.disc-meta-list').exists()).toBe(true)
  })

  it('手风琴互斥:至多一项展开,再次点击同行收起(每次点击仍 emit open)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const mains = w.findAll('.disc-item-main')
    await mains[0].trigger('click')
    expect(w.findAll('.disc-detail').length).toBe(1)
    // 展开第二项 → 第一项自动收起(互斥)
    await mains[1].trigger('click')
    expect(w.findAll('.disc-detail').length).toBe(1)
    // 再次点击第二项 → 详情收起,但 chat 仍被打开(open 幂等)
    await mains[1].trigger('click')
    expect(w.findAll('.disc-detail').length).toBe(0)
    expect(w.emitted('open')).toEqual([['d1'], ['d2'], ['d2']])
  })

  it('展开详情:Tab 切换显示 goal/context/conclusion 与元信息', async () => {
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
    // 首个有内容的 Tab(Goal)默认激活,内容区一次只渲染一个字段。
    expect(w.find('.disc-tab-body').text()).toContain('Decide TTL')
    await clickTab(w, 'context')
    expect(w.find('.disc-tab-body').text()).toContain('Redis')
    await clickTab(w, 'conclusion')
    expect(w.find('.disc-tab-body').text()).toContain('Use 60s')
    // Details Tab:结构化元信息行按 testid 断言存在,不依赖标签译文。
    await clickTab(w, 'details')
    expect(w.find('[data-testid="disc-meta-created"]').exists()).toBe(true)
    expect(w.find('[data-testid="disc-meta-completed"]').exists()).toBe(true)
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

  it('状态以彩色 pill 呈现:状态 CSS 类(不依赖文案译文)', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { status: 'completed' })] })
    const pill = w.find('.disc-status')
    expect(pill.exists()).toBe(true)
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
    // 收缩态下点击行主体仍可打开 chat
    await w.find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toEqual([['d1']])
    // 再次点击恢复展开态
    await w.find('.disc-collapse-btn').trigger('click')
    expect(w.find('.disc-list').classes()).not.toContain('collapsed')
  })

  it('实时运行徽标:running/paused 渲染且与静态状态 pill 区分', () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')],
      runState: { d1: 'running' },
    })
    const items = w.findAll('.disc-item')
    // d1 有 running 徽标(带脉冲点),且静态 status pill 仍在(两者并存、可区分)。
    const run1 = items[0].find('.disc-run')
    expect(run1.exists()).toBe(true)
    expect(run1.classes()).toContain('running')
    expect(run1.find('.disc-run-dot').exists()).toBe(true)
    expect(items[0].find('.disc-status').exists()).toBe(true)
    // d2 无活跃 run → 不渲染徽标。
    expect(items[1].find('.disc-run').exists()).toBe(false)
  })

  it('并发多项:各讨论按自身 run-state 各自渲染徽标', () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta'), disc('d3', 'Gamma')],
      runState: { d1: 'running', d2: 'paused' },
    })
    const items = w.findAll('.disc-item')
    expect(items[0].find('.disc-run').classes()).toContain('running')
    const run2 = items[1].find('.disc-run')
    expect(run2.classes()).toContain('paused')
    expect(items[2].find('.disc-run').exists()).toBe(false)
  })

  it('默认无 run-state prop 时不渲染任何徽标', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    expect(w.find('.disc-run').exists()).toBe(false)
  })
})
