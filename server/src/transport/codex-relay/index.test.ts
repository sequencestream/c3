/**
 * Relay registry + URL-normalization tests (ADR-0014). The streaming handler is
 * covered end-to-end (a real provider); here we pin the pure pieces: token
 * binding lifecycle and the Chat-Completions URL derivation.
 */
import { describe, it, expect } from 'vitest'
import { createCodexRelay, chatCompletionsUrl, CODEX_RELAY_PATH } from './index.js'

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

describe('createCodexRelay registry', () => {
  it('exposes the loopback base url codex points at', () => {
    const relay = createCodexRelay('http://127.0.0.1:3000/')
    expect(relay.baseUrl).toBe(`http://127.0.0.1:3000${CODEX_RELAY_PATH}`)
  })

  it('register returns a token; unregister drops it', () => {
    let n = 0
    const relay = createCodexRelay('http://127.0.0.1:3000', () => `tok-${++n}`)
    const token = relay.register({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real' })
    expect(token).toBe('tok-1')
    relay.unregister(token)
    // a second register mints a fresh token (no reuse).
    expect(relay.register({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real' })).toBe('tok-2')
  })

  it('rejects an unknown token with 401', async () => {
    const relay = createCodexRelay('http://127.0.0.1:3000')
    const c = {
      req: { header: () => 'Bearer nope', json: async () => ({}), raw: { signal: undefined } },
      json: (body: unknown, status: number) => ({ body, status }),
    }
    const res = (await relay.handler(c as never)) as unknown as { status: number }
    expect(res.status).toBe(401)
  })
})
