import { describe, expect, it } from 'vitest'
import { buildSpecAgentPrompt } from './spec-prompt.js'

describe('buildSpecAgentPrompt', () => {
  it('makes the user the primary reader and localizes the authored document', () => {
    const prompt = buildSpecAgentPrompt('zh')

    expect(prompt).toContain('first reader is the user; its second reader is the development agent')
    expect(prompt).toContain('Write the document itself in Chinese')
  })

  it('requires a minimal structure for simple changes', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a simple change')
    expect(prompt).toContain('Target 8–20 lines')
    expect(prompt).toContain('Do not add background, repeated requirements, alternatives')
  })

  it('reserves migration and trade-off detail for complex changes', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a complex or high-risk change')
    expect(prompt).toContain('Decision and trade-offs')
    expect(prompt).toContain('Compatibility / migration')
  })
})
