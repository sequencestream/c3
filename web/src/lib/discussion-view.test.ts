import { describe, it, expect } from 'vitest'
import type { AgentConfig, Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import {
  agendaProgressView,
  applyDispatchStatus,
  clearDispatchAgent,
  discussionDetailTabs,
  discussionMessageToChat,
  discussionMessagesToChat,
  discussionRunLabel,
  panelToggleLabel,
  reconcileRunState,
  resolveDiscussionSpeaker,
  rowVisibility,
  statusLabel,
  type DispatchView,
} from './discussion-view'

function disc(over: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    projectPath: '/proj',
    title: 'T',
    type: 'design',
    goal: '',
    context: '',
    researchResult: '',
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

function msg(over: Partial<DiscussionMessage>): DiscussionMessage {
  return {
    id: 'm1',
    discussionId: 'd1',
    seq: 1,
    speakerKind: 'agent',
    speakerAgentId: null,
    speakerName: null,
    content: 'hello',
    createdAt: 0,
    ...over,
  }
}

function agent(over: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a',
    name: 'A',
    baseUrl: '',
    apiKey: '',
    model: '',
    ...over,
  }
}

// Tiny i18n stand-in: maps the three discussion.speaker.* keys to fixed labels
// so the resolver tests don't have to drag in the full i18n setup. The
// production caller (App.vue) passes the real typed `t` from useTypedI18n().
const T = (
  k: 'discussion.speaker.you' | 'discussion.speaker.organizer' | 'discussion.speaker.agent',
) => {
  if (k === 'discussion.speaker.you') return 'You'
  if (k === 'discussion.speaker.organizer') return 'Organizer'
  return 'Agent'
}

const AGENTS: AgentConfig[] = [
  agent({ id: 'default', name: 'Default Agent', icon: '🧠' }),
  agent({ id: 'reviewer', name: 'Reviewer', icon: '🔍' }),
  agent({ id: 'noicon', name: 'Plain', icon: '' }),
]
const DEFAULT_ID = 'default'

describe('discussion-view — DiscussionMessage → ChatBody', () => {
  it('human → user 气泡,正文不拼前缀,带 speaker(You + 人类默认图标)', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'human', content: 'hi' }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({ kind: 'user', text: 'hi', speaker: { icon: '🙋', name: 'You' } })
  })

  it('agent → assistant 气泡,正文不拼前缀,带 speaker(命中 agent 的 icon + speakerName)', () => {
    const b = discussionMessageToChat(
      msg({
        speakerKind: 'agent',
        speakerAgentId: 'reviewer',
        speakerName: 'Reviewer',
        content: 'lgtm',
      }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({
      kind: 'assistant',
      text: 'lgtm',
      speaker: { icon: '🔍', name: 'Reviewer' },
    })
  })

  it('organizer → assistant 气泡,正文不拼前缀,带 speaker(默认 agent 的 icon + name)', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'organizer', speakerName: 'Org', content: 'go' }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({
      kind: 'assistant',
      text: 'go',
      speaker: { icon: '🧠', name: 'Default Agent' },
    })
  })

  it('agent 未配 icon → 回退通用默认图标,但 speakerName 仍取自消息', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerAgentId: 'noicon', speakerName: 'Plain', content: 'x' }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({ kind: 'assistant', text: 'x', speaker: { icon: '🤖', name: 'Plain' } })
  })

  it('agent 不在配置中 → 通用回退(图标 + i18n Agent)', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerAgentId: 'ghost', speakerName: null, content: 'x' }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({ kind: 'assistant', text: 'x', speaker: { icon: '🤖', name: 'Agent' } })
  })

  it('agent 命中但 speakerName 为空 → 退到 agent 自身的 name', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerAgentId: 'reviewer', speakerName: null, content: 'x' }),
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(b).toEqual({ kind: 'assistant', text: 'x', speaker: { icon: '🔍', name: 'Reviewer' } })
  })

  it('organizer 默认 agent 缺失 → 通用回退(图标 + i18n Organizer)', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'organizer', content: 'go' }),
      [], // 空 agents
      'missing',
      T,
    )
    expect(b).toEqual({ kind: 'assistant', text: 'go', speaker: { icon: '🤖', name: 'Organizer' } })
  })

  it('serverSettings 尚未到位(空 agents + system 默认 id)→ 全部回退不报错', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerAgentId: 'a1', speakerName: 'A', content: 'x' }),
      [],
      'system',
      T,
    )
    expect(b).toEqual({ kind: 'assistant', text: 'x', speaker: { icon: '🤖', name: 'A' } })
  })

  it('批量映射保持顺序,每条都带 speaker', () => {
    const out = discussionMessagesToChat(
      [
        msg({ seq: 1, speakerKind: 'human', content: 'q' }),
        msg({
          seq: 2,
          speakerKind: 'agent',
          speakerAgentId: 'reviewer',
          speakerName: 'A',
          content: 'a',
        }),
      ],
      AGENTS,
      DEFAULT_ID,
      T,
    )
    expect(out).toEqual([
      { kind: 'user', text: 'q', speaker: { icon: '🙋', name: 'You' } },
      { kind: 'assistant', text: 'a', speaker: { icon: '🔍', name: 'A' } },
    ])
  })
})

describe('discussion-view — resolveDiscussionSpeaker(纯解析,五分支)', () => {
  it('human:固定人类图标 + i18n You', () => {
    expect(resolveDiscussionSpeaker(msg({ speakerKind: 'human' }), AGENTS, DEFAULT_ID, T)).toEqual({
      icon: '🙋',
      name: 'You',
    })
  })

  it('organizer:命中默认 agent → agent.icon + agent.name', () => {
    expect(
      resolveDiscussionSpeaker(msg({ speakerKind: 'organizer' }), AGENTS, DEFAULT_ID, T),
    ).toEqual({ icon: '🧠', name: 'Default Agent' })
  })

  it('organizer:默认 agent 缺 icon → 通用图标,保留 name', () => {
    const agentsNoIcon = [agent({ id: 'default', name: 'Default Agent', icon: '' })]
    expect(
      resolveDiscussionSpeaker(msg({ speakerKind: 'organizer' }), agentsNoIcon, 'default', T),
    ).toEqual({ icon: '🤖', name: 'Default Agent' })
  })

  it('organizer:默认 agent 不存在或默认 id 为空 → 通用图标 + i18n Organizer', () => {
    expect(resolveDiscussionSpeaker(msg({ speakerKind: 'organizer' }), [], 'missing', T)).toEqual({
      icon: '🤖',
      name: 'Organizer',
    })
    expect(resolveDiscussionSpeaker(msg({ speakerKind: 'organizer' }), AGENTS, null, T)).toEqual({
      icon: '🤖',
      name: 'Organizer',
    })
  })

  it('agent:命中 → agent.icon + speakerName(消息自带)', () => {
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'reviewer', speakerName: 'Rev' }),
        AGENTS,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🔍', name: 'Rev' })
  })

  it('agent:命中但 agent.icon 为空 / 仅空白 → 通用图标,名字保持', () => {
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'noicon', speakerName: 'Plain' }),
        AGENTS,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Plain' })
    // icon 字段为纯空白(用户误填)也走回退
    const blankIcon = [agent({ id: 'noicon', name: 'Plain', icon: '   ' })]
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'noicon', speakerName: 'Plain' }),
        blankIcon,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Plain' })
  })

  it('agent:未命中 / speakerAgentId 为空 → 通用图标,名字按 消息名→i18n Agent 顺序兜底', () => {
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'ghost', speakerName: 'G' }),
        AGENTS,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'G' })
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: null, speakerName: null }),
        AGENTS,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Agent' })
  })
})

describe('discussion-view — 列表面板视图纯函数', () => {
  it('statusLabel 四态映射到英文标签', () => {
    expect(statusLabel('draft')).toBe('Draft')
    expect(statusLabel('in_progress')).toBe('In progress')
    expect(statusLabel('completed')).toBe('Completed')
    expect(statusLabel('cancelled')).toBe('Cancelled')
  })

  it('panelToggleLabel:展开态提示 Collapse,收缩态提示 Expand', () => {
    const expanded = panelToggleLabel(false)
    expect(expanded.text).toBe('Collapse')
    expect(expanded.icon).toBe('⇤')
    expect(expanded.title).toContain('Collapse')
    const collapsed = panelToggleLabel(true)
    expect(collapsed.text).toBe('Expand')
    expect(collapsed.icon).toBe('⇥')
    expect(collapsed.title).toContain('Expand')
  })

  it('rowVisibility:展开态显示次要元信息,收缩态隐藏', () => {
    expect(rowVisibility(false)).toEqual({ showMeta: true })
    expect(rowVisibility(true)).toEqual({ showMeta: false })
  })

  it('discussionRunLabel:draft 显示 Researching…(研究中/待自动启动)', () => {
    expect(discussionRunLabel('draft', undefined)).toBe('Researching…')
    // run-state 对 draft 无意义,始终是 Researching…
    expect(discussionRunLabel('draft', 'running')).toBe('Researching…')
  })

  it('discussionRunLabel:in_progress 跟随 run-state(Running / Paused)', () => {
    expect(discussionRunLabel('in_progress', 'running')).toBe('Running')
    expect(discussionRunLabel('in_progress', undefined)).toBe('Running')
    expect(discussionRunLabel('in_progress', 'paused')).toBe('Paused')
  })

  it('discussionRunLabel:终态映射到 Completed / Cancelled', () => {
    expect(discussionRunLabel('completed', undefined)).toBe('Completed')
    expect(discussionRunLabel('cancelled', undefined)).toBe('Cancelled')
  })
})

describe('discussion-view — discussionDetailTabs(展开详情 Tab)', () => {
  it('全字段非空:goal/context/conclusion + details 顺序', () => {
    const tabs = discussionDetailTabs(disc({ goal: 'G', context: 'C', conclusion: 'X' }))
    expect(tabs.map((t) => t.kind)).toEqual(['goal', 'context', 'conclusion', 'details'])
    expect(tabs.map((t) => t.label)).toEqual(['Goal', 'Context', 'Conclusion', 'Details'])
    expect(tabs[0].body).toBe('G')
    expect(tabs.at(-1)?.body).toBeNull()
  })

  it('空 / 纯空白字段被剔除:仅保留非空字段 + details', () => {
    const tabs = discussionDetailTabs(disc({ goal: 'G', context: '   ', conclusion: null }))
    expect(tabs.map((t) => t.kind)).toEqual(['goal', 'details'])
  })

  it('全空:仅剩 details 兜底 Tab(列表永不为空)', () => {
    const tabs = discussionDetailTabs(disc({ goal: '', context: '', conclusion: null }))
    expect(tabs.map((t) => t.kind)).toEqual(['details'])
    expect(tabs[0].body).toBeNull()
  })

  it('body 透传原文(不 trim,trim 仅用于空判定)', () => {
    const tabs = discussionDetailTabs(
      disc({ goal: '  # 标题\n正文  ', context: '', conclusion: null }),
    )
    expect(tabs[0].body).toBe('  # 标题\n正文  ')
  })
})

describe('discussion-view — agendaProgressView(议程进度选择器)', () => {
  it('null / 空议程 → 隐藏', () => {
    expect(agendaProgressView(null).visible).toBe(false)
    const v = agendaProgressView(disc({ agenda: [] }))
    expect(v).toEqual({
      visible: false,
      items: [],
      current: null,
      completed: 0,
      total: 0,
      percent: 0,
      complete: false,
    })
  })

  it('部分完成:done/current/upcoming 标记 + 当前子题 + 百分比', () => {
    const v = agendaProgressView(disc({ agenda: ['A', 'B', 'C', 'D'], agendaIndex: 1 }))
    expect(v.visible).toBe(true)
    expect(v.items.map((i) => i.status)).toEqual(['done', 'current', 'upcoming', 'upcoming'])
    expect(v.current).toBe('B')
    expect(v.completed).toBe(1)
    expect(v.total).toBe(4)
    expect(v.percent).toBe(25)
    expect(v.complete).toBe(false)
  })

  it('全部完成(index === length):100%、current 为 null、全 done', () => {
    const v = agendaProgressView(disc({ agenda: ['A', 'B'], agendaIndex: 2 }))
    expect(v.items.map((i) => i.status)).toEqual(['done', 'done'])
    expect(v.current).toBeNull()
    expect(v.completed).toBe(2)
    expect(v.percent).toBe(100)
    expect(v.complete).toBe(true)
  })

  it('索引越界 / 负值 → clamp 到 [0, length],不产生越界 current 或负百分比', () => {
    const over = agendaProgressView(disc({ agenda: ['A', 'B'], agendaIndex: 99 }))
    expect(over.current).toBeNull()
    expect(over.percent).toBe(100)
    expect(over.complete).toBe(true)
    const neg = agendaProgressView(disc({ agenda: ['A', 'B'], agendaIndex: -3 }))
    expect(neg.items.map((i) => i.status)).toEqual(['current', 'upcoming'])
    expect(neg.current).toBe('A')
    expect(neg.percent).toBe(0)
  })
})

describe('discussion-view — reconcileRunState(运行态快照对账)', () => {
  const items = (...ids: string[]) => ids.map((id) => ({ id }))

  it('快照缺省(undefined)→ 原样返回,不改动', () => {
    const prev = { d1: 'running' as const }
    expect(reconcileRunState(prev, items('d1'), undefined)).toBe(prev)
  })

  it('按快照对列表内讨论 set/delete:活跃置态,缺席清除(修重连残留)', () => {
    const prev = { d1: 'running' as const, d2: 'paused' as const }
    // d1 仍活跃→running;d2 不在快照→清除(断连期间错过的 ended);d3 新增→paused。
    const next = reconcileRunState(prev, items('d1', 'd2', 'd3'), { d1: 'running', d3: 'paused' })
    expect(next).toEqual({ d1: 'running', d3: 'paused' })
  })

  it('只触碰列表内 id:其他项目的运行态条目保持不变', () => {
    const prev = { other: 'running' as const, d1: 'paused' as const }
    // 本次列表只含 d1;other(他项目)不在 items → 保留。
    const next = reconcileRunState(prev, items('d1'), { d1: 'running' })
    expect(next).toEqual({ other: 'running', d1: 'running' })
  })

  it('返回新对象,不可变(不修改入参)', () => {
    const prev = { d1: 'running' as const }
    const next = reconcileRunState(prev, items('d1'), {})
    expect(next).not.toBe(prev)
    expect(prev).toEqual({ d1: 'running' })
    expect(next).toEqual({})
  })
})

describe('applyDispatchStatus / clearDispatchAgent (transient dispatch status)', () => {
  const A = { id: 'a', name: 'Alice' }
  const B = { id: 'b', name: 'Bob' }
  const empty: DispatchView = { pending: [], errors: [] }

  it('pending: 把派发的 agent 并入在途(broadcast 多个)', () => {
    const v = applyDispatchStatus(undefined, { phase: 'pending', agents: [A, B] })
    expect(v.pending).toEqual([A, B])
    expect(v.errors).toEqual([])
  })

  it('pending: 重复 id 去重,保持到达顺序', () => {
    const v1 = applyDispatchStatus(empty, { phase: 'pending', agents: [A] })
    const v2 = applyDispatchStatus(v1, { phase: 'pending', agents: [A, B] })
    expect(v2.pending).toEqual([A, B])
  })

  it('cleared: 从在途移除对应 agent(回复落库后清除)', () => {
    const v1 = applyDispatchStatus(empty, { phase: 'pending', agents: [A, B] })
    const v2 = applyDispatchStatus(v1, { phase: 'cleared', agents: [A] })
    expect(v2.pending).toEqual([B])
  })

  it('failed: 移除在途并记录瞬态错误', () => {
    const v1 = applyDispatchStatus(empty, { phase: 'pending', agents: [A, B] })
    const v2 = applyDispatchStatus(v1, { phase: 'failed', agents: [A], error: 'boom' })
    expect(v2.pending).toEqual([B])
    expect(v2.errors).toEqual([{ id: 'a', name: 'Alice', error: 'boom' }])
  })

  it('failed: 同 agent 再次失败按 id 去重(不堆叠重复错误)', () => {
    const v1 = applyDispatchStatus(empty, { phase: 'failed', agents: [A], error: 'e1' })
    const v2 = applyDispatchStatus(v1, { phase: 'failed', agents: [A], error: 'e2' })
    expect(v2.errors).toEqual([{ id: 'a', name: 'Alice', error: 'e2' }])
  })

  it('pending: 重新派发的 agent 清掉它的旧错误', () => {
    const v1 = applyDispatchStatus(empty, { phase: 'failed', agents: [A], error: 'boom' })
    const v2 = applyDispatchStatus(v1, { phase: 'pending', agents: [A] })
    expect(v2.errors).toEqual([])
    expect(v2.pending).toEqual([A])
  })

  it('不可变:不修改入参', () => {
    const prev: DispatchView = { pending: [A], errors: [] }
    const next = applyDispatchStatus(prev, { phase: 'cleared', agents: [A] })
    expect(next).not.toBe(prev)
    expect(prev.pending).toEqual([A])
  })

  it('clearDispatchAgent: 按 speakerAgentId 清除在途(消息到达的主清除路径)', () => {
    const prev: DispatchView = { pending: [A, B], errors: [] }
    const next = clearDispatchAgent(prev, 'a')
    expect(next?.pending).toEqual([B])
  })

  it('clearDispatchAgent: 无匹配 / null 时原样返回(幂等)', () => {
    const prev: DispatchView = { pending: [A], errors: [] }
    expect(clearDispatchAgent(prev, 'zzz')).toBe(prev)
    expect(clearDispatchAgent(prev, null)).toBe(prev)
    expect(clearDispatchAgent(undefined, 'a')).toBeUndefined()
  })
})
