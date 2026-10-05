/**
 * The authoring prompt is a PROJECTION of the ruleset, so these tests assert the
 * projection and the shell — never a prose literal. A test that pinned 'Target
 * 8–20 lines' would only prove someone edited a string; a test that renders the
 * ruleset and compares proves the prompt cannot drift from the discipline.
 */

import { describe, expect, it } from 'vitest'
import { buildSpecAgentPrompt } from './spec-prompt.js'
import { SPEC_RULES, SPEC_RULE_LIMIT, SPEC_TIER_LINE_BUDGETS } from './spec-rules.js'

describe('the ruleset — one source of truth', () => {
  it('stays within the cap that keeps it from regrowing into a prose blob', () => {
    expect(SPEC_RULES.length).toBeLessThanOrEqual(SPEC_RULE_LIMIT)
  })

  it('gives every rule a tier and a severity', () => {
    for (const rule of SPEC_RULES) {
      expect(rule.tier).toMatch(/^(simple|normal|complex|all)$/)
      expect(rule.severity).toBe('warn')
      expect(rule.statement.length).toBeGreaterThan(0)
    }
  })

  it('gives every rule a unique id, since the id is the metric row key', () => {
    const ids = SPEC_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers all three tiers with a line budget', () => {
    expect(SPEC_TIER_LINE_BUDGETS.map((t) => t.tier)).toEqual(['simple', 'normal', 'complex'])
  })
})

describe('buildSpecAgentPrompt projects the ruleset', () => {
  it('renders every rule statement into the prompt', () => {
    const prompt = buildSpecAgentPrompt('en')
    for (const rule of SPEC_RULES) {
      expect(prompt).toContain(rule.statement)
    }
  })

  it('renders every tier budget into the prompt', () => {
    const prompt = buildSpecAgentPrompt('en')
    for (const tier of SPEC_TIER_LINE_BUDGETS) {
      expect(prompt).toContain(tier.budget)
    }
    // The two tiers that had no budget before now carry one.
    expect(prompt).toContain('at most 40 lines')
    expect(prompt).toContain('at most 70 lines')
  })

  it('carries the non-normative-navigation declaration', () => {
    const prompt = buildSpecAgentPrompt('en')
    expect(prompt).toContain('NON-NORMATIVE NAVIGATION')
    expect(prompt).toContain('MUST NOT carry a constraint')
  })

  it('carries the four sentence-form rules as shapes, not as numbers', () => {
    const prompt = buildSpecAgentPrompt('en')
    const sentenceForm = SPEC_RULES.find((rule) => rule.id === 'sentence-form')!
    expect(prompt).toContain(sentenceForm.statement)
    expect(sentenceForm.statement).toContain('break it at a semantic boundary')
    expect(sentenceForm.statement).toContain('conclusion of a section first')
    expect(sentenceForm.statement).toContain('connective at most once')
    expect(sentenceForm.statement).toContain('active voice')
    // The rule must not smuggle in a numeric threshold for any of the four.
    expect(sentenceForm.statement).not.toMatch(/\d+\s*(字|词|characters|words|characters)/)
    expect(sentenceForm.statement).toContain('not numbers to hit')
  })

  it('drops the implementation-handoff section and folds the content into Approach', () => {
    const prompt = buildSpecAgentPrompt('en')
    expect(prompt).not.toMatch(/^\s*[-*]\s+\*\*Implementation handoff\*\*/m)
    expect(prompt).not.toContain('## Implementation handoff')
    // The content survives, as an explicit refusal to defer or to order.
    expect(prompt).toContain('no separate implementation-handoff section')
    expect(prompt).toContain('do not list an implementation ORDER')
  })

  it('replaces a file/line inventory of what does NOT change with one sourced sentence', () => {
    const prompt = buildSpecAgentPrompt('en')
    expect(prompt).toContain('let the source be the inventory')
    expect(prompt).toContain('which capability or layer stays as it is and why')
  })

  it('keeps the language shell the ruleset does not own', () => {
    expect(buildSpecAgentPrompt('zh')).toContain('Write the document itself in Chinese')
    expect(buildSpecAgentPrompt('en')).toContain('first reader is the user')
    expect(buildSpecAgentPrompt('en')).toContain('Write the spec, nothing else')
    expect(buildSpecAgentPrompt('en')).toContain('find_intents')
  })

  it('tells the author not to announce the tier', () => {
    expect(buildSpecAgentPrompt('en')).toContain('Do not announce the complexity level')
  })
})

describe('the prompt holds no second copy of the discipline', () => {
  it('owns every bolded label: each is either a ruleset principle or shell scaffolding', () => {
    const prompt = buildSpecAgentPrompt('en')
    // Everything the prompt bolds must be accounted for by exactly two sources:
    // a projected principle, or the shell (runtime confinement + tier skeletons).
    // A discipline rule restated here under a new label is exactly the drift the
    // projection exists to prevent.
    const ruleLabels = SPEC_RULES.map((rule) => rule.statement.match(/\*\*([^*]+)\*\*/)![1]!)
    const shellLabels = [
      'Write the spec, nothing else.',
      'Query existing intents (read-only).',
      'Change summary',
      'Behavior and boundaries',
      'Verification',
      'Approach',
      'Affected capabilities / contracts',
      'Important boundaries',
      'Decision and trade-offs',
      'Compatibility / migration',
      'Risks and failure handling',
      // Emphasis in the job description, not a rule label.
      'spec document',
    ]
    const claimed = prompt.match(/\*\*[^*]+\*\*/g) ?? []
    const stray = claimed
      .map((label) => label.replace(/\*\*/g, ''))
      .filter((bare) => !ruleLabels.includes(bare) && !shellLabels.includes(bare))
    expect(stray).toEqual([])
  })
})
