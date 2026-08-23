/**
 * Ask helpers — `isAskTool` covers BOTH ask tools (Claude AskUserQuestion and
 * Cursor AskQuestion), and `askQuestionsOf` reads the unified normalized shape
 * that Cursor's translator produces.
 */
import { describe, expect, it } from 'vitest'
import { isAskTool, askQuestionsOf } from './ask'

describe('isAskTool', () => {
  it('matches both ask tools', () => {
    expect(isAskTool('AskUserQuestion')).toBe(true)
    expect(isAskTool('AskQuestion')).toBe(true)
  })

  it('rejects ordinary tools and nullish names', () => {
    expect(isAskTool('Edit')).toBe(false)
    expect(isAskTool(null)).toBe(false)
    expect(isAskTool(undefined)).toBe(false)
  })
})

describe('askQuestionsOf', () => {
  it('reads the unified normalized shape a Cursor AskQuestion reaches the UI in', () => {
    const questions = askQuestionsOf({
      questions: [
        {
          question: '部署到生产？',
          header: '',
          multiSelect: false,
          options: [{ label: '是' }, { label: '否' }],
        },
      ],
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({
      question: '部署到生产？',
      multiSelect: false,
      options: [{ label: '是' }, { label: '否' }],
    })
  })

  it('returns [] for a malformed input', () => {
    expect(askQuestionsOf(undefined)).toEqual([])
    expect(askQuestionsOf({ questions: 'nope' })).toEqual([])
  })
})
