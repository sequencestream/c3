/**
 * Thread identity decides which messages share an agent session — and therefore
 * a context. The precedence is the whole rule, so it is pinned here directly.
 */
import { describe, expect, it } from 'vitest'
import { threadKeyFor } from './thread-key.js'

describe('threadKeyFor', () => {
  it('prefers the platform topic when the message is in one', () => {
    expect(threadKeyFor({ chatId: 'c1', threadId: 'tp1', rootId: 'r1' })).toBe('t:tp1')
  })

  it('falls back to the reply-chain root, so a reply continues what it replies to', () => {
    expect(threadKeyFor({ chatId: 'c1', rootId: 'r1' })).toBe('r:r1')
  })

  it('falls back to the chat — one chat is one long conversation', () => {
    expect(threadKeyFor({ chatId: 'c1' })).toBe('c:c1')
  })

  it('treats blank ids as absent rather than as a distinct thread', () => {
    expect(threadKeyFor({ chatId: 'c1', threadId: '   ', rootId: '' })).toBe('c:c1')
    expect(threadKeyFor({ chatId: 'c1', threadId: '', rootId: '  r2 ' })).toBe('r:r2')
  })

  it('keeps the three sources in separate namespaces', () => {
    // Without the prefixes, a chat id equal to some other chat's topic id would
    // silently merge two conversations.
    const same = 'x1'
    const keys = new Set([
      threadKeyFor({ chatId: same }),
      threadKeyFor({ chatId: 'other', rootId: same }),
      threadKeyFor({ chatId: 'other', threadId: same }),
    ])
    expect(keys.size).toBe(3)
  })

  it('is stable for the same message', () => {
    const m = { chatId: 'c1', threadId: 'tp1' }
    expect(threadKeyFor(m)).toBe(threadKeyFor(m))
  })
})
