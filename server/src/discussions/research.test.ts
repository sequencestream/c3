import { describe, it, expect } from 'vitest'
import { getDiscussionType } from '@ccc/shared/discussion-types'
import { buildResearchPrompt } from './research.js'

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
