import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import DiscussionList from './DiscussionList.vue'

function ag(id: string, displayName: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  }
}

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
    participantAgentIds: [],
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
    runAgentNames: Record<string, string>
    agents: AgentConfig[]
    defaultAgentId: string | null
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

  it('Research tab:researchResult 非空时出现并渲染 Markdown;为空时不出现', async () => {
    // 非空:tab 出现在 context 与 conclusion 之间,body 经 MarkdownText 渲染
    const withResearch = mountList({
      discussions: [
        disc('d1', 'Alpha', {
          goal: 'G',
          context: 'C',
          researchResult: '# 研究员产出\n- a\n- b',
          conclusion: 'X',
        }),
      ],
    })
    await withResearch.find('.disc-item-main').trigger('click')
    // 5 个 tab(goal/context/research/conclusion/details)按顺序
    const tabs = withResearch.findAll('.disc-tab')
    expect(tabs.map((t) => t.attributes('data-testid'))).toEqual([
      'disc-tab-goal',
      'disc-tab-context',
      'disc-tab-research',
      'disc-tab-conclusion',
      'disc-tab-details',
    ])
    // 切换到 research:MarkdownText 渲染出 h1 + 列表
    await clickTab(withResearch, 'research')
    const body = withResearch.find('.disc-tab-body .md-body')
    expect(body.exists()).toBe(true)
    expect(body.find('h1').text()).toBe('研究员产出')
    expect(body.findAll('li').length).toBe(2)
    // tab label 经 i18n("Research")
    expect(tabs[2].text()).toBe('Research')

    // 空:不出现 research tab,context 之后直接 conclusion
    const noResearch = mountList({
      discussions: [disc('d2', 'Beta', { goal: 'G', context: 'C', conclusion: 'X' })],
    })
    await noResearch.find('.disc-item-main').trigger('click')
    const tabs2 = noResearch.findAll('.disc-tab')
    expect(tabs2.map((t) => t.attributes('data-testid'))).toEqual([
      'disc-tab-goal',
      'disc-tab-context',
      'disc-tab-conclusion',
      'disc-tab-details',
    ])
    expect(noResearch.find('[data-testid="disc-tab-research"]').exists()).toBe(false)
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

  it('点击顶部「+」打开弹窗,填写后提交 → emit create(含 participantAgentIds)', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT')],
      defaultAgentId: 'system',
    })
    // 默认不显示弹窗
    expect(w.find('.disc-modal-overlay').exists()).toBe(false)
    await w.find('.disc-new-btn').trigger('click')
    expect(w.find('.disc-modal-overlay').exists()).toBe(true)
    // 选类型 + 填目标/上下文,提交
    const options = w.findAll('.disc-modal select option')
    expect(options.length).toBeGreaterThan(0)
    const firstValue = (options[0].element as HTMLOptionElement).value
    await w.find('.disc-modal select').setValue(firstValue)
    await w.findAll('.disc-modal textarea')[0].setValue('Decide cache TTL')
    await w.findAll('.disc-modal textarea')[1].setValue('Redis today')
    await w.find('.disc-modal').trigger('submit')
    // 默认全选(system + gpt),participantAgentIds 含两者(顺序无关)。
    const events = w.emitted('create') as Array<
      [{ type: string; goal: string; context: string; participantAgentIds: string[] }]
    >
    expect(events).toHaveLength(1)
    const payload = events[0][0]
    expect(payload).toMatchObject({
      type: firstValue,
      goal: 'Decide cache TTL',
      context: 'Redis today',
    })
    expect([...payload.participantAgentIds].sort()).toEqual(['gpt', 'system'])
    // 提交后弹窗关闭
    expect(w.find('.disc-modal-overlay').exists()).toBe(false)
  })

  it('参与者面板:默认全选,组织者项恒选且禁用,取消勾选未选 agent 不进集合', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT'), ag('claude', 'Claude')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    // 组织者(system)复选框选中且禁用。
    const orgBox = w.find('[data-testid="disc-participant-system"] input')
    expect((orgBox.element as HTMLInputElement).checked).toBe(true)
    expect((orgBox.element as HTMLInputElement).disabled).toBe(true)
    // 取消勾选 gpt 与 claude,只剩组织者。
    await w.find('[data-testid="disc-participant-gpt"] input').trigger('change')
    await w.find('[data-testid="disc-participant-claude"] input').trigger('change')
    await w.findAll('.disc-modal textarea')[0].setValue('Goal')
    await w.find('.disc-modal').trigger('submit')
    const events = w.emitted('create') as Array<[{ participantAgentIds: string[] }]>
    expect(events[0][0].participantAgentIds).toEqual(['system'])
  })

  it('目标为空时不提交,「+」可再次点击关闭弹窗', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    await w.find('.disc-modal').trigger('submit')
    expect(w.emitted('create')).toBeUndefined()
    // 再次点击「+」关闭
    await w.find('.disc-new-btn').trigger('click')
    expect(w.find('.disc-modal-overlay').exists()).toBe(false)
  })

  it('生命周期态以统一指示器 tone class 呈现(不依赖文案译文)', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { status: 'completed' })] })
    const ind = w.find('.disc-status-indicator')
    expect(ind.exists()).toBe(true)
    expect(ind.classes()).toContain('completed')
    expect(w.find('.disc-item').classes()).toContain('completed')
  })

  it('Goal/Context textarea auto-grow:高度跟随内容并在 200px 上限处出现内部滚动', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-new-btn').trigger('click')
    const goal = w.findAll('.disc-modal textarea')[0]
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
    const el = w.findAll('.disc-modal textarea')[0].element as HTMLTextAreaElement
    Object.defineProperty(el, 'scrollHeight', { get: () => 360, configurable: true })
    await w.findAll('.disc-modal textarea')[0].setValue('lots of text')
    expect(el.style.height).toBe('200px')
    // 关闭(Cancel)后弹窗 v-if 移除,重开为全新 DOM,高度复位。
    await w.find('.disc-modal button.disc-btn').trigger('click')
    expect(w.find('.disc-modal-overlay').exists()).toBe(false)
    await w.find('.disc-new-btn').trigger('click')
    const reopened = w.findAll('.disc-modal textarea')[0].element as HTMLTextAreaElement
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

  it('单一统一指示器:有 run 显 run 态,旧双指示器(disc-run/disc-status)已合并', () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta', { status: 'in_progress' })],
      runState: { d1: 'running' },
    })
    const items = w.findAll('.disc-item')
    // 旧的双指示器类已不存在(合并为单一)。
    expect(w.find('.disc-run').exists()).toBe(false)
    expect(w.find('.disc-status').exists()).toBe(false)
    // d1:每行恰好一个统一指示器,run 在场显 running tone + 脉冲图标。
    expect(items[0].findAll('.disc-status-indicator')).toHaveLength(1)
    const ind1 = items[0].find('.disc-status-indicator')
    expect(ind1.classes()).toContain('running')
    expect(ind1.find('.status-icon').classes()).toContain('spin')
    // d2 无活跃 run → 回退生命周期(in_progress)tone,不脉冲。
    const ind2 = items[1].find('.disc-status-indicator')
    expect(ind2.classes()).toContain('in_progress')
    expect(ind2.find('.status-icon').classes()).not.toContain('spin')
  })

  it('并发多项:各行按「有 run 显 run、否则生命周期」各自映射 tone', () => {
    const w = mountList({
      discussions: [
        disc('d1', 'Alpha'),
        disc('d2', 'Beta'),
        disc('d3', 'Gamma', { status: 'completed' }),
      ],
      runState: { d1: 'running', d2: 'paused' },
    })
    const items = w.findAll('.disc-item')
    expect(items[0].find('.disc-status-indicator').classes()).toContain('running')
    expect(items[1].find('.disc-status-indicator').classes()).toContain('paused')
    // d3 无 run → 生命周期 completed tone。
    expect(items[2].find('.disc-status-indicator').classes()).toContain('completed')
  })

  it('默认无 run-state prop:回退生命周期态(单一指示器仍在,不脉冲)', () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha', { status: 'draft' })] })
    const ind = w.find('.disc-status-indicator')
    expect(ind.exists()).toBe(true)
    expect(ind.classes()).toContain('draft')
    expect(ind.find('.status-icon').classes()).not.toContain('spin')
  })

  it('run 态 <agent> 段:有名以 `<agent>.` 起头,无名优雅省略(无残留点号)', () => {
    const withAgent = mountList({
      discussions: [disc('d1', 'Alpha')],
      runState: { d1: 'running' },
      runAgentNames: { d1: 'Planner' },
    })
    expect(withAgent.find('.disc-status-indicator .status-text').text()).toMatch(/^Planner\./)
    // 同一 run 无 agent 名 → 不以点号起头。
    const noAgent = mountList({
      discussions: [disc('d1', 'Alpha')],
      runState: { d1: 'running' },
    })
    expect(noAgent.find('.disc-status-indicator .status-text').text()).not.toMatch(/^\./)
  })
})
