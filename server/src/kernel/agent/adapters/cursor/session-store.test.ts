/**
 * CursorSessionStore tests. The store's `read` joins two SDK surfaces — the
 * prompt side (`Agent.messages.list`, one entry per run, oneof-wrapped) and the
 * reply side (`run.conversation()` steps) — so a fake `CursorSessionSource`
 * stands in for both and asserts on the interleaved canonical transcript.
 */
import { describe, expect, it } from 'vitest'
import type { CanonicalMessage } from '../types.js'
import {
  CursorSessionStore,
  type CursorConversationStep,
  type CursorSessionSource,
  type CursorStoredMessage,
} from './session-store.js'

/** A source whose prompts / reply steps are scripted, everything else no-op. */
function fakeSource(over: Partial<CursorSessionSource>): CursorSessionSource {
  return {
    list: async () => [],
    messages: async () => [],
    conversations: async () => [],
    ...over,
  }
}

/** The oneof wrapper the current SDK stores every message in. */
function turn(payload: Record<string, unknown>): unknown {
  return { turn: { case: 'agentConversationTurn', value: payload } }
}

function stored(
  entries: Array<{ type?: string; uuid?: string; message?: unknown }>,
): CursorStoredMessage[] {
  return entries.map((e) => ({ type: 'user', ...e }))
}

function steps(entries: Array<{ type?: string; message?: unknown }>): CursorConversationStep[] {
  return entries.map((e) => ({ type: 'assistantMessage', ...e }))
}

function textBlocks(messages: CanonicalMessage[]): string[] {
  return messages
    .flatMap((m) => m.blocks)
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
}

describe('CursorSessionStore', () => {
  it("interleaves the oneof-wrapped prompt with that run's reply steps", async () => {
    const store = new CursorSessionStore(
      fakeSource({
        messages: async () =>
          stored([
            {
              uuid: 'agent-1:0',
              message: turn({ userMessage: { text: 'fix the bug' } }),
            },
          ]),
        conversations: async () => [
          steps([
            { message: { text: 'looking' } },
            { type: 'assistantMessage', message: { text: 'done' } },
          ]),
        ],
      }),
    )

    const out = await store.read('agent-1', { cwd: '/ws' })
    expect(textBlocks(out)).toEqual(['fix the bug', 'looking', 'done'])
    expect(out[0].role).toBe('user')
    expect(out[1].role).toBe('assistant')
  })

  it('still reads a legacy plain `{ text }` payload', async () => {
    const store = new CursorSessionStore(
      fakeSource({
        messages: async () => stored([{ message: { text: 'legacy prompt' } }]),
      }),
    )

    const out = await store.read('agent-1', { cwd: '/ws' })
    expect(textBlocks(out)).toEqual(['legacy prompt'])
  })

  it('turns a toolCall step into a tool_use block with its embedded result', async () => {
    const store = new CursorSessionStore(
      fakeSource({
        messages: async () => stored([{ message: turn({ userMessage: { text: 'run it' } }) }]),
        conversations: async () => [
          steps([
            {
              type: 'toolCall',
              message: {
                type: 'shell',
                args: { command: 'ls' },
                result: { status: 'success', value: { stdout: 'src\n', exitCode: 0 } },
              },
            },
          ]),
        ],
      }),
    )

    const out = await store.read('agent-1', { cwd: '/ws' })
    const tool = out.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(tool).toBeDefined()
    expect(tool?.type).toBe('tool_use')
    if (tool?.type === 'tool_use') {
      expect(tool.name).toBe('shell')
      expect(tool.input).toEqual({ command: 'ls' })
      expect(tool.result?.content).toBe('src\n')
      expect(tool.result?.isError).toBe(false)
    }
  })

  it('marks a tool result with status error as failed', async () => {
    const store = new CursorSessionStore(
      fakeSource({
        conversations: async () => [
          steps([
            {
              type: 'toolCall',
              message: { type: 'read', result: { status: 'error', value: { stderr: 'no' } } },
            },
          ]),
        ],
      }),
    )

    const out = await store.read('agent-1', { cwd: '/ws' })
    const tool = out.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type === 'tool_use') {
      expect(tool.result?.isError).toBe(true)
      expect(tool.result?.content).toContain('no')
    }
  })

  it('keeps multi-turn prompts in front of the replies they produced', async () => {
    const store = new CursorSessionStore(
      fakeSource({
        messages: async () =>
          stored([
            { uuid: 'agent-1:0', message: turn({ userMessage: { text: 'first' } }) },
            { uuid: 'agent-1:1', message: turn({ userMessage: { text: 'second' } }) },
          ]),
        conversations: async () => [
          steps([{ message: { text: 'reply-1' } }]),
          steps([{ message: { text: 'reply-2' } }]),
        ],
      }),
    )

    const out = await store.read('agent-1', { cwd: '/ws' })
    expect(textBlocks(out)).toEqual(['first', 'reply-1', 'second', 'reply-2'])
  })

  it('emits nothing for a store with no messages and no conversations', async () => {
    const store = new CursorSessionStore(fakeSource({}))
    expect(await store.read('agent-1', { cwd: '/ws' })).toEqual([])
  })
})
