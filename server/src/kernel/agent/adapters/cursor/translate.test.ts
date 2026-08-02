/**
 * Cursor stream normalization tests. The translator is pure and stateful per run,
 * so these drive it with fixture frames that mirror the CLI's real NDJSON shapes
 * (captured by scripts/e2e/cursor-cli-probe.mjs) and assert the canonical output.
 */
import { describe, it, expect } from 'vitest'
import type { CanonicalMessage } from '../types.js'
import { CursorStreamTranslator, type CursorEvent } from './translate.js'

/** Run a frame sequence through a fresh translator, collecting emitted messages. */
function translate(events: CursorEvent[]): {
  messages: CanonicalMessage[]
  last: ReturnType<CursorStreamTranslator['consume']>
  translator: CursorStreamTranslator
} {
  const translator = new CursorStreamTranslator()
  const messages: CanonicalMessage[] = []
  let last = { messages: [] } as ReturnType<CursorStreamTranslator['consume']>
  for (const event of events) {
    last = translator.consume(event)
    messages.push(...last.messages)
  }
  return { messages, last, translator }
}

describe('session id', () => {
  it('captures the session_id from system/init and emits no message for it', () => {
    const { messages, translator } = translate([
      { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'Auto' },
    ])
    expect(translator.currentSessionId).toBe('sid-1')
    expect(messages).toHaveLength(0)
  })

  it('stamps the session id on every emitted message', () => {
    const { messages } = translate([
      { type: 'system', subtype: 'init', session_id: 'sid-1' },
      {
        type: 'assistant',
        session_id: 'sid-1',
        model_call_id: 'm1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ])
    expect(messages.at(-1)?.sessionId).toBe('sid-1')
    expect(messages.at(-1)?.vendor).toBe('cursor')
  })
})

describe('user echo', () => {
  it('does not re-emit the prompt c3 already knows it sent', () => {
    const { messages } = translate([
      {
        type: 'user',
        session_id: 's',
        message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] },
      },
    ])
    expect(messages).toHaveLength(0)
  })
})

describe('assistant text', () => {
  it('keys a text block by model_call_id and emits it whole', () => {
    const { messages } = translate([
      {
        type: 'assistant',
        session_id: 's',
        model_call_id: 'm1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    ])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'hello', id: 'm1' }])
  })

  it('accumulates text cumulatively across frames of the same model call', () => {
    const { messages } = translate([
      {
        type: 'assistant',
        session_id: 's',
        model_call_id: 'm1',
        message: { content: [{ text: 'foo' }] },
      },
      {
        type: 'assistant',
        session_id: 's',
        model_call_id: 'm1',
        message: { content: [{ text: 'bar' }] },
      },
    ])
    // Each emit is the full span so far — the wire consumer slices the suffix.
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'foo', id: 'm1' }])
    expect(messages[1].blocks).toEqual([{ type: 'text', text: 'foobar', id: 'm1' }])
  })

  it('gives anonymous frames a deterministic ordinal id and marks the source', () => {
    const { messages } = translate([
      { type: 'assistant', session_id: 's', message: { content: [{ text: 'a' }] } },
      { type: 'assistant', session_id: 's', message: { content: [{ text: 'b' }] } },
    ])
    expect(messages[0].blocks[0]).toMatchObject({ id: 'assistant-0' })
    expect(messages[0].blocks[0].vendorExtra).toMatchObject({ idSource: 'synthesized-ordinal' })
    // A second anonymous frame must not merge into the first.
    expect(messages[1].blocks[0]).toMatchObject({ id: 'assistant-1', text: 'b' })
  })

  it('does not fabricate a thinking block from plain text', () => {
    const { messages } = translate([
      {
        type: 'assistant',
        session_id: 's',
        model_call_id: 'm1',
        message: { content: [{ text: 'I am thinking about it' }] },
      },
    ])
    expect(messages[0].blocks.every((b) => b.type === 'text')).toBe(true)
  })
})

describe('thinking', () => {
  it('joins deltas into one thinking block, re-emitted cumulatively', () => {
    const { messages } = translate([
      { type: 'thinking', subtype: 'delta', session_id: 's', text: 'let ' },
      { type: 'thinking', subtype: 'delta', session_id: 's', text: 'me see' },
      { type: 'thinking', subtype: 'completed', session_id: 's' },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0].blocks).toEqual([{ type: 'thinking', thinking: 'let ', id: 'thinking-0' }])
    expect(messages[1].blocks).toEqual([
      { type: 'thinking', thinking: 'let me see', id: 'thinking-0' },
    ])
  })

  it('starts a fresh span after a completion', () => {
    const { messages } = translate([
      { type: 'thinking', subtype: 'delta', session_id: 's', text: 'first' },
      { type: 'thinking', subtype: 'completed', session_id: 's' },
      { type: 'thinking', subtype: 'delta', session_id: 's', text: 'second' },
    ])
    expect(messages[0].blocks[0].id).toBe('thinking-0')
    expect(messages.at(-1)?.blocks[0]).toMatchObject({ id: 'thinking-1', thinking: 'second' })
  })
})

describe('tool calls', () => {
  it('names a tool from its wrapper key and carries the native args', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        session_id: 's',
        call_id: 'call-1',
        tool_call: { readToolCall: { args: { path: '/a/b.txt' }, toolCallId: 'call-1' } },
      },
    ])
    expect(messages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call-1',
      name: 'read',
      input: { path: '/a/b.txt' },
    })
    expect(messages[0].blocks[0].vendorExtra).toMatchObject({
      wrapperKey: 'readToolCall',
      category: 'read',
    })
    expect(messages[0].preApproved).toBe(true)
  })

  it('survives a call_id containing a newline', () => {
    const id = 'call-abc-0\nfc_def-0_0'
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        session_id: 's',
        call_id: id,
        tool_call: { shellToolCall: { args: { command: 'ls' }, toolCallId: id } },
      },
    ])
    expect(messages[0].blocks[0]).toMatchObject({ id, name: 'shell', input: { command: 'ls' } })
  })

  it('back-fills the result onto the same block by id', () => {
    const id = 'call-2'
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        session_id: 's',
        call_id: id,
        tool_call: { readToolCall: { args: { path: '/x' }, toolCallId: id } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        session_id: 's',
        call_id: id,
        tool_call: {
          readToolCall: {
            args: { path: '/x' },
            result: { success: { content: 'data\n' } },
            toolCallId: id,
          },
        },
      },
    ])
    const first = messages[0].blocks[0]
    const second = messages[1].blocks[0]
    expect(first).not.toHaveProperty('result')
    expect(second).toMatchObject({
      type: 'tool_use',
      id,
      name: 'read',
      result: { content: 'data\n', isError: false },
    })
    expect(
      (second as { result?: { vendorExtra?: Record<string, unknown> } }).result?.vendorExtra,
    ).toMatchObject({
      native: { content: 'data\n' },
    })
  })

  it('reports an errored tool result as isError', () => {
    const id = 'call-3'
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'completed',
        session_id: 's',
        call_id: id,
        tool_call: {
          shellToolCall: {
            args: { command: 'false' },
            result: { error: { message: 'boom' } },
            toolCallId: id,
          },
        },
      },
    ])
    expect(messages[0].blocks[0]).toMatchObject({ result: { content: 'boom', isError: true } })
  })

  it('flags a completion for an unopened call rather than mis-binding it', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'completed',
        session_id: 's',
        call_id: 'never-opened',
        tool_call: {
          editToolCall: {
            args: { path: '/y' },
            result: { success: {} },
            toolCallId: 'never-opened',
          },
        },
      },
    ])
    expect(messages[0].blocks[0]).toMatchObject({ id: 'never-opened', name: 'edit' })
    expect(messages[0].blocks[0].vendorExtra).toMatchObject({ orphanCompletion: true })
  })

  it('synthesizes a deterministic id when none is present', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        session_id: 's',
        tool_call: { grepToolCall: { args: { pattern: 'foo' } } },
      },
    ])
    const block = messages[0].blocks[0]
    expect(block.id).toBe('grepToolCall-synth-0')
    expect(block.vendorExtra).toMatchObject({ idSource: 'synthesized-deterministic' })
  })

  it('marks an unknown tool kind as unknown, not a guessed category', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        session_id: 's',
        call_id: 'k1',
        tool_call: { brandNewToolCall: { args: {}, toolCallId: 'k1' } },
      },
    ])
    expect(messages[0].blocks[0].vendorExtra).toMatchObject({
      wrapperKey: 'brandNewToolCall',
      category: 'unknown',
    })
  })
})

describe('turn termination and unknown frames', () => {
  it('reports a successful result as a clean end', () => {
    const { last } = translate([
      { type: 'result', subtype: 'success', session_id: 's', is_error: false, result: 'done' },
    ])
    expect(last.ended).toEqual({ isError: false })
  })

  it('reports an error result with a message', () => {
    const { last } = translate([
      { type: 'result', subtype: 'error', session_id: 's', is_error: true, result: 'rate limited' },
    ])
    expect(last.ended).toMatchObject({ isError: true, errorMessage: 'rate limited' })
  })

  it('preserves an unknown frame in vendorExtra without inventing content', () => {
    const { messages } = translate([{ type: 'mystery', session_id: 's', whatever: 1 }])
    expect(messages[0].blocks).toHaveLength(0)
    expect(messages[0].vendorExtra).toMatchObject({ unhandled: { reason: 'unknown-type' } })
  })
})
