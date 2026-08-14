import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { getDiscussionType } from '@ccc/shared/discussion-types'
import type { ResearchStreamItem } from './research.js'

// Mock the SDK runner so `researchDiscussionContext` can be unit-tested without a
// real agent. Each test installs a `runClaudeImpl` that drives `send`/throws.
type SendMsg = {
  type: string
  text?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
  content?: string
  isError?: boolean
  reason?: string
}
interface RunClaudeOpts {
  send: (m: SendMsg) => void
  onSessionId?: (sessionId: string) => void
  signal?: AbortSignal
  currentAgentId?: string
  gate?: string
  disallowedTools?: string[]
  appendSystemPrompt?: string
}
let runClaudeImpl: (opts: RunClaudeOpts) => Promise<void>
/** The options the last `runClaude` call received, for launch-profile assertions. */
let lastRunClaudeOpts: RunClaudeOpts | null = null
vi.mock('../../kernel/agent/index.js', () => ({
  runClaude: (opts: RunClaudeOpts) => {
    lastRunClaudeOpts = opts
    return runClaudeImpl(opts)
  },
}))

// The agent registry is stubbed so `resolveResearchAgent`'s branches are testable
// without real settings; the launch/relay helpers stay REAL — they are no-ops for
// a system-mode agent (no relay candidates, no model override).
vi.mock('../../kernel/agent-config/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../kernel/agent-config/index.js')>()
  return {
    ...original,
    enabledAgents: vi.fn(() => [] as AgentConfig[]),
    resolveAgent: vi.fn(() => original.systemAgent()),
    resolveFirstAgentOfVendor: vi.fn(() => original.systemAgent()),
  }
})

const {
  buildResearchPrompt,
  canAutoStartDiscussion,
  DISCUSSION_RESEARCH_PROMPT,
  researchDiscussionContext,
  resolveResearchAgent,
} = await import('./research.js')
const { enabledAgents, resolveAgent, resolveFirstAgentOfVendor, systemAgent } =
  await import('../../kernel/agent-config/index.js')

describe('buildResearchPrompt', () => {
  const base = {
    goal: 'Decide the cache strategy',
    context: 'We use Redis today',
    workspacePath: '/abs/proj',
  }

  it('includes the type label/description, goal, project path, and user context', () => {
    const p = buildResearchPrompt(base, getDiscussionType('decision'))
    expect(p).toContain('Decision')
    expect(p).toContain('Decide the cache strategy')
    expect(p).toContain('/abs/proj')
    expect(p).toContain('We use Redis today')
  })

  it('notes a missing type and missing context explicitly', () => {
    const p = buildResearchPrompt({ goal: '', context: '   ', workspacePath: '/p' }, undefined)
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
    workspaceName: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'c',
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    organizerAgentId: null,
    conclusion: null,
    metadata: {},
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
    workspaceName: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'USER ORIGINAL CONTEXT',
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    organizerAgentId: null,
    conclusion: null,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }
  // The caller's single agent resolution (the wiring boundary's job); the routine
  // itself never re-resolves.
  const agent = systemAgent()

  it('returns the agent final text as researchResult and never echoes the user context', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: '  RESEARCHED FACTS  ' })
    }
    const res = await researchDiscussionContext(disc, agent)
    expect(res).toEqual({ ok: true, researchResult: 'RESEARCHED FACTS' })
    // The user's original context must not leak into the research output.
    expect(res.researchResult).not.toContain('USER ORIGINAL CONTEXT')
  })

  it('empty agent output yields researchResult "" (not the user context)', async () => {
    runClaudeImpl = async () => {
      /* agent emits nothing */
    }
    const res = await researchDiscussionContext(disc, agent)
    expect(res).toEqual({ ok: true, researchResult: '' })
  })

  it('a thrown run resolves ok=false with empty researchResult', async () => {
    runClaudeImpl = async () => {
      throw new Error('boom')
    }
    const res = await researchDiscussionContext(disc, agent)
    expect(res).toEqual({ ok: false, researchResult: '' })
  })

  it('streams text, tool_use (with input) and tool_result (with output) via onMessage with monotonic seq', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'thinking…' })
      send({ type: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { path: 'a.ts' } })
      send({ type: 'tool_result', toolUseId: 'u1', content: 'file body', isError: false })
      send({ type: 'assistant_text', text: 'FINAL FACTS' })
    }
    const items: ResearchStreamItem[] = []
    const res = await researchDiscussionContext(disc, agent, { onMessage: (m) => items.push(m) })
    // The last assistant turn is still the captured result.
    expect(res).toEqual({ ok: true, researchResult: 'FINAL FACTS' })
    // text + tool_use (input) + tool_result (output) all stream in order, each with its own seq.
    expect(items).toEqual([
      { seq: 1, kind: 'text', text: 'thinking…' },
      { seq: 2, kind: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { path: 'a.ts' } },
      { seq: 3, kind: 'tool_result', toolUseId: 'u1', content: 'file body', isError: false },
      { seq: 4, kind: 'text', text: 'FINAL FACTS' },
    ])
  })

  it('works without an onMessage callback (streaming is optional)', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'X' })
    }
    const res = await researchDiscussionContext(disc, agent)
    expect(res).toEqual({ ok: true, researchResult: 'X' })
  })
})

describe('researchDiscussionContext — the run is a first-class session', () => {
  const disc: Discussion = {
    id: 'd1',
    workspaceName: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'c',
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    organizerAgentId: null,
    conclusion: null,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }
  const agent = systemAgent()

  it('reports the vendor session id so the caller can bind the run to a session', async () => {
    runClaudeImpl = async ({ send, onSessionId }) => {
      onSessionId?.('vsess-1')
      send({ type: 'assistant_text', text: 'FACTS' })
    }
    const seen: string[] = []
    const res = await researchDiscussionContext(disc, agent, {
      onSessionId: (id) => seen.push(id),
    })
    expect(seen).toEqual(['vsess-1'])
    expect(res.researchResult).toBe('FACTS')
  })

  it('fans EVERY raw wire event out in order, alongside the narrower research stream', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'looking…' })
      send({ type: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { path: 'a.ts' } })
      send({ type: 'tool_result', toolUseId: 'u1', content: 'body', isError: false })
      send({ type: 'turn_end', reason: 'complete' })
    }
    const wire: SendMsg[] = []
    const stream: ResearchStreamItem[] = []
    await researchDiscussionContext(disc, agent, {
      onWire: (m) => wire.push(m as SendMsg),
      onMessage: (m) => stream.push(m),
    })
    // The wire channel is the complete run (turn_end included) — it feeds the runtime.
    expect(wire.map((m) => m.type)).toEqual([
      'assistant_text',
      'tool_use',
      'tool_result',
      'turn_end',
    ])
    // The research-stream projection stays as it was: only the three observable kinds.
    expect(stream.map((m) => m.kind)).toEqual(['text', 'tool_use', 'tool_result'])
  })

  it('runs under the caller-supplied signal, so the session status bar Stop reaches it', async () => {
    const abort = new AbortController()
    let sawSignal: AbortSignal | undefined
    runClaudeImpl = async ({ signal }) => {
      sawSignal = signal
      abort.abort()
    }
    await researchDiscussionContext(disc, agent, { signal: abort.signal })
    expect(sawSignal).toBe(abort.signal)
    expect(sawSignal?.aborted).toBe(true)
  })

  it('keeps the read-only launch profile and runs on the resolved claude agent (so a follow-up can resume)', async () => {
    runClaudeImpl = async ({ send }) => {
      send({ type: 'assistant_text', text: 'X' })
    }
    // The caller's single resolution — the same value the wiring boundary freezes
    // onto the session; the routine must launch exactly that agent.
    const resolved = resolveResearchAgent(disc)
    await researchDiscussionContext(disc, resolved)
    expect(lastRunClaudeOpts?.gate).toBe('discussion-research')
    expect(lastRunClaudeOpts?.appendSystemPrompt).toBe(DISCUSSION_RESEARCH_PROMPT)
    expect(lastRunClaudeOpts?.disallowedTools?.length).toBeGreaterThan(0)
    // The bound agent is what the follow-up turn resolves; it must be a claude one.
    expect(resolved.vendor).toBe('claude')
    expect(lastRunClaudeOpts?.currentAgentId).toBe(resolved.id)
  })
})

describe('resolveResearchAgent — organizer-first, with an explicit claude fallback', () => {
  const discussionWith = (organizerAgentId: string | null): Discussion => ({
    id: 'd1',
    workspaceName: '/p',
    title: 'T',
    type: 'decision',
    goal: 'g',
    context: 'c',
    researchResult: '',
    status: 'draft',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    organizerAgentId,
    conclusion: null,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  })
  const claude = (id: string): AgentConfig => ({ ...systemAgent(), id })
  const codex = (id: string): AgentConfig => ({
    ...systemAgent(),
    id,
    vendor: 'codex',
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'responses' },
  })

  beforeEach(() => {
    // Factory-fresh registry defaults; each test narrows what it exercises.
    vi.mocked(enabledAgents).mockReturnValue([])
    vi.mocked(resolveAgent).mockImplementation(() => systemAgent())
    vi.mocked(resolveFirstAgentOfVendor).mockImplementation(() => systemAgent())
  })

  it('a claude organizer IS the research agent — even when it is not the first claude in the pool', () => {
    vi.mocked(enabledAgents).mockReturnValue([claude('claude-first'), claude('claude-org')])
    const agent = resolveResearchAgent(discussionWith('claude-org'))
    expect(agent.id).toBe('claude-org')
    expect(agent.vendor).toBe('claude')
    // The claude fallback must not even be consulted.
    expect(vi.mocked(resolveFirstAgentOfVendor)).not.toHaveBeenCalled()
  })

  it('no organizer ⇒ the global default agent (the orchestration loop criterion)', () => {
    vi.mocked(enabledAgents).mockReturnValue([claude('someone-else')])
    vi.mocked(resolveAgent).mockImplementation((id) =>
      id === null ? claude('claude-default') : systemAgent(),
    )
    expect(resolveResearchAgent(discussionWith(null)).id).toBe('claude-default')
    expect(vi.mocked(resolveFirstAgentOfVendor)).not.toHaveBeenCalled()
  })

  it('no organizer + non-claude default ⇒ the explicit fallback picks the first enabled claude', () => {
    vi.mocked(enabledAgents).mockReturnValue([codex('codex-default'), claude('claude-first')])
    vi.mocked(resolveAgent).mockImplementation((id) =>
      id === null ? codex('codex-default') : systemAgent(),
    )
    vi.mocked(resolveFirstAgentOfVendor).mockReturnValue(claude('claude-first'))
    expect(resolveResearchAgent(discussionWith(null)).id).toBe('claude-first')
    expect(vi.mocked(resolveFirstAgentOfVendor)).toHaveBeenCalledWith('claude')
  })

  it('a non-claude organizer never reaches runClaude — the first enabled claude is selected', () => {
    vi.mocked(enabledAgents).mockReturnValue([codex('codex-org'), claude('claude-first')])
    vi.mocked(resolveFirstAgentOfVendor).mockReturnValue(claude('claude-first'))
    const agent = resolveResearchAgent(discussionWith('codex-org'))
    expect(agent.id).toBe('claude-first')
    expect(agent.vendor).toBe('claude')
    expect(vi.mocked(resolveFirstAgentOfVendor)).toHaveBeenCalledWith('claude')
  })

  it('a non-claude organizer with NO enabled claude ⇒ the built-in system claude agent', () => {
    vi.mocked(enabledAgents).mockReturnValue([codex('codex-org')])
    vi.mocked(resolveAgent).mockImplementation((id) =>
      id === null ? codex('codex-default') : systemAgent(),
    )
    // resolveFirstAgentOfVendor('claude') itself degrades to the non-claude default.
    vi.mocked(resolveFirstAgentOfVendor).mockReturnValue(codex('codex-default'))
    const agent = resolveResearchAgent(discussionWith('codex-org'))
    expect(agent.id).toBe(SYSTEM_AGENT_ID)
    expect(agent.vendor).toBe('claude')
  })

  it('an organizer outside the enabled pool (disabled/unknown) ⇒ the global default agent', () => {
    vi.mocked(enabledAgents).mockReturnValue([])
    vi.mocked(resolveAgent).mockImplementation((id) =>
      id === null ? claude('claude-default') : systemAgent(),
    )
    expect(resolveResearchAgent(discussionWith('ghost')).id).toBe('claude-default')
  })
})
