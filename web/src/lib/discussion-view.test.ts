import { describe, it, expect } from 'vitest'
import type { DiscussionMessage } from '@ccc/shared/protocol'
import { discussionMessageToChat, discussionMessagesToChat } from './discussion-view'

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
