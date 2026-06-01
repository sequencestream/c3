import { describe, it, expect } from 'vitest'
import {
  DISCUSSION_TYPES,
  DISCUSSION_STAGE_ORDER,
  listDiscussionTypes,
  getDiscussionType,
  isDiscussionType,
  discussionWorkflow,
  nextDiscussionStage,
} from './discussion-types.js'

describe('discussion type catalog', () => {
  it('is non-empty and exposes the common types', () => {
    const ids = DISCUSSION_TYPES.map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining(['brainstorm', 'decision', 'review', 'planning', 'retro']),
    )
    expect(listDiscussionTypes()).toBe(DISCUSSION_TYPES)
  })

  it('has unique type ids and non-empty labels/descriptions', () => {
    const ids = DISCUSSION_TYPES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of DISCUSSION_TYPES) {
      expect(t.label).not.toBe('')
      expect(t.description).not.toBe('')
    }
  })

  it('every workflow carries the four canonical stages in order, each with a prompt', () => {
    for (const t of DISCUSSION_TYPES) {
      expect(t.workflow.map((s) => s.id)).toEqual([...DISCUSSION_STAGE_ORDER])
      const stageIds = t.workflow.map((s) => s.id)
      expect(new Set(stageIds).size).toBe(stageIds.length)
      for (const s of t.workflow) {
        expect(s.label).not.toBe('')
        expect(s.prompt.trim()).not.toBe('')
      }
    }
  })

  it('prompts differ across types for the same stage (data-driven, not boilerplate)', () => {
    const concludePrompts = DISCUSSION_TYPES.map(
      (t) => t.workflow.find((s) => s.id === 'conclude')!.prompt,
    )
    expect(new Set(concludePrompts).size).toBe(concludePrompts.length)
  })
})

describe('lookup helpers', () => {
  it('getDiscussionType / isDiscussionType resolve known and reject unknown', () => {
    expect(getDiscussionType('brainstorm')?.id).toBe('brainstorm')
    expect(getDiscussionType('nope')).toBeUndefined()
    expect(isDiscussionType('decision')).toBe(true)
    expect(isDiscussionType('')).toBe(false)
    expect(isDiscussionType('nope')).toBe(false)
  })

  it('discussionWorkflow returns the stages, or [] for unknown', () => {
    expect(discussionWorkflow('review')).toHaveLength(4)
    expect(discussionWorkflow('nope')).toEqual([])
  })
})

describe('nextDiscussionStage', () => {
  it('returns the first stage as the entry point', () => {
    expect(nextDiscussionStage('brainstorm')?.id).toBe('discuss')
  })

  it('advances through the workflow and ends after conclude', () => {
    expect(nextDiscussionStage('brainstorm', 'discuss')?.id).toBe('summarize')
    expect(nextDiscussionStage('brainstorm', 'summarize')?.id).toBe('confirm')
    expect(nextDiscussionStage('brainstorm', 'confirm')?.id).toBe('conclude')
    expect(nextDiscussionStage('brainstorm', 'conclude')).toBeUndefined()
  })

  it('returns undefined for an unknown type', () => {
    expect(nextDiscussionStage('nope')).toBeUndefined()
    expect(nextDiscussionStage('nope', 'discuss')).toBeUndefined()
  })
})
