import { describe, it, expect, vi } from 'vitest'
import type { Discussion } from '@ccc/shared/protocol'
import { getDiscussionType } from '@ccc/shared/discussion-types'

// Mock the SDK runner so `researchDiscussionContext` can be unit-tested without a
// real agent. Each test installs a `runClaudeImpl` that drives `send`/throws.
type SendMsg = { type: string; text?: string; toolName?: string }
let runClaudeImpl: (opts: { send: (m: SendMsg) => void }) => Promise<void>
vi.mock('../../kernel/agent/index.js', () => ({
  runClaude: (opts: { send: (m: SendMsg) => void }) => runClaudeImpl(opts),
}))

const {
  buildResearchPrompt,
  canAutoStartDiscussion,
  DISCUSSION_RESEARCH_PROMPT,
  researchDiscussionContext,
} = await import('./research.js')

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
    expect(p).toContain('(unspecified)')
    expect(p).toContain('(not provided)')
    expect(p).toContain('The user provided no initial context')
  })

  it('always ends by asking for the research findings and appends Respond in instruction', () => {
    const p = buildResearchPrompt(base, getDiscussionType('brainstorm'))
    expect(p).toContain('(output the findings only)')
    expect(p.trimEnd().endsWith('Respond in English.')).toBe(true)
  })

  it('buildResearchPrompt with langName includes the correct Respond in instruction', () => {
    const p = buildResearchPrompt(base, getDiscussionType('brainstorm'), 'Chinese (简体中文)')
    expect(p).toContain('Respond in Chinese (简体中文)')
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
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
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
  it('frames the output as research findings, not a completed-context rewrite', () => {
    // The output is its own `researchResult` field, not a rewrite of the user's
    // context — the copy must say "research", never the old 补全/context-正文 framing.
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('research findings')
    expect(DISCUSSION_RESEARCH_PROMPT).not.toContain('补全')
  })

  it('hard-forbids any options/recommendations/conclusions — current state only', () => {
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('current state only')
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('do NOT')
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('recommendations')
  })

  it('still collects open questions / points to clarify', () => {
    expect(DISCUSSION_RESEARCH_PROMPT).toContain('open questions')
  })
})

describe('researchDiscussionContext', () => {
  const disc: Discussion = {
    id: 'd1',
    projectPath: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'USER ORIGINAL CONTEXT',
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    conclusion: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }

  it('returns the agent final text as researchResult and never echoes the user context', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: '  RESEARCHED FACTS  ' })
    }
    const res = await researchDiscussionContext(disc)
    expect(res).toEqual({ ok: true, researchResult: 'RESEARCHED FACTS' })
    // The user's original context must not leak into the research output.
    expect(res.researchResult).not.toContain('USER ORIGINAL CONTEXT')
  })

  it('empty agent output yields researchResult "" (not the user context)', async () => {
    runClaudeImpl = async () => {
      /* agent emits nothing */
    }
    const res = await researchDiscussionContext(disc)
    expect(res).toEqual({ ok: true, researchResult: '' })
  })

  it('a thrown run resolves ok=false with empty researchResult', async () => {
    runClaudeImpl = async () => {
      throw new Error('boom')
    }
    const res = await researchDiscussionContext(disc)
    expect(res).toEqual({ ok: false, researchResult: '' })
  })

  it('streams each assistant turn and tool call via onMessage with monotonic seq', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'thinking…' })
      send({ type: 'tool_use', toolName: 'Read' })
      send({ type: 'tool_result' }) // ignored — not an observable research turn
      send({ type: 'assistant_text', text: 'FINAL FACTS' })
    }
    const items: { seq: number; kind: string; content: string }[] = []
    const res = await researchDiscussionContext(disc, { onMessage: (m) => items.push(m) })
    // The last assistant turn is still the captured result.
    expect(res).toEqual({ ok: true, researchResult: 'FINAL FACTS' })
    // text + tool turns stream in order; tool_result is not streamed.
    expect(items).toEqual([
      { seq: 1, kind: 'text', content: 'thinking…' },
      { seq: 2, kind: 'tool', content: 'Read' },
      { seq: 3, kind: 'text', content: 'FINAL FACTS' },
    ])
  })

  it('works without an onMessage callback (streaming is optional)', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'X' })
    }
    const res = await researchDiscussionContext(disc)
    expect(res).toEqual({ ok: true, researchResult: 'X' })
  })
})
