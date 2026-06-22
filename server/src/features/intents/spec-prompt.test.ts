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
    expect(prompt).toContain('Behavior and boundaries')
    expect(prompt).toContain('Target 8–20 lines')
    expect(prompt).toContain('Do not add background, repeated requirements, implementation steps')
  })

  it('keeps implementation detail out of the review body', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('do not list source paths, symbols, or step-by-step code edits')
    expect(prompt).toContain(
      'A reviewer must be able to approve or reject it without opening the codebase',
    )
    expect(prompt).toContain('Do not add an implementation appendix by default')
  })

  it('forbids document-level status labels because approval does not write them back', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('Do not add a `status` label in the frontmatter or document header')
    expect(prompt).toContain('Approval is a system gate and does not write a document status back')
  })

  it('reserves migration and trade-off detail for complex changes', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a complex or high-risk change')
    expect(prompt).toContain('Decision and trade-offs')
    expect(prompt).toContain('Compatibility / migration')
  })
})
