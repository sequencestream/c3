/**
 * hide-session-system-instructions — Claude path (AC-3 / AC-4).
 *
 * Drives the REAL `runClaude` with the SDK `query` mocked (the same pattern as
 * `socket-resume.test.ts`) to pin the vendor-specific delivery contract: an internal
 * system instruction (the SDD work contract) reaches the model through the preset
 * system **append**, NOT the user turn, and never surfaces on any client wire event
 * `runClaude` emits. The launch-side split (handler → `launchRun`) that produces this
 * shape is pinned in `features/intents/dev-prompt.test.ts`; here we assert what the
 * Claude vendor does with it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

// Capture, per query() call, the system prompt option and the first user-turn text
// the SDK actually received (pulled from the streaming-input iterable).
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ systemPrompt?: unknown; firstUserText?: string }>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: {
    prompt: AsyncIterable<{ message?: { content?: unknown } }>
    options?: { systemPrompt?: unknown }
  }) => {
    const rec: { systemPrompt?: unknown; firstUserText?: string } = {
      systemPrompt: arg.options?.systemPrompt,
    }
    sdk.calls.push(rec)
    return {
      async *[Symbol.asyncIterator]() {
        // Read the first user turn so the test can assert what the model received.
        const first = await arg.prompt[Symbol.asyncIterator]().next()
        const content = first.value?.message?.content
        rec.firstUserText =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? ((
                  content.find((b) => (b as { type?: string }).type === 'text') as
                    | { text?: string }
                    | undefined
                )?.text ?? '')
              : ''
        yield { type: 'result', session_id: 'sid-claude' }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude } from './kernel/agent/index.js'

const SDD_INSTRUCT = 'You are a spec-driven development agent. Hard constraints: Spec is Truth.'
const VISIBLE = 'Cache the endpoint\n\nAdd an LRU cache.'

beforeEach(() => {
  sdk.calls = []
})

describe('Claude path — internal instruction rides the system append, not the user turn', () => {
  it('delivers appendSystemPrompt as the preset system append; user turn excludes it', async () => {
    const events: ServerToClient[] = []
    await runClaude({
      prompt: VISIBLE, // launchRun feeds the visible body (no devSkill prefix here)
      cwd: '/tmp',
      signal: new AbortController().signal,
      permissionMode: 'default',
      appendSystemPrompt: SDD_INSTRUCT,
      send: (m) => events.push(m),
    })

    expect(sdk.calls).toHaveLength(1)
    // The model received the internal instruction through the system channel.
    expect(sdk.calls[0].systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: SDD_INSTRUCT,
    })
    // The user turn the model saw is the visible body alone — never the instruction.
    expect(sdk.calls[0].firstUserText).toBe(VISIBLE)
    expect(sdk.calls[0].firstUserText).not.toContain('Hard constraints')

    // No client-facing wire event runClaude emits carries the internal instruction.
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain('Hard constraints')
    }
  })

  it('carries a slash-command dev skill in the user turn (so it expands) — system append stays bare', async () => {
    const events: ServerToClient[] = []
    await runClaude({
      prompt: `/dev ${VISIBLE}`, // launchRun prepends the slash command to the model turn
      cwd: '/tmp',
      signal: new AbortController().signal,
      permissionMode: 'default',
      send: (m) => events.push(m),
    })

    expect(sdk.calls).toHaveLength(1)
    // No appendSystemPrompt for a devSkill run ⇒ a bare preset system prompt.
    expect(sdk.calls[0].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    // The slash command leads the user turn (a slash command only expands there).
    expect(sdk.calls[0].firstUserText).toBe(`/dev ${VISIBLE}`)
  })
})
