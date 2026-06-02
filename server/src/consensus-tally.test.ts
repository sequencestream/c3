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
  matchOption,
  stripRecommendation,
  parseDeciderAsk,
  deciderAskPrompt,
  askVoterPrompt,
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

  it('matches when the agent appends reasoning after the label', () => {
    // The exact failure mode that mis-recorded a clear pick as 弃权.
    const text =
      '{"answers":[{"index":0,"choice":"商户端核销: 商户触发更合理，先打通主流程","custom":null,"reason":"r"}]}'
    const out = parseAskVote(text, Q, 'a1', 'Agent1')
    expect(out[0].optionLabels).toEqual(['商户端核销'])
    expect(out[0].abstain).toBeUndefined()
  })

  it('matches a label embedded mid-sentence', () => {
    const text =
      '{"answers":[{"index":0,"choice":"我选择 两端都支持 这个方案","custom":null,"reason":"r"}]}'
    const out = parseAskVote(text, Q, 'a1', 'Agent1')
    expect(out[0].optionLabels).toEqual(['两端都支持'])
  })

  it('keeps a custom reply when no option matches', () => {
    const text = '{"answers":[{"index":0,"choice":"custom","custom":"看场景再定","reason":"r"}]}'
    const out = parseAskVote(text, Q, 'a1', 'Agent1')
    expect(out[0]).toMatchObject({ optionLabels: [], custom: '看场景再定' })
    expect(out[1].abstain).toBe(true)
  })
})

describe('matchOption', () => {
  const opts = [{ label: '方案A：扩展协议' }, { label: '方案B：启发式配对' }, { label: '方案A' }]
  it('returns the exact label', () => {
    expect(matchOption('方案A：扩展协议', opts)).toBe('方案A：扩展协议')
  })
  it('prefers the longest label when the choice has trailing text', () => {
    expect(matchOption('方案A：扩展协议: 给 TranscriptItem 加 toolUseId', opts)).toBe(
      '方案A：扩展协议',
    )
  })
  it('matches a label embedded in a sentence', () => {
    expect(matchOption('我倾向 方案B：启发式配对 因为改动小', opts)).toBe('方案B：启发式配对')
  })
  it('returns null when nothing fits', () => {
    expect(matchOption('完全不同的东西', [{ label: '甲' }, { label: '乙' }])).toBeNull()
  })
})

describe('stripRecommendation', () => {
  it('strips trailing bracketed recommendation markers across bracket styles', () => {
    expect(stripRecommendation('方案A (推荐)')).toBe('方案A')
    expect(stripRecommendation('方案A（推荐）')).toBe('方案A')
    expect(stripRecommendation('方案A【建议】')).toBe('方案A')
    expect(stripRecommendation('Use X (Recommended)')).toBe('Use X')
    expect(stripRecommendation('Use X (recommend)')).toBe('Use X')
    expect(stripRecommendation('选项 [默认]')).toBe('选项')
  })
  it('leaves labels without a bracketed marker untouched (no false strip)', () => {
    expect(stripRecommendation('使用系统默认')).toBe('使用系统默认')
    expect(stripRecommendation('商户端核销')).toBe('商户端核销')
    expect(stripRecommendation('推荐信生成')).toBe('推荐信生成')
  })
  it('is idempotent', () => {
    expect(stripRecommendation(stripRecommendation('方案A (推荐)'))).toBe('方案A')
  })
})

describe('de-bias: prompts hide the asker recommendation, matchOption restores it', () => {
  const QR: AskQuestion[] = [
    {
      question: 'pick a plan',
      header: '方案',
      multiSelect: false,
      options: [{ label: '方案A (推荐)' }, { label: '方案B' }],
    },
    {
      question: 'pick features',
      header: '功能',
      multiSelect: true,
      options: [{ label: '功能X（推荐）' }, { label: '功能Y' }, { label: '功能Z' }],
    },
  ]

  it('askVoterPrompt strips the recommendation marker from presented labels', () => {
    const prompt = askVoterPrompt(QR, 'ctx')
    expect(prompt).toContain('方案A')
    expect(prompt).not.toContain('推荐')
    expect(prompt).not.toMatch(/recommend/i)
  })

  it('deciderAskPrompt strips the recommendation marker for split questions', () => {
    const split = tallyQuestion(QR[0], 0, [
      { agentId: 'x', agentName: 'x', optionLabels: ['方案A (推荐)'], reason: '' },
      { agentId: 'y', agentName: 'y', optionLabels: [], reason: '', abstain: true },
    ])
    const prompt = deciderAskPrompt([split], QR)
    expect(prompt).toContain('[0] options:')
    expect(prompt).not.toContain('推荐')
  })

  it('matchOption maps a stripped choice back to the original exact label', () => {
    expect(matchOption('方案A', QR[0].options)).toBe('方案A (推荐)')
    // a sibling without a marker still resolves to itself
    expect(matchOption('方案B', QR[0].options)).toBe('方案B')
  })

  it('multiSelect: stripped picks restore to original labels and tally', () => {
    const text = '{"answers":[{"index":1,"choice":["功能X","功能Y"],"reason":"r"}]}'
    const out = parseAskVote(text, QR, 'a1', 'Agent1')
    expect(out[1].optionLabels).toEqual(['功能X（推荐）', '功能Y'])
    expect(out[0].abstain).toBe(true)
  })

  it('no marker ⇒ matchOption behaves exactly as before (no side effect)', () => {
    const plain = [{ label: '商户端核销' }, { label: '两端都支持' }]
    expect(matchOption('商户端核销', plain)).toBe('商户端核销')
    expect(matchOption('完全不同', plain)).toBeNull()
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

describe('parseDeciderAsk', () => {
  it('returns the summary and an override for a consensus ruling', () => {
    const text =
      '{"summary":"两端都支持核销，本期只做线下收款","questions":[{"index":0,"consensus":true,"choice":"两端都支持","custom":null}]}'
    const { summary, overrides } = parseDeciderAsk(text, Q)
    expect(summary).toBe('两端都支持核销，本期只做线下收款')
    expect(overrides.get(0)).toBe('两端都支持')
  })

  it('drops a question the decider ruled split (consensus:false)', () => {
    const text =
      '{"summary":"对核销方式仍有分歧","questions":[{"index":0,"consensus":false,"choice":null,"custom":null}]}'
    const { overrides } = parseDeciderAsk(text, Q)
    expect(overrides.has(0)).toBe(false)
  })

  it('drops an override whose choice matches no option', () => {
    const text = '{"summary":"s","questions":[{"index":0,"consensus":true,"choice":"火星方案"}]}'
    expect(parseDeciderAsk(text, Q).overrides.has(0)).toBe(false)
  })

  it('accepts a custom agreed answer when consensus is on a custom reply', () => {
    const text =
      '{"summary":"s","questions":[{"index":1,"consensus":true,"choice":"custom","custom":"线上线下都做"}]}'
    expect(parseDeciderAsk(text, Q).overrides.get(1)).toBe('线上线下都做')
  })

  it('returns no overrides on unparseable text', () => {
    expect(parseDeciderAsk('garbage', Q).overrides.size).toBe(0)
  })
})

describe('deciderAskPrompt', () => {
  it('lists the option labels only for the split questions', () => {
    const split = tallyQuestion(Q[0], 0, [
      { agentId: 'x', agentName: 'x', optionLabels: ['商户端核销'], reason: '' },
      { agentId: 'y', agentName: 'y', optionLabels: [], reason: '', abstain: true },
    ])
    const agreed = tallyQuestion(Q[1], 1, [
      { agentId: 'x', agentName: 'x', optionLabels: ['复用现有订单支付流程'], reason: '' },
    ])
    const prompt = deciderAskPrompt([split, agreed], Q)
    expect(prompt).toContain('[0] options:')
    expect(prompt).not.toContain('[1] options:')
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
