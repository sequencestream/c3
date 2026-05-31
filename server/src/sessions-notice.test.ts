/**
 * `flattenMessages` empty-turn notice behaviour. The on-disk transcript splits
 * one model turn into several single-block messages (a `thinking` message, a
 * `text` message, a `tool_use` message…), so the notice MUST be decided per turn,
 * not per message: a lone `thinking` message is usually just the lead-in to a
 * turn that continues with text/tools. A turn earns a `notice` only when it
 * thought but produced no assistant text and no tool call across the whole turn.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_TURN_NOTICE } from '@ccc/shared/protocol'
import { flattenMessages } from './sessions.js'

const userPrompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const asst = (...blocks: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
})
const thinking = { type: 'thinking', thinking: '', signature: 'sig' }
const text = (t: string) => ({ type: 'text', text: t })
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name, input: { x: 1 } })
const toolResult = (id: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

describe('flattenMessages empty-turn notice', () => {
  it('adds a notice for a genuinely empty turn (thinking only, then a new prompt)', () => {
    const out = flattenMessages([userPrompt('hi'), asst(thinking), userPrompt('continue')])
    expect(out).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'notice', text: EMPTY_TURN_NOTICE },
      { kind: 'user', text: 'continue' },
    ])
  })

  it('adds a notice for an empty turn at end of transcript (EOF boundary)', () => {
    const out = flattenMessages([userPrompt('hi'), asst(thinking)])
    expect(out).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'notice', text: EMPTY_TURN_NOTICE },
    ])
  })

  it('does NOT add a notice when a thinking message is followed by a text message (same turn)', () => {
    // The real split-transcript shape: thinking and text arrive as separate messages.
    const out = flattenMessages([userPrompt('hi'), asst(thinking), asst(text('done'))])
    expect(out).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'done' },
    ])
  })

  it('does NOT add a notice for a tool-using turn (thinking → tool_use → result → text)', () => {
    const out = flattenMessages([
      userPrompt('hi'),
      asst(thinking),
      asst(toolUse('t1', 'Read')),
      toolResult('t1'),
      asst(text('done')),
    ])
    expect(out.some((it) => it.kind === 'notice')).toBe(false)
    expect(out.filter((it) => it.kind === 'tool_use')).toHaveLength(1)
  })

  it('does NOT add a notice for a tool-only turn that ends after thinking (no final text)', () => {
    // Tool work is visible output — "no response" would be misleading here.
    const out = flattenMessages([
      userPrompt('hi'),
      asst(thinking),
      asst(toolUse('t1', 'Bash')),
      toolResult('t1'),
      asst(thinking),
      userPrompt('next'),
    ])
    expect(out.some((it) => it.kind === 'notice')).toBe(false)
  })
})
