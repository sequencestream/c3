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

  it('unanimous-only mode requires every voter to agree (majority off)', () => {
    // Explicit majority=false matches the default: a 2v1 split is NOT resolved.
    expect(tally([vote('allow'), vote('allow'), vote('deny')], false)).toEqual({
      unanimous: false,
      decision: null,
    })
  })
})

describe('tally — majority rule', () => {
  it('3v0 auto-resolves and is still unanimous', () => {
    expect(tally([vote('allow'), vote('allow'), vote('allow')], true)).toEqual({
      unanimous: true,
      decision: 'allow',
    })
    expect(tally([vote('deny'), vote('deny'), vote('deny')], true)).toEqual({
      unanimous: true,
      decision: 'deny',
    })
  })

  it('2v1 auto-resolves to the majority verdict (not unanimous)', () => {
    expect(tally([vote('allow'), vote('allow'), vote('deny')], true)).toEqual({
      unanimous: false,
      decision: 'allow',
    })
    expect(tally([vote('deny'), vote('deny'), vote('allow')], true)).toEqual({
      unanimous: false,
      decision: 'deny',
    })
  })

  it('2v2 tie defers to the human (no clear majority)', () => {
    expect(tally([vote('allow'), vote('allow'), vote('deny'), vote('deny')], true)).toEqual({
      unanimous: false,
      decision: null,
    })
  })

  it('excludes abstentions from the count — 2 allow vs 1 deny (+1 abstain) ⇒ allow', () => {
    expect(tally([vote('allow'), vote('allow'), vote('deny'), vote('abstain')], true)).toEqual({
      unanimous: false,
      decision: 'allow',
    })
  })

  it('an abstention that creates a tie among cast votes defers to the human', () => {
    // 1 allow vs 1 deny among cast votes ⇒ tie ⇒ null, even with majority on.
    expect(tally([vote('allow'), vote('deny'), vote('abstain')], true)).toEqual({
      unanimous: false,
      decision: null,
    })
  })

  it('all abstain (or empty) ⇒ no cast vote ⇒ defers to the human', () => {
    expect(tally([vote('abstain'), vote('abstain')], true)).toEqual({
      unanimous: false,
      decision: null,
    })
    expect(tally([], true)).toEqual({ unanimous: false, decision: null })
  })
})

describe('fallbackSummary', () => {
  it('states unanimous outcomes', () => {
    expect(fallbackSummary([vote('allow'), vote('allow')], true, 'allow')).toContain('一致允许')
  })

  it('flags splits as needing a human', () => {
    expect(fallbackSummary([vote('allow'), vote('deny')], false, null)).toContain('需人工裁决')
  })

  it('labels a majority-carried verdict distinctly from a unanimous one', () => {
    // decision set but not unanimous ⇒ resolved by majority, not by full agreement.
    const s = fallbackSummary([vote('allow'), vote('allow'), vote('deny')], false, 'allow')
    expect(s).toContain('多数派裁决允许')
    expect(s).not.toContain('一致')
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
  shuffleOptions,
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

describe('shuffleOptions (de-bias option order)', () => {
  // A deterministic rng over a fixed draw sequence keeps the permutation testable.
  const seqRng = (seq: number[]) => {
    let i = 0
    return () => seq[i++ % seq.length]
  }

  it('preserves the full label set of every question (no loss, no dup)', () => {
    const out = shuffleOptions(Q, seqRng([0.7, 0.1, 0.9, 0.3]))
    out.forEach((q, i) => {
      const before = Q[i].options.map((o) => o.label).sort()
      const after = q.options.map((o) => o.label).sort()
      expect(after).toEqual(before)
    })
  })

  it('does not mutate the input questions or their option arrays', () => {
    const original = Q[0].options.map((o) => o.label)
    shuffleOptions(Q, () => 0)
    expect(Q[0].options.map((o) => o.label)).toEqual(original)
  })

  it('produces a deterministic permutation for a fixed rng', () => {
    // Fisher–Yates with rng ⇒ 0 always: [a,b,c] -> swap(2,0) -> [c,b,a] -> swap(1,0) -> [b,c,a].
    const q: AskQuestion[] = [
      {
        question: 'q',
        header: 'h',
        multiSelect: false,
        options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
      },
    ]
    expect(shuffleOptions(q, () => 0)[0].options.map((o) => o.label)).toEqual(['b', 'c', 'a'])
  })

  it('a voter seeing a shuffled order still tallies back to the original label', () => {
    // Present each voter an independently shuffled list, but parse against the
    // ORIGINAL questions: matchOption keys off the label, not the position.
    const shuffled = shuffleOptions(Q, seqRng([0, 0.5, 0]))
    expect(shuffled[0].options.map((o) => o.label)).not.toEqual(Q[0].options.map((o) => o.label))
    // Voter echoes the label it saw; parse uses the canonical Q, not the shuffle.
    const text = '{"answers":[{"index":0,"choice":"两端都支持","reason":"r"}]}'
    const a1 = parseAskVote(text, Q, 'a1', 'A1')
    const a2 = parseAskVote(text, Q, 'a2', 'A2')
    const r = tallyQuestion(Q[0], 0, [a1[0], a2[0]])
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('两端都支持')
  })

  it('multiSelect: shuffled presentation still tallies (answerKey is order-free)', () => {
    const QM: AskQuestion[] = [
      {
        question: 'pick features',
        header: 'f',
        multiSelect: true,
        options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
      },
    ]
    shuffleOptions(QM, () => 0) // de-bias the prompt order…
    // …two voters answer in different label orders; answerKey sorts ⇒ they agree.
    const v1 = parseAskVote(
      '{"answers":[{"index":0,"choice":["X","Y"],"reason":"r"}]}',
      QM,
      'a',
      'A',
    )
    const v2 = parseAskVote(
      '{"answers":[{"index":0,"choice":["Y","X"],"reason":"r"}]}',
      QM,
      'b',
      'B',
    )
    const r = tallyQuestion(QM[0], 0, [v1[0], v2[0]])
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('X, Y')
  })

  it('decider upgrade survives a shuffled decider prompt (parse uses original Q)', () => {
    // The decider sees options in shuffled order; its ruling is parsed against Q.
    const shuffled = shuffleOptions(Q, () => 0)
    const split = tallyQuestion(Q[0], 0, [
      { agentId: 'x', agentName: 'x', optionLabels: ['商户端核销'], reason: '' },
      { agentId: 'y', agentName: 'y', optionLabels: ['两端都支持'], reason: '' },
    ])
    const prompt = deciderAskPrompt([split], shuffled)
    expect(prompt).toContain('[0] options:')
    // Decider rules an effective consensus on a label; parse against original Q.
    const { overrides } = parseDeciderAsk(
      '{"summary":"s","questions":[{"index":0,"consensus":true,"choice":"两端都支持"}]}',
      Q,
    )
    expect(overrides.get(0)).toBe('两端都支持')
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

  it('majority off (default): a 2v1 split is not resolved', () => {
    // Explicit majority=false matches the default — no plurality auto-answer.
    const r = tallyQuestion(
      Q[0],
      0,
      [a('x', ['商户端核销']), a('y', ['商户端核销']), a('z', ['两端都支持'])],
      false,
    )
    expect(r.unanimous).toBe(false)
    expect(r.agreed).toBeNull()
    expect(r.decidedByMajority).toBeUndefined()
  })
})

describe('tallyQuestion — majority rule', () => {
  const a = (id: string, labels: string[], abstain = false) => ({
    agentId: id,
    agentName: id,
    optionLabels: labels,
    reason: '',
    ...(abstain ? { abstain: true } : {}),
  })

  it('a literal unanimous vote stays unanimous, not flagged as majority', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', ['商户端核销']), a('y', ['商户端核销'])], true)
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('商户端核销')
    expect(r.decidedByMajority).toBeUndefined()
  })

  it('2v1 single-select: the plurality answer auto-answers (flagged majority)', () => {
    const r = tallyQuestion(
      Q[0],
      0,
      [a('x', ['商户端核销']), a('y', ['商户端核销']), a('z', ['两端都支持'])],
      true,
    )
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('商户端核销')
    expect(r.decidedByMajority).toBe(true)
  })

  it('tie for the top count defers to the human (no clear plurality)', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', ['商户端核销']), a('y', ['两端都支持'])], true)
    expect(r.unanimous).toBe(false)
    expect(r.agreed).toBeNull()
    expect(r.decidedByMajority).toBeUndefined()
  })

  it('multi-select: plurality keys off the sorted-label answerKey', () => {
    // Q[0] reused as multi-select-ish: two voters pick the SAME pair (order
    // differs), one picks a single label ⇒ the pair wins 2v1.
    const r = tallyQuestion(
      Q[0],
      0,
      [
        a('x', ['两端都支持', '商户端核销']),
        a('y', ['商户端核销', '两端都支持']),
        a('z', ['商户端核销']),
      ],
      true,
    )
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('两端都支持, 商户端核销')
    expect(r.decidedByMajority).toBe(true)
  })

  it('excludes abstentions: 2 for A, 1 for B (+1 abstain) ⇒ A wins', () => {
    const r = tallyQuestion(
      Q[0],
      0,
      [a('w', ['商户端核销']), a('x', ['商户端核销']), a('y', ['两端都支持']), a('z', [], true)],
      true,
    )
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('商户端核销')
    expect(r.decidedByMajority).toBe(true)
  })

  it('an abstention that leaves a tie among cast votes defers to the human', () => {
    const r = tallyQuestion(
      Q[0],
      0,
      [a('x', ['商户端核销']), a('y', ['两端都支持']), a('z', [], true)],
      true,
    )
    expect(r.unanimous).toBe(false)
    expect(r.decidedByMajority).toBeUndefined()
  })

  it('all abstain ⇒ no cast vote ⇒ defers to the human', () => {
    const r = tallyQuestion(Q[0], 0, [a('x', [], true), a('y', [], true)], true)
    expect(r.unanimous).toBe(false)
    expect(r.agreed).toBeNull()
    expect(r.decidedByMajority).toBeUndefined()
  })

  it('custom answers tally by their text (a majority of identical customs wins)', () => {
    const custom = (id: string, text: string) => ({
      agentId: id,
      agentName: id,
      optionLabels: [] as string[],
      custom: text,
      reason: '',
    })
    const r = tallyQuestion(
      Q[1],
      1,
      [custom('x', '线上线下都做'), custom('y', '线上线下都做'), a('z', ['复用现有订单支付流程'])],
      true,
    )
    expect(r.unanimous).toBe(true)
    expect(r.agreed).toBe('线上线下都做')
    expect(r.decidedByMajority).toBe(true)
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

  it('defaults the summary language to English', () => {
    const agreed = tallyQuestion(Q[0], 0, [
      { agentId: 'x', agentName: 'x', optionLabels: ['商户端核销'], reason: '' },
    ])
    const prompt = deciderAskPrompt([agreed], Q)
    expect(prompt).toContain('ONE short English sentence')
  })

  it('injects the given Display-language name into the summary instruction', () => {
    const agreed = tallyQuestion(Q[0], 0, [
      { agentId: 'x', agentName: 'x', optionLabels: ['商户端核销'], reason: '' },
    ])
    const prompt = deciderAskPrompt([agreed], Q, 'Chinese (简体中文)')
    expect(prompt).toContain('ONE short Chinese (简体中文) sentence')
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
