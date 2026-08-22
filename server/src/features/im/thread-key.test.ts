/**
 * Conversation identity: thread key plus binding subject and scope_hash.
 */
import { describe, expect, it } from 'vitest'
import { conversationGateKey, conversationIdentityOf, threadKeyFor } from './thread-key.js'

describe('threadKeyFor', () => {
  it('prefers a native topic', () => {
    expect(threadKeyFor({ chatId: 'c1', threadId: 'tp1', rootId: 'r1' })).toBe('t:tp1')
  })

  it('falls back to the reply-chain root', () => {
    expect(threadKeyFor({ chatId: 'c1', rootId: 'r1' })).toBe('r:r1')
  })

  it('falls back to the chat itself', () => {
    expect(threadKeyFor({ chatId: 'c1' })).toBe('c:c1')
  })

  it('treats blank topic/root as absent', () => {
    expect(threadKeyFor({ chatId: 'c1', threadId: '   ', rootId: '' })).toBe('c:c1')
    expect(threadKeyFor({ chatId: 'c1', threadId: '', rootId: '  r2 ' })).toBe('r:r2')
  })

  it('prefixes so ids from different layers cannot collide', () => {
    const same = 'x'
    expect(
      new Set([
        threadKeyFor({ chatId: same }),
        threadKeyFor({ chatId: 'other', rootId: same }),
        threadKeyFor({ chatId: 'other', threadId: same }),
      ]).size,
    ).toBe(3)
  })

  it('is stable for the same message', () => {
    const m = { chatId: 'c1', threadId: 't1' }
    expect(threadKeyFor(m)).toBe(threadKeyFor(m))
  })
})

describe('conversationIdentityOf', () => {
  it('differs when only senderId differs', () => {
    const a = conversationIdentityOf('feishu', 'r1', 'c:oc', 'user-a', 'b1', 'local', 'h1')
    const b = conversationIdentityOf('feishu', 'r1', 'c:oc', 'user-b', 'b1', 'local', 'h1')
    expect(conversationGateKey(a)).not.toBe(conversationGateKey(b))
  })

  it('is stable for the same sender in the same thread', () => {
    const a = conversationIdentityOf('feishu', 'r1', 'c:oc', 'user-a', 'b1', 'local', 'h1')
    const b = conversationIdentityOf('feishu', 'r1', 'c:oc', 'user-a', 'b1', 'local', 'h1')
    expect(conversationGateKey(a)).toBe(conversationGateKey(b))
  })

  it('differs across thread, robot, or platform', () => {
    const base = conversationIdentityOf('feishu', 'r1', 'c:oc', 'u', 'b1', 'local', 'h1')
    expect(conversationGateKey(base)).not.toBe(
      conversationGateKey(
        conversationIdentityOf('feishu', 'r1', 'c:other', 'u', 'b1', 'local', 'h1'),
      ),
    )
    expect(conversationGateKey(base)).not.toBe(
      conversationGateKey(conversationIdentityOf('feishu', 'r2', 'c:oc', 'u', 'b1', 'local', 'h1')),
    )
  })
})
