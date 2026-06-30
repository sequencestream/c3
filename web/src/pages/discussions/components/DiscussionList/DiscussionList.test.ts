import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import DiscussionList from './DiscussionList.vue'

function ag(id: string, displayName: string, over: Partial<AgentConfig> = {}): AgentConfig {
  // Base is a claude agent; `over` may widen the vendor discriminant, which the
  // union can't track through a spread — cast back to the (claude-shaped) base.
  return {
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  } as AgentConfig
}

function disc(id: string, title: string, over: Partial<Discussion> = {}): Discussion {
  return {
    id,
    workspaceId: '/home/proj-a',
    title,
    type: 'design',
    goal: '',
    context: '',
    researchResult: '',
    status: 'in_progress',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    organizerAgentId: null,
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

describe('DiscussionList.vue — 讨论列表(纯选中,无行内抽屉)', () => {
  it('渲染讨论列表,点击行主体 → emit open(id),且不再有 Open chat 按钮', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const items = w.findAll('.disc-item')
    expect(items.length).toBe(2)
    expect(items.map((i) => i.find('.disc-title').text())).toEqual(['Alpha', 'Beta'])
    // Open chat 按钮已删除
    expect(w.find('.disc-open-btn').exists()).toBe(false)
    // 点击行主体即在右侧选中并打开
    await items[1].find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toEqual([['d2']])
  })

  it('键盘 Enter / Space 聚焦行主体 → emit open(id)', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha')] })
    await w.find('.disc-item-main').trigger('keydown.enter')
    await w.find('.disc-item-main').trigger('keydown.space')
    expect(w.emitted('open')).toEqual([['d1'], ['d1']])
  })

  it('点击行主体只 emit open(id),不渲染行内抽屉(详情已移到右栏)', async () => {
    const w = mountList({
      discussions: [
        disc('d1', 'Alpha', {
          goal: 'Decide TTL',
          context: 'Redis',
          researchResult: '# R',
          conclusion: 'Use 60s',
        }),
      ],
    })
    // 行首箭头已移除,行主体无 aria-expanded(不再承担展开能力)
    expect(w.find('.disc-chevron').exists()).toBe(false)
    expect(w.find('.disc-item-main').attributes('aria-expanded')).toBeUndefined()
    await w.find('.disc-item-main').trigger('click')
    expect(w.emitted('open')).toEqual([['d1']])
    // 不再出现行内抽屉 / Tab 栏 / markdown / 元信息详情
    expect(w.find('.disc-detail').exists()).toBe(false)
    expect(w.find('.disc-tab').exists()).toBe(false)
    expect(w.find('.disc-tab-body').exists()).toBe(false)
    expect(w.find('.disc-meta-list').exists()).toBe(false)
    expect(w.find('.md-body').exists()).toBe(false)
  })

  it('重复点击同一行:每次只 emit open(id),无「收起详情」副作用', async () => {
    const w = mountList({ discussions: [disc('d1', 'Alpha'), disc('d2', 'Beta')] })
    const mains = w.findAll('.disc-item-main')
    await mains[0].trigger('click')
    await mains[1].trigger('click')
    await mains[1].trigger('click')
    // 三次点击三次 emit,无任何行内抽屉
    expect(w.emitted('open')).toEqual([['d1'], ['d2'], ['d2']])
    expect(w.findAll('.disc-detail').length).toBe(0)
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

  it('点击顶部「+」打开弹窗,填写后提交 → emit create(含 participantAgentIds + organizerAgentId)', async () => {
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
    // 默认全选(system + gpt),participantAgentIds 含两者(顺序无关),organizerAgentId 默认为 defaultAgentId。
    const events = w.emitted('create') as Array<
      [
        {
          type: string
          goal: string
          context: string
          participantAgentIds: string[]
          organizerAgentId: string
        },
      ]
    >
    expect(events).toHaveLength(1)
    const payload = events[0][0]
    expect(payload).toMatchObject({
      type: firstValue,
      goal: 'Decide cache TTL',
      context: 'Redis today',
      organizerAgentId: 'system',
    })
    expect([...payload.participantAgentIds].sort()).toEqual(['gpt', 'system'])
    // 提交后弹窗关闭
    expect(w.find('.disc-modal-overlay').exists()).toBe(false)
  })

  it('参与者面板:默认全选,组织者可取消勾选', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT'), ag('claude', 'Claude')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    // 组织者(system)复选框选中但不再禁用;radio 默认选中且 badge 显示。
    const orgCheckbox = w.find('[data-testid="disc-participant-system"] input[type="checkbox"]')
    expect((orgCheckbox.element as HTMLInputElement).checked).toBe(true)
    expect((orgCheckbox.element as HTMLInputElement).disabled).toBe(false)
    const orgRadio = w.find('[data-testid="disc-organizer-system"]')
    expect((orgRadio.element as HTMLInputElement).checked).toBe(true)
    // 取消勾选 gpt 与 claude,只剩组织者。
    await w.find('[data-testid="disc-participant-gpt"] input[type="checkbox"]').trigger('change')
    await w.find('[data-testid="disc-participant-claude"] input[type="checkbox"]').trigger('change')
    // 组织者仍在选中集合,加上 goal → 可提交。
    await w.findAll('.disc-modal textarea')[0].setValue('Goal')
    await w.find('.disc-modal').trigger('submit')
    const events = w.emitted('create') as Array<
      [{ participantAgentIds: string[]; organizerAgentId: string }]
    >
    expect(events[0][0].participantAgentIds).toEqual(['system'])
    expect(events[0][0].organizerAgentId).toEqual('system')
  })

  it('取消 organizer → 按钮禁用 + 错误提示出现', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    // 默认全选,填 goal → 可提交。
    await w.findAll('.disc-modal textarea')[0].setValue('Goal')
    const submitBtn = w.find('.disc-modal button[type="submit"]')
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(false)
    // 取消 organizer → 按钮禁用 + 错误提示。
    await w.find('[data-testid="disc-participant-system"] input[type="checkbox"]').trigger('change')
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('.disc-form-error').exists()).toBe(true)
  })

  it('重新勾上 organizer + 任一其他 agent → 按钮恢复', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    await w.findAll('.disc-modal textarea')[0].setValue('Goal')
    const submitBtn = w.find('.disc-modal button[type="submit"]')
    // 取消 organizer → 禁用。
    await w.find('[data-testid="disc-participant-system"] input[type="checkbox"]').trigger('change')
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true)
    // 重新勾上 organizer → 恢复(至少还有一个其他 agent gpt 在选中态)。
    await w.find('[data-testid="disc-participant-system"] input[type="checkbox"]').trigger('change')
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect(w.find('.disc-form-error').exists()).toBe(false)
  })

  it('取消全部 → 按钮禁用', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    await w.findAll('.disc-modal textarea')[0].setValue('Goal')
    const submitBtn = w.find('.disc-modal button[type="submit"]')
    // 取消全部 agent。
    await w.find('[data-testid="disc-participant-system"] input[type="checkbox"]').trigger('change')
    await w.find('[data-testid="disc-participant-gpt"] input[type="checkbox"]').trigger('change')
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('切换 organizer radio:选中不同 agent 为组织者', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT'), ag('claude', 'Claude')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    // 默认 radio 选中 system。
    expect(
      (w.find('[data-testid="disc-organizer-system"]').element as HTMLInputElement).checked,
    ).toBe(true)
    // 切换到 gpt。
    await w.find('[data-testid="disc-organizer-gpt"]').trigger('change')
    expect((w.find('[data-testid="disc-organizer-gpt"]').element as HTMLInputElement).checked).toBe(
      true,
    )
    expect(
      (w.find('[data-testid="disc-organizer-system"]').element as HTMLInputElement).checked,
    ).toBe(false)
    // badge 现在显示在 gpt 上。
    expect(w.find('[data-testid="disc-participant-gpt"] .disc-participant-badge').exists()).toBe(
      true,
    )
    expect(w.find('[data-testid="disc-participant-system"] .disc-participant-badge').exists()).toBe(
      false,
    )
  })

  it('取消 organizer agent → radio 自动回退到下一个被选中的 agent', async () => {
    const w = mountList({
      discussions: [disc('d1', 'Alpha')],
      agents: [ag('system', 'System'), ag('gpt', 'GPT'), ag('claude', 'Claude')],
      defaultAgentId: 'system',
    })
    await w.find('.disc-new-btn').trigger('click')
    // 默认 organizer 是 system。
    expect(
      (w.find('[data-testid="disc-organizer-system"]').element as HTMLInputElement).checked,
    ).toBe(true)
    // 取消勾选 system → radio 自动回退到 gpt(第一个剩余选中项)。
    await w.find('[data-testid="disc-participant-system"] input[type="checkbox"]').trigger('change')
    expect((w.find('[data-testid="disc-organizer-gpt"]').element as HTMLInputElement).checked).toBe(
      true,
    )
    expect(
      (w.find('[data-testid="disc-organizer-system"]').element as HTMLInputElement).disabled,
    ).toBe(true)
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
