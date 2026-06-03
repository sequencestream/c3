import { describe, it, expect } from 'vitest'
import type { Discussion } from '@ccc/shared/protocol'
import { getDiscussionType } from '@ccc/shared/discussion-types'
import {
  buildResearchPrompt,
  canAutoStartDiscussion,
  DISCUSSION_RESEARCH_PROMPT,
} from './research.js'

describe('buildResearchPrompt', () => {
  const base = {
    goal: 'Decide the cache strategy',
    context: 'We use Redis today',
    projectPath: '/abs/proj',
  }

  it('includes the type label/description, goal, project path, and user context', () => {
    const p = buildResearchPrompt(base, getDiscussionType('decision'))
    expect(p).toContain('Decision')
    expect(p).toContain('Decide the cache strategy')
    expect(p).toContain('/abs/proj')
    expect(p).toContain('We use Redis today')
  })

  it('notes a missing type and missing context explicitly', () => {
    const p = buildResearchPrompt({ goal: '', context: '   ', projectPath: '/p' }, undefined)
    expect(p).toContain('(未指定)')
    expect(p).toContain('(未填写)')
    expect(p).toContain('用户未提供初始上下文')
  })

  it('always ends by asking for the completed context only', () => {
    const p = buildResearchPrompt(base, getDiscussionType('brainstorm'))
    expect(p.trimEnd().endsWith('只输出 context 本身)。')).toBe(true)
  })
})

describe('canAutoStartDiscussion', () => {
  const draft: Discussion = {
    id: 'd1',
    projectPath: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'c',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    conclusion: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }

  it('auto-starts a draft with no live run', () => {
    expect(canAutoStartDiscussion(draft, false)).toBe(true)
  })

  it('does not auto-start when a run is already live (manually Started mid-research)', () => {
    expect(canAutoStartDiscussion(draft, true)).toBe(false)
  })

  it('does not auto-start a non-draft (already in_progress / completed / cancelled)', () => {
    expect(canAutoStartDiscussion({ ...draft, status: 'in_progress' }, false)).toBe(false)
    expect(canAutoStartDiscussion({ ...draft, status: 'completed' }, false)).toBe(false)
    expect(canAutoStartDiscussion({ ...draft, status: 'cancelled' }, false)).toBe(false)
  })

  it('does not auto-start a vanished discussion', () => {
    expect(canAutoStartDiscussion(undefined, false)).toBe(false)
  })
})

describe('DISCUSSION_RESEARCH_PROMPT', () => {
  it('no longer asks the researcher to collect 已知方案', () => {
    expect(DISCUSSION_RESEARCH_PROMPT).not.toContain('已知方案')
  })

  it('hard-forbids any 方案/建议/结论 — only 现状', () => {
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('只描述现状')
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('严禁')
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('建议')
  })

  it('still collects 未知点/待澄清项', () => {
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('未知点')
  })
})
