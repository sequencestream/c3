import { describe, it, expect } from 'vitest'
import type { ConsensusVote } from '@ccc/shared/protocol'
import { parseVote, tally, fallbackSummary } from './consensus-tally.js'

function vote(decision: ConsensusVote['decision']): ConsensusVote {
  return { agentId: decision, agentName: decision, decision, reason: '' }
}

describe('parseVote', () => {
  it('parses a strict JSON object', () => {
    expect(parseVote('{"decision":"allow","reason":"looks safe"}')).toEqual({
      decision: 'allow',
      reason: 'looks safe',
    })
  })

  it('extracts JSON embedded in surrounding prose', () => {
    const text =
      'Sure — here is my verdict:\n{"decision":"deny","reason":"writes outside cwd"}\nthanks'
    expect(parseVote(text)).toEqual({ decision: 'deny', reason: 'writes outside cwd' })
  })

  it('falls back to a keyword scan when there is no JSON', () => {
    expect(parseVote('I would deny this one.')?.decision).toBe('deny')
    expect(parseVote('Allow it.')?.decision).toBe('allow')
  })

  it('returns null when the answer is ambiguous or empty', () => {
    expect(parseVote('allow or deny? hard to say')).toBeNull()
    expect(parseVote('')).toBeNull()
  })
})

describe('tally', () => {
  it('is unanimous when every voter allows', () => {
    expect(tally([vote('allow'), vote('allow')])).toEqual({ unanimous: true, decision: 'allow' })
  })

  it('is unanimous when every voter denies', () => {
    expect(tally([vote('deny'), vote('deny')])).toEqual({ unanimous: true, decision: 'deny' })
  })

  it('is split on mixed verdicts', () => {
    expect(tally([vote('allow'), vote('deny')])).toEqual({ unanimous: false, decision: null })
  })

  it('treats any abstention as non-unanimous (defer to human)', () => {
    expect(tally([vote('allow'), vote('abstain')])).toEqual({ unanimous: false, decision: null })
  })

  it('is non-unanimous with no voters', () => {
    expect(tally([])).toEqual({ unanimous: false, decision: null })
  })
})

describe('fallbackSummary', () => {
  it('states unanimous outcomes', () => {
    expect(fallbackSummary([vote('allow'), vote('allow')], true, 'allow')).toContain('一致允许')
  })

  it('flags splits as needing a human', () => {
    expect(fallbackSummary([vote('allow'), vote('deny')], false, null)).toContain('需人工裁决')
  })
})
