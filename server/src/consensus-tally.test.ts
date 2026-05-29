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

// ---- AskUserQuestion: per-question answering ----

import {
  askQuestions,
  parseAskVote,
  tallyQuestion,
  answerKey,
  fallbackAskSummary,
  type AskQuestion,
} from './consensus-tally.js'

const Q: AskQuestion[] = [
  {
    question: 'Where does redemption happen?',
    header: '核销',
    multiSelect: false,
    options: [{ label: '商户端核销' }, { label: '用户端自助核销' }, { label: '两端都支持' }],
  },
  {
    question: 'Online payment this iteration?',
    header: '支付',
    multiSelect: false,
    options: [{ label: '复用现有订单支付流程' }, { label: '本期只做下单+线下收款' }],
  },
]

describe('askQuestions', () => {
  it('extracts a valid questions array', () => {
    expect(askQuestions({ questions: Q })?.length).toBe(2)
  })
  it('returns null for non-ask input', () => {
    expect(askQuestions({ filePath: '/x' })).toBeNull()
    expect(askQuestions({ questions: [] })).toBeNull()
  })
})

describe('parseAskVote', () => {
  it('matches option labels case-insensitively, one entry per question', () => {
    const text =
      '{"answers":[{"index":0,"choice":"商户端核销","reason":"商户触发更合理"},{"index":1,"choice":"本期只做下单+线下收款","reason":"先打通主流程"}]}'
    const out = parseAskVote(text, Q, 'a1', 'Agent1')
    expect(out).toHaveLength(2)
    expect(out[0].optionLabels).toEqual(['商户端核销'])
    expect(out[0].abstain).toBeUndefined()
    expect(out[1].optionLabels).toEqual(['本期只做下单+线下收款'])
  })

  it('marks a missing/garbled question as abstain', () => {
    const out = parseAskVote('not json at all', Q, 'a1', 'Agent1')
    expect(out.every((a) => a.abstain)).toBe(true)
  })

  it('keeps a custom reply when no option matches', () => {
    const text = '{"answers":[{"index":0,"choice":"custom","custom":"看场景再定","reason":"r"}]}'
    const out = parseAskVote(text, Q, 'a1', 'Agent1')
    expect(out[0]).toMatchObject({ optionLabels: [], custom: '看场景再定' })
    expect(out[1].abstain).toBe(true)
  })
})

describe('tallyQuestion', () => {
  const a = (id: string, labels: string[], abstain = false) => ({
    agentId: id,
    agentName: id,
    optionLabels: labels,
    reason: '',
    ...(abstain ? { abstain: true } : {}),
  })

  it('is unanimous when all active voters agree', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', ['商户端核销']), a('y', ['商户端核销'])])
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('商户端核销')
  })

  it('is split when voters differ', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', ['商户端核销']), a('y', ['两端都支持'])])
    expect(r.unanimous).toBe(false)
    expect(r.agreed).toBeNull()
  })

  it('any abstention blocks unanimity (defer to human)', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', ['商户端核销']), a('y', [], true)])
    expect(r.unanimous).toBe(false)
  })
})

describe('answerKey', () => {
  it('sorts multi-select labels so order does not matter', () => {
    expect(answerKey({ agentId: 'x', agentName: 'x', optionLabels: ['B', 'A'], reason: '' })).toBe(
      'A, B',
    )
  })
})

describe('fallbackAskSummary', () => {
  it('reports full agreement', () => {
    const pq = Q.map((q, i) =>
      tallyQuestion(q, i, [
        { agentId: 'x', agentName: 'x', optionLabels: [q.options[0].label], reason: '' },
      ]),
    )
    expect(fallbackAskSummary(pq)).toContain('一致')
  })
})
