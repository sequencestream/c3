import { describe, it, expect } from 'vitest'
import { fallbackName, generateScheduleName } from './naming.js'

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
})
