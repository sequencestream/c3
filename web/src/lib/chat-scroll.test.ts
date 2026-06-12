import { describe, expect, it } from 'vitest'
import { chatScrollKey, isNearBottom } from './chat-scroll'
import type { ChatMsg } from './chat-types'

describe('chat-scroll', () => {
  it('treats the viewport as pinned when it is at or near the bottom', () => {
    expect(isNearBottom({ scrollTop: 776, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
    expect(isNearBottom({ scrollTop: 775, scrollHeight: 1000, clientHeight: 200 })).toBe(false)
  })

  it('treats short content as pinned', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 200 })).toBe(true)
  })

  it('changes the scroll key when the last rendered message text changes', () => {
    const messages: ChatMsg[] = [{ id: 1, kind: 'assistant', text: 'first' }]
    const before = chatScrollKey(messages)
    messages[0] = { id: 1, kind: 'assistant', text: 'first plus more' }
    expect(chatScrollKey(messages)).not.toBe(before)
  })
})
