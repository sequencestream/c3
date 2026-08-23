/**
 * Cursor AskQuestion normalization and answer-shaping unit tests. These pin the
 * pure translation layer between Cursor's native `prompt` / `allow_multiple` /
 * `options[].label|id` payload and the unified ask shape the human-answer channel
 * already speaks.
 */
import { describe, expect, it } from 'vitest'
import { askQuestions } from '../../../../consensus-tally.js'
import {
  buildCursorResumePrompt,
  isCursorAskName,
  normalizeCursorAskInput,
  renderAskAnswers,
  validateAskAnswers,
  type NormalizedAskQuestion,
} from './ask.js'

describe('isCursorAskName', () => {
  it('matches the native name case-insensitively, both identity shapes', () => {
    expect(isCursorAskName('askQuestion')).toBe(true)
    expect(isCursorAskName('AskQuestion')).toBe(true)
    expect(isCursorAskName('ASKQUESTION')).toBe(true)
    // Neighbouring names and non-strings stay unmatched.
    expect(isCursorAskName('AskUserQuestion')).toBe(false)
    expect(isCursorAskName('ask')).toBe(false)
    expect(isCursorAskName(undefined)).toBe(false)
  })
})

describe('normalizeCursorAskInput', () => {
  it('maps a single-select question with label/id fallback', () => {
    const r = normalizeCursorAskInput({
      questions: [
        {
          prompt: '部署到生产？',
          allow_multiple: false,
          options: [{ label: '是' }, { id: 'no', label: '否' }, { id: 'only-id' }],
        },
      ],
    })
    expect(r).toEqual({
      ok: true,
      questions: [
        {
          question: '部署到生产？',
          header: '',
          multiSelect: false,
          options: [{ label: '是' }, { label: '否' }, { label: 'only-id' }],
        },
      ],
    })
  })

  it('maps allow_multiple to multiSelect only on the strict boolean true', () => {
    const cases: [unknown, boolean][] = [
      [true, true],
      ['true', false],
      [1, false],
      [undefined, false],
    ]
    for (const [value, expected] of cases) {
      const r = normalizeCursorAskInput({
        questions: [{ prompt: '多选', allow_multiple: value, options: [{ label: 'a' }] }],
      })
      expect(r.ok && r.questions[0]?.multiSelect).toBe(expected)
    }
  })

  it('keeps an empty options array usable — a custom reply still works', () => {
    const r = normalizeCursorAskInput({ questions: [{ prompt: '随便说点什么', options: [] }] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.questions[0]?.options).toEqual([])
  })

  it('ignores invalid option entries and keeps string descriptions', () => {
    const r = normalizeCursorAskInput({
      questions: [
        {
          prompt: '选一个',
          options: [
            { label: '好', description: '推荐' },
            { label: '' },
            { id: '' },
            null,
            { description: '没有 label' },
            'oops',
          ],
        },
      ],
    })
    expect(r).toEqual({
      ok: true,
      questions: [
        {
          question: '选一个',
          header: '',
          multiSelect: false,
          options: [{ label: '好', description: '推荐' }],
        },
      ],
    })
  })

  it('uses a header/title as the displayable identifier, else empty', () => {
    const withHeader = normalizeCursorAskInput({
      questions: [{ prompt: '继续吗', header: '下一步', options: [{ label: '继续' }] }],
    })
    expect(withHeader.ok && withHeader.questions[0]?.header).toBe('下一步')
    const without = normalizeCursorAskInput({
      questions: [{ prompt: '继续吗', options: [{ label: '继续' }] }],
    })
    expect(without.ok && without.questions[0]?.header).toBe('')
  })

  it('fails on missing or empty questions', () => {
    expect(normalizeCursorAskInput({}).ok).toBe(false)
    expect(normalizeCursorAskInput({ questions: [] }).ok).toBe(false)
    expect(normalizeCursorAskInput(null).ok).toBe(false)
  })

  it('fails on a question without a non-empty prompt', () => {
    const r = normalizeCursorAskInput({
      questions: [{ allow_multiple: false, options: [{ label: 'a' }] }],
    })
    expect(r.ok).toBe(false)
  })

  it('fails on a question with a non-array options', () => {
    const r = normalizeCursorAskInput({
      questions: [{ prompt: 'p', options: 'not-an-array' }],
    })
    expect(r.ok).toBe(false)
  })

  it('fails on duplicate question text', () => {
    const r = normalizeCursorAskInput({
      questions: [
        { prompt: '重复', options: [{ label: 'a' }] },
        { prompt: '重复', options: [{ label: 'b' }] },
      ],
    })
    expect(r.ok).toBe(false)
  })

  it('produces input the server askQuestions() consumes', () => {
    const r = normalizeCursorAskInput({
      questions: [
        { prompt: 'q1', options: [{ label: 'a' }] },
        { prompt: 'q2', allow_multiple: true, options: [{ label: 'b' }, { label: 'c' }] },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const consumed = askQuestions({ questions: r.questions })
      expect(consumed).toHaveLength(2)
      expect(consumed?.[1]?.multiSelect).toBe(true)
      expect(consumed?.[0]?.options[0]?.label).toBe('a')
    }
  })
})

describe('validateAskAnswers', () => {
  const questions: NormalizedAskQuestion[] = [
    { question: 'q1', header: '', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'q2', header: '', multiSelect: false, options: [] },
  ]

  it('accepts a complete answer set', () => {
    expect(validateAskAnswers(questions, { q1: 'a', q2: '自定义' })).toEqual({ ok: true })
  })

  it('rejects a missing or empty answer for any question', () => {
    expect(validateAskAnswers(questions, { q1: 'a' }).ok).toBe(false)
    expect(validateAskAnswers(questions, { q1: 'a', q2: '' }).ok).toBe(false)
    expect(validateAskAnswers(questions, { q1: 'a', q2: '   ' }).ok).toBe(false)
  })

  it('rejects a non-object answers payload', () => {
    expect(validateAskAnswers(questions, undefined).ok).toBe(false)
    expect(validateAskAnswers(questions, [] as unknown as Record<string, string>).ok).toBe(false)
  })
})

describe('buildCursorResumePrompt', () => {
  it('lists each original question with its answer and frames it as an answer', () => {
    const prompt = buildCursorResumePrompt(
      [{ question: 'q1', header: '', multiSelect: false, options: [{ label: 'a' }] }],
      { q1: 'a' },
    )
    expect(prompt).toContain('q1')
    expect(prompt).toContain('答：a')
  })
})

describe('renderAskAnswers', () => {
  it('renders readable question/answer pairs', () => {
    const text = renderAskAnswers(
      [
        { question: 'q1', header: '', multiSelect: false, options: [{ label: 'a' }] },
        { question: 'q2', header: '', multiSelect: false, options: [] },
      ],
      { q1: 'a', q2: '自定义' },
    )
    expect(text).toContain('问：q1')
    expect(text).toContain('答：a')
    expect(text).toContain('问：q2')
    expect(text).toContain('答：自定义')
  })
})
