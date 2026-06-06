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
 * live `canUseTool` closure itself is e2e-only — see `requirement-gate.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Per-call advisor outputs, consumed in call order: voter A, voter B, decider.
const responses = vi.hoisted(() => ({ queue: [] as Array<{ text: string } | { throw: true }> }))

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

const agent = (id: string) => ({
  id,
  vendor: 'claude' as const,
  displayName: id.toUpperCase(),
  config: { baseUrl: '', apiKey: '', model: '' },
})

vi.mock('./kernel/agent-config/index.js', () => ({
  consensusVoters: () => [agent('a'), agent('b')],
  vendorScopedVoters: () => ({
    voters: [agent('a'), agent('b')],
    vendorScope: 'claude',
    crossVendorExcluded: 0,
  }),
  launchForAgent: () => ({}),
  resolveAgent: () => agent('decider'),
}))
vi.mock('./kernel/config/index.js', () => ({
  isConsensusEnabled: () => true,
  // Ask path never reads this; stubbed so the allow/deny tool path (which does)
  // doesn't hit an undefined import. The majority decision matrix itself is
  // covered exhaustively in consensus-tally.test.ts.
  isConsensusMajorityEnabled: () => false,
}))

import { runAskConsensus } from './consensus.js'

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
  cwd: '/ws',
  signal: new AbortController().signal,
})

const voteFor = (label: string) => ({
  text: JSON.stringify({ answers: [{ index: 0, choice: label, reason: 'because' }] }),
})

describe('runAskConsensus — fail-safe to human', () => {
  beforeEach(() => {
    responses.queue = []
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
})
