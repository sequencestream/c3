/**
 * Dialect routing and stream reading.
 *
 * Two properties matter here and nothing else does. First, a run must dial exactly
 * the endpoint an agent would: a `responses` provider measured over Chat
 * Completions describes a code path nobody uses. Second, only VISIBLE TEXT may
 * start the TTFT clock and only a real terminator may end a stream — otherwise a
 * heartbeat makes a slow endpoint look instant, and a truncated stream is recorded
 * as a success.
 */
import { describe, expect, it } from 'vitest'
import { SPEED_TEST_MAX_OUTPUT_TOKENS, SPEED_TEST_PROMPT } from '@ccc/shared/protocol'
import { apiDialectFor, buildRequest, createStreamReader } from './dialects.js'
import { SseDataReader } from './sse.js'

describe('apiDialectFor', () => {
  it('routes the anthropic slot to Messages, ignoring the OpenAI-only wireApi', () => {
    expect(apiDialectFor({ wireApi: 'responses' }, 'anthropic')).toBe('messages')
    expect(apiDialectFor({ wireApi: 'chat' }, 'anthropic')).toBe('messages')
    expect(apiDialectFor({}, 'anthropic')).toBe('messages')
  })

  it('honours the saved wireApi on the openai slot, defaulting to Chat', () => {
    expect(apiDialectFor({ wireApi: 'responses' }, 'openai')).toBe('responses')
    expect(apiDialectFor({ wireApi: 'chat' }, 'openai')).toBe('chat')
    expect(apiDialectFor({}, 'openai')).toBe('chat')
  })
})

describe('buildRequest', () => {
  it('sends the calibrated Chat body and asks for terminal usage', () => {
    const r = buildRequest('chat', 'https://api.example.com/v1', 'sk-key', 'gpt-x')
    expect(r.url).toBe('https://api.example.com/v1/chat/completions')
    expect(r.headers.authorization).toBe('Bearer sk-key')
    const body = JSON.parse(r.body)
    expect(body).toMatchObject({
      model: 'gpt-x',
      stream: true,
      temperature: 0,
      max_tokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: SPEED_TEST_PROMPT }],
    })
    // No history, tools, system prompt or reasoning configuration may creep in:
    // a varying request shape makes two runs incomparable.
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'stream_options',
      'temperature',
    ])
  })

  it('sends the Responses body with max_output_tokens and store:false', () => {
    const r = buildRequest('responses', 'https://api.example.com/v1', 'sk-key', 'gpt-x')
    expect(r.url).toBe('https://api.example.com/v1/responses')
    const body = JSON.parse(r.body)
    expect(body).toMatchObject({
      max_output_tokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
      store: false,
      input: [{ role: 'user', content: SPEED_TEST_PROMPT }],
    })
    expect(body.stream_options).toBeUndefined()
    expect(body.previous_response_id).toBeUndefined()
  })

  it('uses x-api-key and the pinned anthropic-version for Messages', () => {
    const r = buildRequest('messages', 'https://api.example.com/anthropic', 'sk-key', 'claude-x')
    expect(r.url).toBe('https://api.example.com/anthropic/v1/messages')
    expect(r.headers['x-api-key']).toBe('sk-key')
    expect(r.headers['anthropic-version']).toBe('2023-06-01')
    expect(r.headers.authorization).toBeUndefined()
  })

  it('resolves Responses URLs without inventing a version segment', () => {
    const at = (base: string) => buildRequest('responses', base, 'k', 'm').url
    expect(at('https://h/v1/')).toBe('https://h/v1/responses')
    expect(at('https://h/v1/responses')).toBe('https://h/v1/responses')
    expect(at('https://h/api')).toBe('https://h/api/responses')
  })
})

/** Feed a scripted SSE body through the reader and report what it concluded. */
function readStream(
  dialect: 'chat' | 'responses' | 'messages',
  chunks: string[],
): { texts: number; ended: boolean; errored: boolean; usage: number | null; deltas: number } {
  const reader = createStreamReader(dialect)
  const sse = new SseDataReader()
  let texts = 0
  let ended = false
  let errored = false
  let usage: number | null = null
  outer: for (const chunk of chunks) {
    for (const data of sse.push(chunk)) {
      const signal = reader.push(data)
      if (signal.kind === 'text') texts++
      else if (signal.kind === 'end') {
        ended = true
        usage = signal.usageTokens
        break outer
      } else if (signal.kind === 'error') {
        errored = true
        break outer
      }
    }
  }
  return { texts, ended, errored, usage, deltas: reader.deltaCount }
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

describe('Chat Completions stream', () => {
  it('counts only non-empty content deltas and closes on [DONE] after usage', () => {
    const r = readStream('chat', [
      sse({ choices: [{ delta: { role: 'assistant' } }] }),
      sse({ choices: [{ delta: { content: '' } }] }),
      sse({ choices: [{ delta: { content: '1,' } }] }),
      sse({ choices: [{ delta: { content: '2,' } }] }),
      sse({ choices: [], usage: { completion_tokens: 7 } }),
      'data: [DONE]\n\n',
    ])
    expect(r.texts).toBe(2)
    expect(r.usage).toBe(7)
    expect(r.ended).toBe(true)
  })

  it('reassembles an event split across network chunks', () => {
    const r = readStream('chat', [
      'data: {"choices":[{"delta":{"con',
      'tent":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(r.texts).toBe(1)
    expect(r.ended).toBe(true)
  })

  it('ignores comment heartbeats and event: lines', () => {
    const r = readStream('chat', [
      ': keep-alive\n\n',
      'event: chunk\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(r.texts).toBe(1)
    expect(r.ended).toBe(true)
  })

  it('treats an in-band error object as a stream failure', () => {
    const r = readStream('chat', [sse({ error: { message: 'boom' } })])
    expect(r.errored).toBe(true)
    expect(r.ended).toBe(false)
  })

  it('leaves usage null when the upstream never sends one', () => {
    const r = readStream('chat', [
      sse({ choices: [{ delta: { content: 'a' } }] }),
      'data: [DONE]\n\n',
    ])
    expect(r.usage).toBeNull()
    expect(r.deltas).toBe(1)
  })
})

describe('Responses stream', () => {
  it('starts the clock on output_text.delta only, not on lifecycle or reasoning events', () => {
    const r = readStream('responses', [
      sse({ type: 'response.created' }),
      sse({ type: 'response.in_progress' }),
      sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }),
      sse({ type: 'response.output_text.delta', delta: '' }),
      sse({ type: 'response.output_text.delta', delta: '1,' }),
      sse({ type: 'response.output_text.done', text: '1,2,3' }),
      sse({ type: 'response.completed', response: { usage: { output_tokens: 12 } } }),
    ])
    expect(r.texts).toBe(1)
    // The terminal full text must not be recounted as output.
    expect(r.deltas).toBe(1)
    expect(r.usage).toBe(12)
    expect(r.ended).toBe(true)
  })

  it('treats hitting max_output_tokens as a normal close and keeps its usage', () => {
    const r = readStream('responses', [
      sse({ type: 'response.output_text.delta', delta: '1,' }),
      sse({
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { output_tokens: 128 },
        },
      }),
    ])
    expect(r.ended).toBe(true)
    expect(r.usage).toBe(128)
  })

  it('treats any other incomplete reason, failed, and error as failures', () => {
    const contentFilter = readStream('responses', [
      sse({ type: 'response.output_text.delta', delta: '1,' }),
      sse({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      }),
    ])
    expect(contentFilter.errored).toBe(true)
    expect(readStream('responses', [sse({ type: 'response.failed' })]).errored).toBe(true)
    expect(readStream('responses', [sse({ type: 'error' })]).errored).toBe(true)
  })

  it('falls back to a delta count when the terminal usage is missing', () => {
    const r = readStream('responses', [
      sse({ type: 'response.output_text.delta', delta: 'a' }),
      sse({ type: 'response.output_text.delta', delta: 'b' }),
      sse({ type: 'response.completed', response: {} }),
    ])
    expect(r.usage).toBeNull()
    expect(r.deltas).toBe(2)
  })
})

describe('Messages stream', () => {
  it('counts text_delta blocks and closes on message_stop', () => {
    const r = readStream('messages', [
      sse({ type: 'message_start', message: { usage: { output_tokens: 1 } } }),
      sse({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }),
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1,' } }),
      sse({ type: 'ping' }),
      sse({ type: 'message_delta', usage: { output_tokens: 9 } }),
      sse({ type: 'message_stop' }),
    ])
    expect(r.texts).toBe(1)
    expect(r.ended).toBe(true)
    // Cumulative usage: the later value replaces the earlier, never adds to it.
    expect(r.usage).toBe(9)
  })

  it('does not start the clock on a thinking delta', () => {
    const r = readStream('messages', [
      sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      sse({ type: 'message_stop' }),
    ])
    expect(r.texts).toBe(0)
  })

  it('treats an error event as a stream failure', () => {
    const r = readStream('messages', [sse({ type: 'error', error: { type: 'overloaded_error' } })])
    expect(r.errored).toBe(true)
  })
})
