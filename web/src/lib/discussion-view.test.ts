import { describe, it, expect } from 'vitest'
import type {
  AgentConfig,
  Discussion,
  DiscussionMessage,
  ResearchMessage,
} from '@ccc/shared/protocol'
import {
  agendaProgressView,
  applyDispatchStatus,
  clearDispatchAgent,
  discussionDetailTabs,
  discussionMessageToChat,
  discussionMessagesToChat,
  discussionPhase,
  discussionRunLabel,
  panelToggleLabel,
  reconcileRunState,
  reconcileResearchState,
  researchMessageToChat,
  resolveDiscussionSpeaker,
  rowVisibility,
  showDiscussionStart,
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
  // Base is a claude arm; `...over` is a Partial over the discriminated union, so
  // the spread cannot be statically correlated — cast to the wire type (test fixture).
  return {
    id: 'a',
    vendor: 'claude',
    displayName: 'A',
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  } as AgentConfig
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

// Stub for the discussionDetailTabs i18n key — keeps the typed t contract local
// to this test file (the real typed `t` from useTypedI18n is wider; this narrow
// shape is assignable to the (key: 'discussion.tabs.research.label') => string
// parameter the function expects).
const TABS_T = (k: 'discussion.tabs.research.label') =>
  k === 'discussion.tabs.research.label' ? 'Research' : k

const AGENTS: AgentConfig[] = [
  agent({ id: 'default', displayName: 'Default Agent', icon: '🧠' }),
  agent({ id: 'reviewer', displayName: 'Reviewer', icon: '🔍' }),
  agent({ id: 'noicon', displayName: 'Plain', icon: '' }),
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
      speaker: { icon: '🔍', name: 'Reviewer', vendor: 'claude' },
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
    expect(b).toEqual({
      kind: 'assistant',
      text: 'x',
      speaker: { icon: '🤖', name: 'Plain', vendor: 'claude' },
    })
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
    expect(b).toEqual({
      kind: 'assistant',
      text: 'x',
      speaker: { icon: '🔍', name: 'Reviewer', vendor: 'claude' },
    })
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
      { kind: 'assistant', text: 'a', speaker: { icon: '🔍', name: 'A', vendor: 'claude' } },
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
    const agentsNoIcon = [agent({ id: 'default', displayName: 'Default Agent', icon: '' })]
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
    ).toEqual({ icon: '🔍', name: 'Rev', vendor: 'claude' })
  })

  it('agent:命中但 agent.icon 为空 / 仅空白 → 通用图标,名字保持', () => {
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'noicon', speakerName: 'Plain' }),
        AGENTS,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Plain', vendor: 'claude' })
    // icon 字段为纯空白(用户误填)也走回退
    const blankIcon = [agent({ id: 'noicon', displayName: 'Plain', icon: '   ' })]
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'noicon', speakerName: 'Plain' }),
        blankIcon,
        DEFAULT_ID,
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Plain', vendor: 'claude' })
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

describe('discussion-view — 异构圆桌 vendor 解析(2026-06-06-004)', () => {
  // A heterogeneous table: a Claude agent and an OpenCode agent sit together.
  const HETERO: AgentConfig[] = [
    agent({ id: 'claude-a', vendor: 'claude', displayName: 'Claude A', icon: '🤖' }),
    agent({ id: 'oc-a', vendor: 'opencode', displayName: 'OpenCode A', icon: '🦊' }),
  ]

  it('agent 命中 → speaker.vendor 取自 agent 配置(claude / opencode 各自归位)', () => {
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'claude-a', speakerName: 'Claude A' }),
        HETERO,
        'claude-a',
        T,
      ),
    ).toEqual({ icon: '🤖', name: 'Claude A', vendor: 'claude' })
    expect(
      resolveDiscussionSpeaker(
        msg({ speakerKind: 'agent', speakerAgentId: 'oc-a', speakerName: 'OpenCode A' }),
        HETERO,
        'claude-a',
        T,
      ),
    ).toEqual({ icon: '🦊', name: 'OpenCode A', vendor: 'opencode' })
  })

  it('agent 未命中 → 无 vendor(无法从配置推导,不臆测)', () => {
    const r = resolveDiscussionSpeaker(
      msg({ speakerKind: 'agent', speakerAgentId: 'ghost', speakerName: 'G' }),
      HETERO,
      'claude-a',
      T,
    )
    expect(r.vendor).toBeUndefined()
  })

  it('human / organizer 不带 vendor 徽章(只有 agent 发言标注厂商来源)', () => {
    expect(
      resolveDiscussionSpeaker(msg({ speakerKind: 'human' }), HETERO, 'claude-a', T).vendor,
    ).toBeUndefined()
    expect(
      resolveDiscussionSpeaker(msg({ speakerKind: 'organizer' }), HETERO, 'oc-a', T).vendor,
    ).toBeUndefined()
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
  it('全字段非空:goal/context/research/conclusion + details 顺序,Research label 走 i18n', () => {
    const tabs = discussionDetailTabs(
      disc({ goal: 'G', context: 'C', researchResult: 'R', conclusion: 'X' }),
      TABS_T,
    )
    expect(tabs.map((t) => t.kind)).toEqual([
      'goal',
      'context',
      'research',
      'conclusion',
      'details',
    ])
    expect(tabs.map((t) => t.label)).toEqual([
      'Goal',
      'Context',
      'Research',
      'Conclusion',
      'Details',
    ])
    expect(tabs[0].body).toBe('G')
    expect(tabs[2].body).toBe('R')
    expect(tabs.at(-1)?.body).toBeNull()
  })

  it('空 / 纯空白字段被剔除:仅保留非空字段 + details(research 空串 / 纯空白同样剔除)', () => {
    const empty = discussionDetailTabs(
      disc({ goal: 'G', context: '   ', researchResult: '', conclusion: null }),
      TABS_T,
    )
    expect(empty.map((t) => t.kind)).toEqual(['goal', 'details'])
    const blank = discussionDetailTabs(
      disc({ goal: 'G', context: 'C', researchResult: '   \n  ', conclusion: null }),
      TABS_T,
    )
    expect(blank.map((t) => t.kind)).toEqual(['goal', 'context', 'details'])
  })

  it('全空:仅剩 details 兜底 Tab(列表永不为空)', () => {
    const tabs = discussionDetailTabs(
      disc({ goal: '', context: '', researchResult: '', conclusion: null }),
      TABS_T,
    )
    expect(tabs.map((t) => t.kind)).toEqual(['details'])
    expect(tabs[0].body).toBeNull()
  })

  it('body 透传原文(不 trim,trim 仅用于空判定)', () => {
    const tabs = discussionDetailTabs(
      disc({
        goal: '  # 标题\n正文  ',
        context: '',
        researchResult: '  # 研究\n要点  ',
        conclusion: null,
      }),
      TABS_T,
    )
    expect(tabs[0].body).toBe('  # 标题\n正文  ')
    // research 排第二(goal 之后),body 仍是原文
    expect(tabs[1].body).toBe('  # 研究\n要点  ')
  })

  it('仅 researchResult 非空:出现 research + details 兜底', () => {
    const tabs = discussionDetailTabs(
      disc({ goal: '', context: '', researchResult: 'R', conclusion: null }),
      TABS_T,
    )
    expect(tabs.map((t) => t.kind)).toEqual(['research', 'details'])
    expect(tabs[0].label).toBe('Research')
    expect(tabs[0].body).toBe('R')
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

describe('discussion-view — research phase', () => {
  function rmsg(over: Partial<ResearchMessage> = {}): ResearchMessage {
    return { discussionId: 'd1', seq: 1, kind: 'text', content: '现状要点', createdAt: 0, ...over }
  }
  const labels = { researcher: '研究员', tool: (n: string) => `🔍 ${n}` }

  it('discussionPhase: research live → research,否则 discussion', () => {
    expect(discussionPhase(true)).toBe('research')
    expect(discussionPhase(false)).toBe('discussion')
  })

  it('showDiscussionStart: 仅 draft 且研究结束/死亡且讨论未启动时为 true', () => {
    // 研究进行中 → 不显示
    expect(showDiscussionStart('draft', true, false)).toBe(false)
    // 研究结束/死亡且讨论未启动 → 兜底显示
    expect(showDiscussionStart('draft', false, false)).toBe(true)
    // 讨论已启动 → 不显示
    expect(showDiscussionStart('draft', false, true)).toBe(false)
    // 非 draft 一律不显示
    expect(showDiscussionStart('in_progress', false, false)).toBe(false)
    expect(showDiscussionStart('completed', false, false)).toBe(false)
  })

  it('researchMessageToChat: text → 研究员 assistant 气泡', () => {
    const body = researchMessageToChat(rmsg({ kind: 'text', content: '现状要点' }), labels)
    expect(body).toMatchObject({ kind: 'assistant', text: '现状要点' })
    expect(body.kind === 'assistant' && body.speaker?.name).toBe('研究员')
  })

  it('researchMessageToChat: tool → system 行(经 labels.tool 格式化)', () => {
    const body = researchMessageToChat(rmsg({ kind: 'tool', content: 'Grep' }), labels)
    expect(body).toMatchObject({ kind: 'system', text: '🔍 Grep' })
  })

  it('reconcileResearchState: 快照置 running / 缺失则删 / 不动其他项目', () => {
    const prev = { d1: 'running' as const, other: 'running' as const }
    // d1 仍在快照 → 保留;d2 新增 → 置 running;d1 列表内但快照缺失会被删
    const next = reconcileResearchState(prev, [{ id: 'd1' }, { id: 'd2' }], { d2: 'running' })
    expect(next).toEqual({ d2: 'running', other: 'running' })
    expect(next).not.toBe(prev)
  })

  it('reconcileResearchState: 无快照时原样返回', () => {
    const prev = { d1: 'running' as const }
    expect(reconcileResearchState(prev, [{ id: 'd1' }], undefined)).toBe(prev)
  })
})
