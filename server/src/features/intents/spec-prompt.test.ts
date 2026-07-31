import { describe, expect, it } from 'vitest'
import { buildSpecAgentPrompt } from './spec-prompt.js'

describe('buildSpecAgentPrompt', () => {
  it('makes the user the primary reader and localizes the authored document', () => {
    const prompt = buildSpecAgentPrompt('zh')

    expect(prompt).toContain('first reader is the user; its second reader is the development agent')
    expect(prompt).toContain('Write the document itself in Chinese')
  })

  it('requires a self-contained spec that distils the intent instead of excluding it', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('the spec must be self-contained')
    expect(prompt).toContain(
      'a reviewer reads this document alone and approves or rejects, without opening the intent or the source',
    )
    expect(prompt).toContain(
      'the motivation, the observable change, the scope boundaries and non-goals, and the acceptance conditions',
    )
    expect(prompt).toContain('Do not copy the intent verbatim')
    expect(prompt).toContain(
      '**Self-contained** (reviewable without opening the intent or the source)',
    )

    expect(prompt).not.toContain('Do NOT restate the intent')
    expect(prompt).not.toContain('Never repeat Why, What, Non-goals')
    expect(prompt).not.toContain('repeated requirements')
  })

  it('requires a minimal structure for simple changes', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a simple change')
    expect(prompt).toContain('Behavior and boundaries')
    expect(prompt).toContain('Target 8–20 lines')
    expect(prompt).toContain('Do not add background, implementation steps, alternatives')
  })

  it('requires the implementation approach while forbidding exhaustive code transcription', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain(
      'the chosen approach, the flows, the core logic, the state and its transitions, and the rules',
    )
    expect(prompt).toContain('Do not exhaustively transcribe the code')
    expect(prompt).toContain('Cover the implementation approach inline where it belongs')
  })

  it('requires a top-down hierarchy instead of a flat pile of bullets', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('Organise the content top-down so the hierarchy is visible')
    expect(prompt).toContain('**Frame first, decompose, then land.**')
    expect(prompt).toContain(
      'decompose it layer by layer along its modules, flows, or state relationships, and only then land on the concrete change points',
    )
    expect(prompt).toContain('grouped subsections or nested bullets')
    expect(prompt).toContain('never flatten it into one level of loose bullets')
  })

  it('suggests locating named symbols by file path or owning module', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('**Suggested: keep key touchpoints locatable.**')
    expect(prompt).toContain(
      'it helps the reader to also give its file path — or at least the owning module, class, and method name',
    )
    expect(prompt).toContain('not a licence to enumerate every file and symbol')
  })

  it('suggests Mermaid diagrams only when the change is genuinely complex', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('**Suggested: draw it when it is genuinely complex.**')
    expect(prompt).toContain(
      'add a Mermaid code block (`graph`, `flowchart`, or `sequenceDiagram`)',
    )
    expect(prompt).toContain('complex enough that a picture pays for itself')
  })

  it('keeps locating and diagramming advisory rather than mandatory', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain(
      'Both of these are suggestions to use where they fit, not acceptance criteria',
    )
    expect(prompt).toContain('a simple change needs no diagram')
    expect(prompt).toContain('may push the document past the length its tier allows')
  })

  it('forbids document-level status labels because approval does not write them back', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('Do not add a `status` label in the frontmatter or document header')
    expect(prompt).toContain('approval is a system gate and does not write a document status back')
  })

  it('keeps the normal tier between the simple and complex tiers', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a normal change, add only sections that carry new information')
    expect(prompt).toContain('Affected capabilities / contracts')
    expect(prompt).toContain('Important boundaries')
  })

  it('reserves migration and trade-off detail for complex changes', () => {
    const prompt = buildSpecAgentPrompt('en')

    expect(prompt).toContain('For a complex or high-risk change')
    expect(prompt).toContain('Decision and trade-offs')
    expect(prompt).toContain('Compatibility / migration')
    expect(prompt).toContain('Risks and failure handling')
  })
})
