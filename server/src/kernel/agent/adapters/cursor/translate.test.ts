/**
 * Cursor stream normalization tests. The translator is pure and stateful per run,
 * so these drive it with fixture frames that mirror the SDK's `SDKMessage` shapes
 * and assert the canonical output.
 */
import { describe, it, expect } from 'vitest'
import type { CanonicalMessage } from '../types.js'
import { CursorStreamTranslator, type CursorEvent } from './translate.js'

/**
 * Run a frame sequence through a fresh translator, collecting emitted messages.
 * The trailing `flush` mirrors what the driver does when the stream ends, so
 * these assertions read the whole turn's output rather than a half-open span.
 */
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
  messages.push(...translator.flush().messages)
  return { messages, last, translator }
}

/** An assistant text delta, the SDK's only prose frame. */
function text(text: string, agentId = 'agent-1'): CursorEvent {
  return {
    type: 'assistant',
    agent_id: agentId,
    run_id: 'run-1',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

/** Every text block in emission order, as `[id, text]` pairs. */
function textBlocks(messages: CanonicalMessage[]): Array<[string | undefined, string]> {
  return messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'text')
    .map((b) => [b.id, b.type === 'text' ? b.text : ''])
}

describe('session id', () => {
  it('captures the agent id from the system frame and emits no message for it', () => {
    const { messages, translator } = translate([
      { type: 'system', subtype: 'init', agent_id: 'agent-1', run_id: 'run-1' },
    ])
    expect(translator.currentSessionId).toBe('agent-1')
    expect(messages).toHaveLength(0)
  })

  it('stamps the session id and vendor on every emitted message', () => {
    const { messages } = translate([
      { type: 'system', subtype: 'init', agent_id: 'agent-1', run_id: 'run-1' },
      text('hi'),
    ])
    expect(messages.at(-1)?.sessionId).toBe('agent-1')
    expect(messages.at(-1)?.vendor).toBe('cursor')
  })
})

describe('user echo', () => {
  it('does not re-emit the prompt c3 already knows it sent', () => {
    const { messages } = translate([
      {
        type: 'user',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] },
      },
    ])
    expect(messages).toHaveLength(0)
  })
})

describe('assistant text', () => {
  it('joins the token deltas of one span into a single block', () => {
    const { messages } = translate([text('Hello, '), text('world')])
    expect(textBlocks(messages)).toEqual([['assistant-0', 'Hello, world']])
  })

  it('emits nothing while the span is still open, so a reply is never split', () => {
    const translator = new CursorStreamTranslator()
    // Every consumer downstream reads one emitted text as one whole message, so
    // a mid-span emission would render each token as its own transcript entry.
    expect(translator.consume(text('Hel')).messages).toHaveLength(0)
    expect(translator.consume(text('lo')).messages).toHaveLength(0)
    expect(textBlocks(translator.flush().messages)).toEqual([['assistant-0', 'Hello']])
  })

  it('emits the open span on the terminal status frame', () => {
    const { messages } = translate([
      text('done'),
      { type: 'status', agent_id: 'agent-1', run_id: 'run-1', status: 'FINISHED' },
    ])
    // Emitted by the status frame itself — the helper's trailing flush finds
    // nothing left, so the block appears exactly once.
    expect(textBlocks(messages)).toEqual([['assistant-0', 'done']])
  })

  it('starts a new span after a tool call, so text is never retro-appended', () => {
    const { messages } = translate([
      text('before'),
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'c1',
        name: 'read',
        status: 'running',
        args: { path: '/a' },
      },
      text('after'),
    ])
    expect(textBlocks(messages)).toEqual([
      ['assistant-0', 'before'],
      ['assistant-1', 'after'],
    ])
  })

  it('ignores an empty delta', () => {
    const { messages } = translate([text('')])
    expect(messages).toHaveLength(0)
  })
})

describe('thinking', () => {
  it('joins reasoning deltas into one block', () => {
    const think = (t: string): CursorEvent => ({
      type: 'thinking',
      agent_id: 'agent-1',
      run_id: 'run-1',
      text: t,
    })
    const { messages } = translate([think('step '), think('two')])
    const blocks = messages.flatMap((m) => m.blocks).filter((b) => b.type === 'thinking')
    expect(blocks.map((b) => (b.type === 'thinking' ? b.thinking : ''))).toEqual(['step two'])
  })

  it('closes the span on the empty completion frame and opens a new one after', () => {
    const think = (t: string): CursorEvent => ({
      type: 'thinking',
      agent_id: 'agent-1',
      run_id: 'run-1',
      text: t,
    })
    const { messages } = translate([
      think('first'),
      {
        type: 'thinking',
        agent_id: 'agent-1',
        run_id: 'run-1',
        text: '',
        thinking_duration_ms: 12,
      },
      think('second'),
    ])
    const ids = messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'thinking')
      .map((b) => b.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('never infers reasoning from ordinary assistant text', () => {
    const { messages } = translate([text('I am thinking about this')])
    expect(messages.flatMap((m) => m.blocks).some((b) => b.type === 'thinking')).toBe(false)
  })
})

describe('tool calls', () => {
  const started: CursorEvent = {
    type: 'tool_call',
    agent_id: 'agent-1',
    run_id: 'run-1',
    call_id: 'c1',
    name: 'shell',
    status: 'running',
    args: { command: 'ls' },
  }

  it('opens a tool_use block carrying the native args and neutral category', () => {
    const { messages } = translate([started])
    const block = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(block).toMatchObject({ id: 'c1', name: 'shell', input: { command: 'ls' } })
    expect(block?.vendorExtra?.category).toBe('execute')
    expect(messages.at(-1)?.preApproved).toBe(true)
  })

  it('back-fills the result onto the same block by call_id, not by arrival order', () => {
    const { messages } = translate([
      started,
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'c2',
        name: 'read',
        status: 'running',
        args: { path: '/a' },
      },
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'c1',
        name: 'shell',
        status: 'completed',
        result: { success: { stdout: 'a\nb' } },
      },
    ])
    const completed = messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool_use' && b.result !== undefined)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      id: 'c1',
      // The opening call's args survive a completion frame that omits them.
      input: { command: 'ls' },
      result: { content: 'a\nb', isError: false },
    })
  })

  it('marks an error status as a failed result even with no payload', () => {
    const { messages } = translate([
      started,
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'c1',
        name: 'shell',
        status: 'error',
      },
    ])
    const block = messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool_use')
      .at(-1)
    expect(block?.result?.isError).toBe(true)
  })

  it('flags a completion for a call it never saw opened, rather than guessing', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'orphan',
        name: 'read',
        status: 'completed',
        result: { success: { content: 'x' } },
      },
    ])
    const block = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(block?.vendorExtra?.orphanCompletion).toBe(true)
  })

  it('synthesizes a deterministic id when the frame carries none', () => {
    const { messages } = translate([
      { type: 'tool_call', agent_id: 'agent-1', run_id: 'run-1', name: 'read', status: 'running' },
    ])
    const block = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(block?.id).toBe('tool-synth-0')
    expect(block?.vendorExtra?.idSource).toBe('synthesized-deterministic')
  })

  it('keeps an unlisted tool uncategorized so the risk layer fails closed', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'c9',
        name: 'mysteryTool',
        status: 'running',
      },
    ])
    const block = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(block?.vendorExtra?.category).toBe('unknown')
  })
})

describe('terminal status', () => {
  it('ends the turn cleanly on FINISHED', () => {
    const { last } = translate([
      { type: 'status', agent_id: 'agent-1', run_id: 'run-1', status: 'FINISHED' },
    ])
    expect(last.ended).toEqual({ isError: false })
  })

  it('ends the turn as an error on ERROR, carrying the reported message', () => {
    const { last } = translate([
      {
        type: 'status',
        agent_id: 'agent-1',
        run_id: 'run-1',
        status: 'ERROR',
        message: 'Invalid User API Key',
      },
    ])
    expect(last.ended).toEqual({ isError: true, errorMessage: 'Invalid User API Key' })
  })

  it('treats a running status as progress, not an ending', () => {
    const { last } = translate([
      { type: 'status', agent_id: 'agent-1', run_id: 'run-1', status: 'RUNNING' },
    ])
    expect(last.ended).toBeUndefined()
  })
})

describe('result frame', () => {
  it('reads the run identity from session_id as well as agent_id', () => {
    const { messages } = translate([
      { type: 'system', subtype: 'init', session_id: 'chat-9' },
      {
        type: 'assistant',
        session_id: 'chat-9',
        message: { content: [{ type: 'text', text: 'x' }] },
      },
    ])
    expect(messages.every((m) => m.sessionId === 'chat-9')).toBe(true)
  })

  it('ends the turn cleanly and emits the open span', () => {
    // The turn's last paragraph is still accumulating when the outcome arrives;
    // it has to reach the transcript rather than die with the span.
    const { messages, last } = translate([
      text('all done'),
      { type: 'result', subtype: 'success', is_error: false, session_id: 'agent-1' },
    ])
    expect(last.ended).toEqual({ isError: false })
    expect(textBlocks(messages).map(([, t]) => t)).toEqual(['all done'])
  })

  it('ends the turn as an error when is_error is set, carrying the reported message', () => {
    const { last } = translate([
      { type: 'result', subtype: 'error_during_execution', is_error: true, message: 'boom' },
    ])
    expect(last.ended).toEqual({ isError: true, errorMessage: 'boom' })
  })

  it('treats an unrecognized outcome as a failure rather than a silent success', () => {
    const { last } = translate([{ type: 'result', subtype: 'something_new' }])
    expect(last.ended?.isError).toBe(true)
  })
})

describe('discriminated tool_call payloads', () => {
  it('takes the tool name from the union arm and strips the wrapper suffix', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        session_id: 'agent-1',
        tool_call: { shellToolCall: { args: { command: 'ls' } } },
      },
    ])
    const block = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(block).toMatchObject({ name: 'shell', input: { command: 'ls' } })
    // `shell` is in the neutral table, so the risk layer gets a real category.
    expect(block?.vendorExtra?.category).toBe('execute')
  })

  it('back-fills the result from the completed arm onto the same block', () => {
    const { messages } = translate([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        tool_call: { editToolCall: { args: { path: '/f' } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-1',
        tool_call: {
          editToolCall: { args: { path: '/f' }, result: { success: { linesAdded: 1 } } },
        },
      },
    ])
    const blocks = messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use')
    // Same id twice: the accumulator upserts, so the second carries the result.
    expect(blocks.map((b) => b.id)).toEqual(['call-1', 'call-1'])
    expect(blocks[1]).toMatchObject({ name: 'edit', result: { isError: false } })
  })
})

describe('unmodelled frames', () => {
  it('preserves runtime bookkeeping without inventing transcript content', () => {
    const { messages } = translate([
      { type: 'usage', agent_id: 'agent-1', run_id: 'run-1', usage: { inputTokens: 5 } },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.blocks).toHaveLength(0)
    expect(messages[0]?.vendorExtra?.native).toMatchObject({ type: 'usage' })
  })

  it('preserves an unknown frame type verbatim', () => {
    const { messages } = translate([{ type: 'something-new', agent_id: 'agent-1' }])
    expect(messages[0]?.blocks).toHaveLength(0)
    expect(messages[0]?.vendorExtra?.unhandled).toMatchObject({ reason: 'unknown-type' })
  })
})
