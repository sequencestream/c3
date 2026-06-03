import { describe, it, expect } from 'vitest'
import { getDiscussionType } from '@ccc/shared/discussion-types'
import { buildResearchPrompt, DISCUSSION_RESEARCH_PROMPT } from './research.js'

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
