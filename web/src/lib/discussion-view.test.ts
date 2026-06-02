import { describe, it, expect } from 'vitest'
import type { DiscussionMessage } from '@ccc/shared/protocol'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  panelToggleLabel,
  rowVisibility,
  statusLabel,
} from './discussion-view'

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
