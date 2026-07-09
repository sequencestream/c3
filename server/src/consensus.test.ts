/**
 * Consensus orchestration — the AskUserQuestion race surface.
 *
 * The bug: a non-unanimous (or failing) consensus pass must defer to the human
 * answer panel — it must NEVER auto-answer on the user's behalf, and an advisor
 * query that errors/aborts must NOT throw into the main run's `canUseTool`
 * (which would tear the turn down and drop the un-answered prompt).
 *
 * `consensus-tally.ts` (pure parse/tally) is covered separately; here we drive the
 * real `runAskConsensus` with the SDK `query` and settings mocked, so the
 * orchestration's fail-safe-to-human contract is pinned deterministically (the
 * live `canUseTool` closure itself is e2e-only — see `intent-gate.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Per-call advisor outputs, consumed in call order: voter A, voter B, decider.
const responses = vi.hoisted(() => ({ queue: [] as Array<{ text: string } | { throw: true }> }))
// Toggle for the majority rule, flipped per test (mirrors the system setting).
const settings = vi.hoisted(() => ({ majority: false }))
// Voter ids, overridable per test (default two; the majority case needs three).
const roster = vi.hoisted(() => ({ ids: ['a', 'b'] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const next = responses.queue.shift()
    return {
      async *[Symbol.asyncIterator]() {
        if (!next || 'throw' in next) throw new Error('advisor query failed')
        yield { type: 'assistant', message: { content: [{ type: 'text', text: next.text }] } }
        yield { type: 'result' }
      },
      interrupt: () => Promise.resolve(),
    }
  },
}))

vi.mock('./kernel/infra/child-env.js', () => ({ findClaudeExecutable: () => undefined }))

// A voter's vendor is derived from its id prefix (`cx…` ⇒ codex) so a test can
// build a cross-vendor roster just by naming ids. The requesting session's own
// agent (`decider`) is always claude — its vendor drives the risk normalizer.
const agent = (id: string) => ({
  id,
  vendor: (id.startsWith('cx') ? 'codex' : 'claude') as 'claude' | 'codex',
  displayName: id.toUpperCase(),
  config: { baseUrl: '', apiKey: '', model: '' },
})

vi.mock('./kernel/agent-config/index.js', () => ({
  selectConsensusVoters: () => roster.ids.map(agent),
  launchForAgent: () => ({}),
  resolveAgent: () => agent('decider'),
}))
vi.mock('./kernel/config/index.js', () => ({
  isConsensusEnabled: (_workspacePath?: string) => true,
  // Voter-selection config snapshot; the voter mock ignores it, so `all`/undefined
  // is sufficient (custom narrowing is unit-tested in settings.test.ts).
  getConsensusConfig: (_workspacePath?: string) => undefined,
  // Driven by `settings.majority` so a test can exercise the ask path's majority
  // pre-step coexisting with the decider. The per-question decision matrix itself
  // is covered exhaustively in consensus-tally.test.ts.
  isConsensusMajorityEnabled: (_workspacePath?: string) => settings.majority,
  // Summary language name injected into the decider prompt; fixed here since the
  // prompt's language wiring is asserted in consensus-tally.test.ts.
  getUiLangName: () => 'English',
}))

import { runAskConsensus, runConsensusVote } from './consensus.js'

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Pick one',
      header: 'H',
      multiSelect: false,
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    },
  ],
}

const params = () => ({
  currentAgentId: 'decider',
  toolName: 'AskUserQuestion',
  input: QUESTION_INPUT,
  context: 'ctx',
  // Config read keys off `workspacePath`; advisor queries launch in `cwd`. Kept
  // distinct so a regression that collapses one onto the other is visible.
  workspacePath: '/ws',
  cwd: '/ws/worktrees/intent-1',
  signal: new AbortController().signal,
})

const voteFor = (label: string) => ({
  text: JSON.stringify({ answers: [{ index: 0, choice: label, reason: 'because' }] }),
})

describe('runAskConsensus — fail-safe to human', () => {
  beforeEach(() => {
    responses.queue = []
    settings.majority = false
    roster.ids = ['a', 'b']
  })

  it('defers to the human (not fullyUnanimous) when the voters disagree', async () => {
    // Voter A → Alpha, voter B → Beta, decider issues no upgrade ⇒ split stands.
    responses.queue = [voteFor('Alpha'), voteFor('Beta'), { text: 'no consensus' }]
    const out = await runAskConsensus(params())
    expect(out).not.toBeNull()
    expect(out!.fullyUnanimous).toBe(false)
    expect(out!.perQuestion[0].unanimous).toBe(false)
    expect(out!.agreedAnswers).toEqual({})
  })

  it('an advisor query that throws abstains — it cannot auto-answer or throw out', async () => {
    // Voter A answers, voter B's query throws (⇒ abstain), decider summarizes.
    responses.queue = [voteFor('Alpha'), { throw: true }, { text: 'one abstained' }]
    let out
    // The key assertion: runAskConsensus resolves (never rejects into canUseTool).
    await expect(
      (async () => {
        out = await runAskConsensus(params())
      })(),
    ).resolves.toBeUndefined()
    expect(out!.fullyUnanimous).toBe(false)
  })

  it('returns null (caller shows the plain panel) when the input carries no questions', async () => {
    const out = await runAskConsensus({ ...params(), input: { questions: [] } })
    expect(out).toBeNull()
  })

  it('majority pre-step and decider coexist without re-judging the same question', async () => {
    // Three voters, two questions:
    //   Q0 (2 options): a/b → Alpha, c → Beta  ⇒ 2v1 plurality ⇒ majority resolves it.
    //   Q1 (3 options): a→X, b→Y, c→Z          ⇒ 3-way tie ⇒ no majority ⇒ decider rescues.
    settings.majority = true
    roster.ids = ['a', 'b', 'c']
    const input = {
      questions: [
        {
          question: 'Pick one',
          header: 'H0',
          multiSelect: false,
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
        {
          question: 'Pick another',
          header: 'H1',
          multiSelect: false,
          options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
        },
      ],
    }
    const vote = (q0: string, q1: string) => ({
      text: JSON.stringify({
        answers: [
          { index: 0, choice: q0, reason: 'r' },
          { index: 1, choice: q1, reason: 'r' },
        ],
      }),
    })
    // Voter order a, b, c then the decider, which upgrades only the still-split Q1.
    responses.queue = [
      vote('Alpha', 'X'),
      vote('Alpha', 'Y'),
      vote('Beta', 'Z'),
      {
        text: JSON.stringify({
          summary: 's',
          questions: [{ index: 1, consensus: true, choice: 'X' }],
        }),
      },
    ]

    const out = await runAskConsensus({ ...params(), input })
    expect(out).not.toBeNull()
    const [q0, q1] = out!.perQuestion

    // Q0: carried by the deterministic majority pre-step (NOT a decider ruling).
    expect(q0.unanimous).toBe(true)
    expect(q0.agreed).toBe('Alpha')
    expect(q0.decidedByMajority).toBe(true)
    expect(q0.decidedByAgent).toBeUndefined()

    // Q1: the majority pass left it split (3-way tie), so the decider rescued it —
    // proving the two paths coexist and never double-adjudicate the same question.
    expect(q1.unanimous).toBe(true)
    expect(q1.agreed).toBe('X')
    expect(q1.decidedByAgent).toBe(true)
    expect(q1.decidedByMajority).toBeUndefined()

    expect(out!.fullyUnanimous).toBe(true)
    expect(out!.agreedAnswers).toEqual({ 'Pick one': 'Alpha', 'Pick another': 'X' })
  })
})

describe('runConsensusVote — cross-vendor tool voting + risk normalization', () => {
  beforeEach(() => {
    responses.queue = []
    settings.majority = false
    roster.ids = ['a', 'cx1'] // one claude voter + one codex voter (cross-vendor)
  })

  const toolParams = (toolName: string, input: unknown) => ({
    currentAgentId: 'decider', // claude session ⇒ claude native tool names normalize
    toolName,
    input,
    context: 'ctx',
    // Config key vs. advisor cwd, kept distinct (see `params` above).
    workspacePath: '/ws',
    cwd: '/ws/worktrees/intent-1',
    signal: new AbortController().signal,
  })

  const allowVote = { text: JSON.stringify({ decision: 'allow', reason: 'safe' }) }
  const denyVote = { text: JSON.stringify({ decision: 'deny', reason: 'risky' }) }

  it('cross-vendor voters unanimously ALLOW a normalized high-risk write ⇒ auto-allow', async () => {
    // Both voters allow, then the decider summarizes.
    responses.queue = [allowVote, allowVote, { text: 'all allowed' }]
    const out = await runConsensusVote(toolParams('Write', { file_path: '/ws/a.ts', content: 'x' }))
    expect(out).not.toBeNull()
    expect(out!.decision).toBe('allow')
    expect(out!.unanimous).toBe(true)
    // The normalized payload rode the outcome; voters carry their vendors.
    expect(out!.normalized?.operationIntent).toContain('write-file')
    expect(out!.normalizationFailure).toBeUndefined()
    expect(out!.votes.map((v) => v.vendor).sort()).toEqual(['claude', 'codex'])
  })

  it('cross-vendor voters unanimously DENY a normalized execute request ⇒ auto-deny', async () => {
    responses.queue = [denyVote, denyVote, { text: 'all denied' }]
    const out = await runConsensusVote(toolParams('Bash', { command: 'rm -rf /' }))
    expect(out!.decision).toBe('deny')
    expect(out!.unanimous).toBe(true)
    expect(out!.normalized?.risks.execute).toBe(true)
  })

  it('a split cross-vendor vote defers to the human (no decision)', async () => {
    responses.queue = [allowVote, denyVote, { text: 'split' }]
    const out = await runConsensusVote(toolParams('Write', { file_path: '/ws/a.ts', content: 'x' }))
    expect(out!.decision).toBeNull()
    expect(out!.unanimous).toBe(false)
  })

  it('a majority carries the decision when the toggle is on', async () => {
    settings.majority = true
    roster.ids = ['a', 'cx1', 'cx2'] // 2 codex + 1 claude
    // 2 allow, 1 deny ⇒ strict majority allow.
    responses.queue = [allowVote, allowVote, denyVote, { text: 'majority allow' }]
    const out = await runConsensusVote(toolParams('Write', { file_path: '/ws/a.ts', content: 'x' }))
    expect(out!.decision).toBe('allow')
    expect(out!.unanimous).toBe(false) // carried by majority, not literal unanimity
  })

  it('a request that cannot be normalized abstains every voter and defers to human', async () => {
    // No advisor calls should be made — the queue stays untouched.
    responses.queue = []
    const out = await runConsensusVote(toolParams('mcp__unknown__do', { anything: 1 }))
    expect(out).not.toBeNull()
    expect(out!.decision).toBeNull() // never auto-allows on normalization failure
    expect(out!.normalizationFailure).toBe('unknown-tool')
    expect(out!.normalized).toBeUndefined()
    expect(out!.votes).toHaveLength(2)
    expect(out!.votes.every((v) => v.decision === 'abstain')).toBe(true)
    expect(out!.votes.map((v) => v.vendor).sort()).toEqual(['claude', 'codex'])
    expect(responses.queue).toHaveLength(0) // confirms no advisor query fired
  })

  it('a missing-target normalization failure also abstains, never auto-allows', async () => {
    const out = await runConsensusVote(toolParams('Write', { content: 'no path' }))
    expect(out!.decision).toBeNull()
    expect(out!.normalizationFailure).toBe('missing-target')
  })

  it('returns null (defers to plain human prompt) when there are no voters', async () => {
    roster.ids = []
    const out = await runConsensusVote(toolParams('Write', { file_path: '/ws/a.ts', content: 'x' }))
    expect(out).toBeNull()
  })
})
