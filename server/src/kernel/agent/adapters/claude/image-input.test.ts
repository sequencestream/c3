/**
 * Claude prompt-image adaptation (2026-06-16). Drives the REAL `runClaude` with
 * the SDK `query` mocked (the `keepalive-env.test.ts` pattern) and captures the
 * streaming-input prompt, asserting the first user turn carries a base64 `image`
 * content block per attachment — and that a text-only turn stays a plain string.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PromptImage } from '@ccc/shared/protocol'

// Capture each query() call's streaming-input prompt (the async-iterable).
const sdk = vi.hoisted(() => ({
  prompts: [] as Array<AsyncIterable<unknown>>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { prompt: AsyncIterable<unknown> }) => {
    sdk.prompts.push(arg.prompt)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', session_id: 'sid' }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude } from '../../index.js'

interface UserMsg {
  message: { role: string; content: unknown }
}

/** Run one turn and return the FIRST streaming-input user message the SDK saw. */
async function firstUserMessage(images?: PromptImage[]): Promise<UserMsg> {
  await runClaude({
    prompt: 'look at this',
    ...(images ? { images } : {}),
    cwd: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    send: () => {},
  })
  const prompt = sdk.prompts.at(-1)
  if (!prompt) throw new Error('query() was not called')
  // The first user turn is pushed before query() and never consumed by the mock,
  // so it is still queued — pull it back out to inspect its content shape.
  const { value } = await prompt[Symbol.asyncIterator]().next()
  return value as UserMsg
}

beforeEach(() => {
  sdk.prompts = []
})

describe('runClaude prompt images', () => {
  it('inlines a base64 image content block per attachment alongside the text', async () => {
    const msg = await firstUserMessage([
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/jpeg', data: 'BBBB' },
    ])
    expect(msg.message.role).toBe('user')
    expect(msg.message.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ])
  })

  it('keeps a text-only turn as a plain string (no content-block array)', async () => {
    const msg = await firstUserMessage(undefined)
    expect(msg.message.content).toBe('look at this')
  })

  it('keeps a turn with an empty image list as a plain string', async () => {
    const msg = await firstUserMessage([])
    expect(msg.message.content).toBe('look at this')
  })
})
