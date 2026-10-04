/**
 * Relay registry + URL-normalization tests (ADR-0029). The streaming handlers are
 * covered end-to-end (a real provider); here we pin the pure pieces: token
 * binding lifecycle, the per-vendor endpoints, and the upstream-URL derivation.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  createRelay,
  chatCompletionsUrl,
  anthropicMessagesUrl,
  responsesUrl,
  RELAY_CODEX_PATH,
  RELAY_ANTHROPIC_PATH,
} from './index.js'

/** A minimal Hono-context stand-in for the handlers (header/json in, body/json out). */
function fakeCtx(headers: Record<string, string>, body: unknown) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      json: async () => body,
      raw: { signal: new AbortController().signal },
    },
    body: (b: unknown, status?: number, h?: unknown) => ({
      __body: b,
      status: status ?? 200,
      headers: h,
    }),
    json: (b: unknown, status: number) => ({ __json: b, status }),
  }
}

describe('chatCompletionsUrl', () => {
  it.each([
    ['https://api.deepseek.com/', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.moonshot.ai/v1', 'https://api.moonshot.ai/v1/chat/completions'],
    ['https://api.xiaomimimo.com/v1/', 'https://api.xiaomimimo.com/v1/chat/completions'],
    ['https://x.test/v1/chat/completions', 'https://x.test/v1/chat/completions'],
  ])('%s → %s', (input, expected) => {
    expect(chatCompletionsUrl(input)).toBe(expected)
  })
})

describe('anthropicMessagesUrl', () => {
  it.each([
    ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/v1/messages'],
    ['https://api.deepseek.com/anthropic/', 'https://api.deepseek.com/anthropic/v1/messages'],
    ['https://x.test/anthropic/v1/messages', 'https://x.test/anthropic/v1/messages'],
  ])('%s → %s', (input, expected) => {
    expect(anthropicMessagesUrl(input)).toBe(expected)
  })
})

describe('responsesUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/responses'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/responses'],
    ['https://x.test/v1/responses', 'https://x.test/v1/responses'],
  ])('%s → %s', (input, expected) => {
    expect(responsesUrl(input)).toBe(expected)
  })
})

describe('createRelay registry', () => {
  it('exposes the per-vendor loopback endpoints', () => {
    const relay = createRelay('http://127.0.0.1:3000/')
    expect(relay.endpoint('codex')).toBe(`http://127.0.0.1:3000${RELAY_CODEX_PATH}`)
    expect(relay.endpoint('claude')).toBe(`http://127.0.0.1:3000${RELAY_ANTHROPIC_PATH}`)
  })

  it('register returns a token; unregister drops it', () => {
    let n = 0
    const relay = createRelay('http://127.0.0.1:3000', () => `tok-${++n}`)
    const token = relay.register([
      {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-real',
        model: 'deepseek-v4',
        wireApi: 'chat',
      },
    ])
    expect(token).toBe('tok-1')
    relay.unregister(token)
    // a second register mints a fresh token (no reuse).
    expect(
      relay.register([
        {
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-real',
          model: 'deepseek-v4',
          wireApi: 'chat',
        },
      ]),
    ).toBe('tok-2')
  })

  it('rejects an unknown codex token with 401', async () => {
    const relay = createRelay('http://127.0.0.1:3000')
    const c = {
      req: { header: () => 'Bearer nope', json: async () => ({}), raw: { signal: undefined } },
      json: (body: unknown, status: number) => ({ body, status }),
    }
    const res = (await relay.codexHandler(c as never)) as unknown as { status: number }
    expect(res.status).toBe(401)
  })

  it('rejects an unknown anthropic token with 401', async () => {
    const relay = createRelay('http://127.0.0.1:3000')
    const c = {
      req: { header: () => '', json: async () => ({}), raw: { signal: undefined } },
      json: (body: unknown, status: number) => ({ body, status }),
    }
    const res = (await relay.anthropicHandler(c as never)) as unknown as { status: number }
    expect(res.status).toBe(401)
  })
})

describe('relay failover (ADR-0029)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('anthropic handler fails over from a 429 to the next candidate, then streams it', async () => {
    const relay = createRelay('http://127.0.0.1:3000', () => 'tok')
    relay.register([
      { baseUrl: 'https://a.example/anthropic', apiKey: 'kA', model: 'mA' },
      { baseUrl: 'https://b.example/anthropic', apiKey: 'kB', model: 'mB' },
    ])
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      if (calls.length === 1) return new Response('rate limited', { status: 429 })
      return new Response('event: message_stop\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const res = (await relay.anthropicHandler(
      fakeCtx({ 'x-api-key': 'tok' }, { model: 'placeholder', messages: [] }) as never,
    )) as unknown as { status: number }
    expect(calls).toEqual([
      'https://a.example/anthropic/v1/messages',
      'https://b.example/anthropic/v1/messages',
    ])
    expect(res.status).toBe(200)
  })

  it('anthropic handler surfaces a 400 without failover (a sibling cannot fix it)', async () => {
    const relay = createRelay('http://127.0.0.1:3000', () => 'tok')
    relay.register([
      { baseUrl: 'https://a.example/anthropic', apiKey: 'kA', model: 'mA' },
      { baseUrl: 'https://b.example/anthropic', apiKey: 'kB', model: 'mB' },
    ])
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('bad request', { status: 400 })
    }) as typeof fetch
    const res = (await relay.anthropicHandler(
      fakeCtx({ 'x-api-key': 'tok' }, { model: 'x', messages: [] }) as never,
    )) as unknown as { __body: unknown; status: number }
    expect(calls).toBe(1) // no failover on a 4xx that is not 429
    // The error surfaces as a one-shot SSE `error` event, not a JSON 401.
    expect(String(res.__body)).toContain('event: error')
  })

  it('codex handler overrides the request model with the hit candidate model', async () => {
    const relay = createRelay('http://127.0.0.1:3000', () => 'tok')
    relay.register([
      { baseUrl: 'https://a.example', apiKey: 'kA', model: 'deepseek-v4', wireApi: 'chat' },
    ])
    let sentBodyRaw = ''
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodyRaw = String(init.body)
      return new Response('data: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    await relay.codexHandler(
      fakeCtx({ authorization: 'Bearer tok' }, { model: 'placeholder', input: [] }) as never,
    )
    const sentBody = JSON.parse(sentBodyRaw) as Record<string, unknown>
    expect(sentBody.model).toBe('deepseek-v4')
  })
})

/**
 * Upstream Chat stream TERMINATION semantics. The regression these guard is the
 * dangerous one: a truncated stream used to be translated into
 * `response.completed`, so a cut-off turn — half a tool call, half a sentence —
 * reached the CLI as a success and an automation would persist it as one.
 */
describe('relay Chat stream termination (truncation is not completion)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** A Chat SSE body built from raw `data:` lines, in order. */
  function chatSse(lines: string[]): Response {
    return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  async function runCodexHandler(relayBody: () => Response): Promise<string> {
    const relay = createRelay('http://127.0.0.1:3000', () => 'tok')
    relay.register([{ baseUrl: 'https://a.example', apiKey: 'kA', model: 'm', wireApi: 'chat' }])
    globalThis.fetch = (async () => relayBody()) as typeof fetch
    // The fake ctx's `body()` hands the stream straight back (Hono would wrap it in
    // a Response), so drain it here to get the translated SSE text.
    const res = (await relay.codexHandler(
      fakeCtx({ authorization: 'Bearer tok' }, { model: 'placeholder', input: [] }) as never,
    )) as unknown as { __body: ReadableStream<Uint8Array> }
    return new Response(res.__body).text()
  }

  it('emits response.completed for a stream that ends with [DONE]', async () => {
    const body = await runCodexHandler(() =>
      chatSse([
        JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'hello' } }] }),
        JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      ]),
    )
    expect(body).toContain('response.completed')
    expect(body).not.toContain('response.failed')
    expect(body).toContain('hello')
  })

  it('emits response.completed when only finish_reason terminates the stream (no [DONE])', async () => {
    const body = await runCodexHandler(() =>
      chatSse([
        JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    )
    expect(body).toContain('response.completed')
    expect(body).not.toContain('response.failed')
  })

  it('emits response.failed (not completed) when the stream just stops mid-turn', async () => {
    const body = await runCodexHandler(() =>
      chatSse([
        JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'half a sen' } }] }),
        JSON.stringify({
          id: 'c1',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 't1', function: { name: 'bash', arguments: '{"cmd":"re' } },
                ],
              },
            },
          ],
        }),
      ]),
    )
    // The cut-off text/tool-args must NOT be presented as a finished turn.
    expect(body).toContain('response.failed')
    expect(body).not.toContain('response.completed')
    expect(body).toContain('upstream stream ended before completion')
  })

  it('does not emit response.completed for an entirely empty upstream body', async () => {
    const body = await runCodexHandler(() => chatSse([]))
    expect(body).toContain('response.failed')
    expect(body).not.toContain('response.completed')
  })

  it('still surfaces an upstream error object as response.failed', async () => {
    const body = await runCodexHandler(() =>
      chatSse([JSON.stringify({ error: { message: 'upstream exploded' } })]),
    )
    expect(body).toContain('response.failed')
    expect(body).toContain('upstream exploded')
    expect(body).not.toContain('response.completed')
  })
})
