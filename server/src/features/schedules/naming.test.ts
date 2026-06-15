import { describe, it, expect, vi } from 'vitest'

// The default LLM path (`defaultInvokeLlm`, used when no `deps.invokeLlm` is
// injected) runs name derivation as a background tool session: it resolves the
// tool agent via `resolveToolSessionLaunch` and feeds its model/env into the
// one-shot `query`. Mock both so we can assert that routing without the network.
const queryMock = vi.fn((opts: { options?: { model?: string; env?: Record<string, string> } }) => {
  void opts
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Tool Named' }] } }
    yield { type: 'result' }
  })()
})
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (o: unknown) => queryMock(o as never) }))
const toolLaunchMock = vi.fn(() => ({
  agentId: 'tool-agent',
  model: 'tool-model',
  envOverrides: { TOOL: '1' },
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  resolveToolSessionLaunch: () => toolLaunchMock(),
}))

import { fallbackName, generateScheduleName } from './naming.js'
import { getUiLangName } from '../../kernel/config/index.js'

describe('fallbackName', () => {
  it('truncates the command for command schedules', () => {
    expect(fallbackName('command', { command: 'echo hi' })).toBe('echo hi')
  })

  it('clamps a long command to <= 60 chars', () => {
    const long = 'x'.repeat(200)
    expect(fallbackName('command', { command: long }).length).toBeLessThanOrEqual(60)
  })

  it('takes the first sentence of an llm prompt', () => {
    expect(fallbackName('llm', { prompt: 'Audit the repo. Then summarize.' })).toBe(
      'Audit the repo.',
    )
  })

  it('returns a per-type default when content is empty', () => {
    expect(fallbackName('command', {})).toBe('Command task')
    expect(fallbackName('llm', {})).toBe('LLM task')
    expect(fallbackName('command', null)).toBe('Command task')
  })
})

describe('generateScheduleName', () => {
  it('returns a non-empty name from the LLM for a command', async () => {
    const name = await generateScheduleName(
      { type: 'command', config: { command: 'pnpm build' } },
      { invokeLlm: async () => 'Nightly Build' },
    )
    expect(name).toBe('Nightly Build')
  })

  it('returns a non-empty name from the LLM for a prompt', async () => {
    const name = await generateScheduleName(
      { type: 'llm', config: { prompt: 'Run a security audit' } },
      { invokeLlm: async () => 'Security Audit' },
    )
    expect(name).toBe('Security Audit')
  })

  it('strips wrapping quotes and collapses whitespace from the LLM output', async () => {
    const name = await generateScheduleName(
      { type: 'command', config: { command: 'x' } },
      { invokeLlm: async () => '  "Nightly   Build"  ' },
    )
    expect(name).toBe('Nightly Build')
  })

  it('falls back to the truncated command when the LLM throws', async () => {
    const name = await generateScheduleName(
      { type: 'command', config: { command: 'echo hi' } },
      {
        invokeLlm: async () => {
          throw new Error('llm unavailable')
        },
      },
    )
    expect(name).toBe('echo hi')
  })

  it('falls back to the prompt first sentence when the LLM returns empty', async () => {
    const name = await generateScheduleName(
      { type: 'llm', config: { prompt: 'Summarize logs. Extra detail.' } },
      { invokeLlm: async () => '   ' },
    )
    expect(name).toBe('Summarize logs.')
  })

  it('builds a naming prompt that instructs the model to use the Display language', async () => {
    let captured = ''
    await generateScheduleName(
      { type: 'command', config: { command: 'pnpm build' } },
      {
        invokeLlm: async (prompt) => {
          captured = prompt
          return 'Nightly Build'
        },
      },
    )
    expect(captured).toContain(getUiLangName())
  })

  it('falls back to a default name when there is no content and the LLM fails', async () => {
    const name = await generateScheduleName(
      { type: 'llm', config: {} },
      {
        invokeLlm: async () => {
          throw new Error('boom')
        },
      },
    )
    expect(name).toBe('LLM task')
  })

  it('default LLM path runs on the tool agent: model/env from resolveToolSessionLaunch (2026-06-15-001)', async () => {
    // No injected invokeLlm ⇒ exercises defaultInvokeLlm (the real tool-session path).
    const name = await generateScheduleName({ type: 'command', config: { command: 'pnpm build' } })
    expect(name).toBe('Tool Named')
    expect(toolLaunchMock).toHaveBeenCalled()
    const opts = queryMock.mock.calls[0][0].options
    expect(opts?.model).toBe('tool-model')
    expect(opts?.env).toMatchObject({ TOOL: '1' })
  })
})
