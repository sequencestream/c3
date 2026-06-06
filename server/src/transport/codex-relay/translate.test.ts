/**
 * Translation-core tests for the codex relay (ADR-0014). Two halves:
 *  - request: a REAL captured codex 0.137 Responses body
 *    (`__fixtures__/responses-request.real.json`) folds into a valid Chat request;
 *  - response: synthetic DeepSeek-style Chat SSE chunks fold into the Responses
 *    events codex's parser consumes (text / tool-call / reasoning / usage / error),
 *    asserting the contract pinned from `codex-rs/.../sse/responses.rs`:
 *    output items arrive as full `ResponseItem`s in `output_item.done` and the
 *    stream always ends with `response.completed` (id required, usage optional).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  responsesRequestToChat,
  ChatToResponsesConverter,
  SseChunkParser,
  serializeSse,
  type ChatStreamChunk,
} from './translate.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('responsesRequestToChat', () => {
  it('folds the real captured codex request into a valid Chat request', () => {
    const raw = JSON.parse(
      readFileSync(join(here, '__fixtures__/responses-request.real.json'), 'utf-8'),
    )
    const body = JSON.parse(raw.body)
    const chat = responsesRequestToChat(body)

    expect(chat.model).toBe('deepseek-chat')
    expect(chat.stream).toBe(true)
    expect(chat.stream_options).toEqual({ include_usage: true })

    // instructions → leading system message; developer item also folds to system.
    expect(chat.messages[0].role).toBe('system')
    expect(chat.messages[0].content).toBe(body.instructions)
    expect(chat.messages[1].role).toBe('system') // the `developer` item
    // the trailing user prompt survives.
    const lastUser = chat.messages[chat.messages.length - 1]
    expect(lastUser.role).toBe('user')
    expect(lastUser.content).toContain('say hi in one word')

    // every tool is a Chat function tool (namespaces flattened away).
    expect(chat.tools && chat.tools.length).toBeGreaterThan(0)
    for (const t of chat.tools!) {
      expect(t.type).toBe('function')
      expect(typeof t.function.name).toBe('string')
    }
    // the `multi_agent_v1` namespace's children are flattened in by bare name.
    const names = chat.tools!.map((t) => t.function.name)
    expect(names).toContain('exec_command')
    expect(names).toContain('close_agent')
    expect(names).not.toContain('multi_agent_v1')
    expect(chat.tool_choice).toBe('auto')
    expect(chat.parallel_tool_calls).toBe(false)
  })

  it('maps function_call + function_call_output into assistant/tool turns', () => {
    const chat = responsesRequestToChat({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
        { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' },
        { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
      ],
    })
    expect(chat.messages).toEqual([
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
    ])
  })

  it('merges adjacent parallel function_call items into one assistant turn', () => {
    const chat = responsesRequestToChat({
      input: [
        { type: 'function_call', name: 'a', arguments: '{}', call_id: 'c1' },
        { type: 'function_call', name: 'b', arguments: '{}', call_id: 'c2' },
      ],
    })
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0].tool_calls).toHaveLength(2)
    expect(chat.messages[0].tool_calls!.map((t) => t.id)).toEqual(['c1', 'c2'])
  })
})

/** Drive a converter through a list of chunks and collect every emitted event. */
function runStream(chunks: ChatStreamChunk[]): Array<{ type: string } & Record<string, unknown>> {
  const conv = new ChatToResponsesConverter()
  const events = [...conv.start()]
  for (const c of chunks) events.push(...conv.consume(c))
  events.push(...conv.done())
  return events
}

describe('ChatToResponsesConverter', () => {
  it('translates a text stream into deltas + message item + completed', () => {
    const events = runStream([
      { id: 'chatcmpl-1', choices: [{ delta: { content: 'Hel' } }] },
      { id: 'chatcmpl-1', choices: [{ delta: { content: 'lo' } }] },
      { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        id: 'chatcmpl-1',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ])
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('response.created')
    expect(types).toContain('response.output_text.delta')

    const done = events.find((e) => e.type === 'response.output_item.done')!
    expect(done.item).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello' }],
    })

    const completed = events.at(-1)!
    expect(completed.type).toBe('response.completed')
    expect((completed.response as { id: string }).id).toBe('chatcmpl-1')
    expect((completed.response as { usage: unknown }).usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
  })

  it('translates a streamed tool call into a function_call item', () => {
    const events = runStream([
      {
        id: 'c2',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  function: { name: 'exec_command', arguments: '{"cmd":' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'c2',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
      },
      { id: 'c2', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const done = events.filter((e) => e.type === 'response.output_item.done')
    expect(done).toHaveLength(1)
    expect(done[0].item).toEqual({
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"ls"}',
      call_id: 'call_a',
    })
    // no assistant message item for a pure tool-call turn.
    expect((done[0].item as { type: string }).type).toBe('function_call')
    expect(events.at(-1)!.type).toBe('response.completed')
  })

  it('handles parallel tool calls in call order', () => {
    const events = runStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c_a', function: { name: 'a', arguments: '{}' } },
                { index: 1, id: 'c_b', function: { name: 'b', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const done = events.filter((e) => e.type === 'response.output_item.done')
    expect(done.map((e) => (e.item as { name: string }).name)).toEqual(['a', 'b'])
  })

  it('streams reasoning_content as reasoning_text deltas', () => {
    const events = runStream([
      { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ])
    expect(events.some((e) => e.type === 'response.reasoning_text.delta')).toBe(true)
  })

  it('always ends with completed even with no content', () => {
    const events = runStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
    expect(events.at(-1)!.type).toBe('response.completed')
    expect((events.at(-1)!.response as { usage: unknown }).usage).toBeNull()
  })

  it('fail() emits response.failed once', () => {
    const conv = new ChatToResponsesConverter()
    const e1 = conv.fail('boom')
    expect(e1).toHaveLength(1)
    expect(e1[0].type).toBe('response.failed')
    expect(conv.fail('again')).toHaveLength(0) // idempotent
  })
})

describe('SSE framing', () => {
  it('serializes an event with both event: and data: lines', () => {
    const s = serializeSse({ type: 'response.created', response: {} })
    expect(s).toBe('event: response.created\ndata: {"type":"response.created","response":{}}\n\n')
  })

  it('parses data lines and skips [DONE] / blanks across chunk splits', () => {
    const p = new SseChunkParser()
    expect(p.push('data: {"a":1}\n\ndata: {"b')).toEqual(['{"a":1}'])
    expect(p.push('":2}\n')).toEqual(['{"b":2}'])
    expect(p.push('data: [DONE]\n\n')).toEqual([])
  })
})
