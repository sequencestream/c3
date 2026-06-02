import { describe, it, expect } from 'vitest'
import type { Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import {
  agendaProgressView,
  autoGrowHeight,
  discussionMessageToChat,
  discussionMessagesToChat,
  panelToggleLabel,
  rowVisibility,
  statusLabel,
} from './discussion-view'

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

describe('discussion-view — DiscussionMessage → ChatBody', () => {
  it('human → user 气泡,正文不加前缀', () => {
    const b = discussionMessageToChat(msg({ speakerKind: 'human', content: 'hi' }))
    expect(b).toEqual({ kind: 'user', text: 'hi' })
  })

  it('agent → assistant 气泡,带 speakerName 前缀', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerName: 'Reviewer', content: 'lgtm' }),
    )
    expect(b).toEqual({ kind: 'assistant', text: 'Reviewer: lgtm' })
  })

  it('organizer → assistant 气泡', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'organizer', speakerName: 'Org', content: 'go' }),
    )
    expect(b).toEqual({ kind: 'assistant', text: 'Org: go' })
  })

  it('无 speakerName 时不加前缀', () => {
    const b = discussionMessageToChat(
      msg({ speakerKind: 'agent', speakerName: null, content: 'x' }),
    )
    expect(b).toEqual({ kind: 'assistant', text: 'x' })
  })

  it('批量映射保持顺序', () => {
    const out = discussionMessagesToChat([
      msg({ seq: 1, speakerKind: 'human', content: 'q' }),
      msg({ seq: 2, speakerKind: 'agent', speakerName: 'A', content: 'a' }),
    ])
    expect(out).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'A: a' },
    ])
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
})

describe('discussion-view — autoGrowHeight(textarea 自动拉伸)', () => {
  it('内容低于上限:高度跟随内容,内部不滚动', () => {
    expect(autoGrowHeight(80, 200)).toEqual({ height: 80, overflowY: 'hidden' })
  })

  it('内容恰好等于上限:不视为溢出,仍不滚动', () => {
    expect(autoGrowHeight(200, 200)).toEqual({ height: 200, overflowY: 'hidden' })
  })

  it('内容超过上限:高度封顶到上限并出现内部滚动条', () => {
    expect(autoGrowHeight(360, 200)).toEqual({ height: 200, overflowY: 'auto' })
  })

  it('空内容:高度收缩到 scrollHeight(复位场景)', () => {
    expect(autoGrowHeight(0, 200)).toEqual({ height: 0, overflowY: 'hidden' })
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
