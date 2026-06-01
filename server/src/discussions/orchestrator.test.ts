/**
 * Unit tests for the discussion orchestration loop, driven entirely by fakes
 * (a scripted `ask`, an in-memory store, capture hooks). Covers: the happy path
 * across all four workflow stages with status transitions + streamed messages +
 * a written conclusion; the single-agent degenerate path; mid-run abort leaving
 * the discussion `in_progress`; the total-round-cap fallback conclusion; the
 * pause gate (suspend at the round boundary → no new speech → resume to finish);
 * and a fresh post-conclusion round driven to a new conclusion (the `continue`
 * path: append a human question, flip back to in_progress, re-run the engine).
 */
import { describe, expect, it } from 'vitest'
import type { AgentConfig, Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import { runDiscussion, type DiscussionDeps, type DiscussionStore } from './orchestrator.js'

const agent = (id: string, name: string): AgentConfig => ({
  id,
  name,
  baseUrl: '',
  apiKey: '',
  model: '',
})

function makeStore(seed: Discussion): {
  store: DiscussionStore
  messages: DiscussionMessage[]
  get: () => Discussion
} {
  const discussions = new Map<string, Discussion>([[seed.id, { ...seed }]])
  const messages: DiscussionMessage[] = []
  let seq = 0
  const store: DiscussionStore = {
    getDiscussion: (id) => discussions.get(id) ?? null,
    listMessages: (did) => messages.filter((m) => m.discussionId === did),
    appendMessage: (input) => {
      seq += 1
      const m: DiscussionMessage = {
        id: `m${seq}`,
        discussionId: input.discussionId,
        seq,
        speakerKind: input.speakerKind,
        speakerAgentId: input.speakerAgentId ?? null,
        speakerName: input.speakerName ?? null,
        content: input.content,
        createdAt: seq,
      }
      messages.push(m)
      return m
    },
    setConclusion: (id, c) => {
      const d = discussions.get(id)
      if (d) d.conclusion = c
    },
    updateDiscussionStatus: (id, s) => {
      const d = discussions.get(id)
      if (d) d.status = s
    },
  }
  return { store, messages, get: () => discussions.get(seed.id)! }
}

const seedDiscussion = (): Discussion => ({
  id: 'd1',
  projectPath: '/abs/proj',
  title: 'Pick a cache',
  type: 'decision',
  goal: 'Choose a caching layer',
  context: '',
  status: 'draft',
  conclusion: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
})

const isOrganizerPrompt = (p: string): boolean => p.includes('组织者(organizer)')

interface Harness {
  deps: DiscussionDeps
  statusChanges: string[]
  streamed: DiscussionMessage[]
}

function harness(opts: {
  store: DiscussionStore
  participants: AgentConfig[]
  organizer: AgentConfig
  organizerScript: string[]
  participantReply?: string
  maxTotalRounds?: number
  signal?: AbortSignal
  onOrganizerCall?: () => void
}): Harness {
  const statusChanges: string[] = []
  const streamed: DiscussionMessage[] = []
  const queue = [...opts.organizerScript]
  const deps: DiscussionDeps = {
    ask: async (_a, prompt) => {
      if (isOrganizerPrompt(prompt)) {
        opts.onOrganizerCall?.()
        return queue.shift() ?? '{"action":"conclude","conclusion":"(fallback)"}'
      }
      return opts.participantReply ?? 'a participant view'
    },
    store: opts.store,
    organizer: () => opts.organizer,
    participants: () => opts.participants,
    onMessage: (m) => streamed.push(m),
    onStatusChange: (id) => statusChanges.push(id),
    ...(opts.maxTotalRounds !== undefined ? { maxTotalRounds: opts.maxTotalRounds } : {}),
  }
  return { deps, statusChanges, streamed }
}

describe('runDiscussion', () => {
  it('drives a discussion through the workflow to a written conclusion', async () => {
    const { store, messages, get } = makeStore(seedDiscussion())
    const participants = [agent('system', 'System'), agent('gpt', 'GPT')]
    const h = harness({
      store,
      participants,
      organizer: agent('system', 'System'),
      organizerScript: [
        '{"action":"speak","speaker":"gpt","note":""}', // discuss: let GPT speak
        '{"action":"advance","note":"两个候选方案"}', // discuss → summarize (with summary)
        '{"action":"advance","note":""}', // summarize → confirm
        '{"action":"advance","note":""}', // confirm → conclude
        '{"action":"conclude","conclusion":"Use Redis."}', // conclude stage
      ],
      participantReply: 'GPT 倾向 Redis',
    })

    await runDiscussion('d1', new AbortController().signal, h.deps)

    expect(get().status).toBe('completed')
    expect(get().conclusion).toBe('Use Redis.')
    // The agent spoke, the organizer's summary was recorded, the conclusion is last.
    expect(messages.some((m) => m.speakerKind === 'agent' && m.content === 'GPT 倾向 Redis')).toBe(
      true,
    )
    expect(
      messages.some((m) => m.speakerKind === 'organizer' && m.content === '两个候选方案'),
    ).toBe(true)
    expect(messages[messages.length - 1]).toMatchObject({
      speakerKind: 'organizer',
      content: 'Use Redis.',
    })
    // Every appended message was streamed; status flipped in_progress then completed.
    expect(h.streamed.map((m) => m.id)).toEqual(messages.map((m) => m.id))
    expect(h.statusChanges).toEqual(['d1', 'd1'])
  })

  it('degenerates gracefully to a single configured agent', async () => {
    const { store, messages, get } = makeStore(seedDiscussion())
    const solo = agent('solo', 'Solo')
    const h = harness({
      store,
      participants: [solo],
      organizer: solo,
      organizerScript: [
        '{"action":"speak","speaker":"solo","note":""}',
        '{"action":"conclude","conclusion":"Done solo."}',
      ],
      participantReply: 'Solo 的观点',
    })

    await runDiscussion('d1', new AbortController().signal, h.deps)

    expect(get().status).toBe('completed')
    expect(get().conclusion).toBe('Done solo.')
    expect(messages.some((m) => m.speakerKind === 'agent' && m.speakerName === 'Solo')).toBe(true)
  })

  it('leaves the discussion in_progress when aborted mid-run', async () => {
    const { store, get } = makeStore(seedDiscussion())
    const controller = new AbortController()
    const h = harness({
      store,
      participants: [agent('system', 'System'), agent('gpt', 'GPT')],
      organizer: agent('system', 'System'),
      organizerScript: ['{"action":"speak","speaker":"gpt","note":""}'],
      onOrganizerCall: () => controller.abort(),
    })

    await runDiscussion('d1', controller.signal, h.deps)

    expect(get().status).toBe('in_progress')
    expect(get().conclusion).toBeNull()
  })

  it('writes a fallback conclusion when the total round cap is hit', async () => {
    const { store, messages, get } = makeStore(seedDiscussion())
    const h = harness({
      store,
      participants: [agent('system', 'System'), agent('gpt', 'GPT')],
      organizer: agent('system', 'System'),
      // The organizer never concludes; the cap must force a finish.
      organizerScript: [],
      participantReply: 'view',
      maxTotalRounds: 2,
      // empty script → harness returns speak? no: default is conclude. Override below.
    })
    // Replace the ask with a never-concluding organizer for this case.
    h.deps.ask = async (_a, prompt) =>
      isOrganizerPrompt(prompt) ? '{"action":"speak","speaker":"gpt","note":""}' : 'view'

    await runDiscussion('d1', new AbortController().signal, h.deps)

    expect(get().status).toBe('completed')
    expect(get().conclusion).toContain('轮数上限')
    expect(messages.filter((m) => m.speakerKind === 'agent').length).toBe(2)
  })

  it('suspends at the gate while paused and resumes to completion', async () => {
    const { store, messages, get } = makeStore(seedDiscussion())
    const h = harness({
      store,
      participants: [agent('system', 'System'), agent('gpt', 'GPT')],
      organizer: agent('system', 'System'),
      organizerScript: ['{"action":"conclude","conclusion":"Done."}'],
    })
    // A gate that blocks the very first round until released — the engine has
    // flipped to in_progress but must not ask the organizer or append anything.
    let release: () => void = () => {}
    const gated = new Promise<void>((r) => {
      release = r
    })
    let gateCalls = 0
    h.deps.gate = async () => {
      gateCalls += 1
      if (gateCalls === 1) await gated
    }

    const done = runDiscussion('d1', new AbortController().signal, h.deps)
    await Promise.resolve()
    await Promise.resolve()
    // Paused at the round boundary: status flipped, but no speech happened.
    expect(get().status).toBe('in_progress')
    expect(messages.length).toBe(0)
    expect(h.streamed.length).toBe(0)

    release()
    await done
    expect(get().status).toBe('completed')
    expect(get().conclusion).toBe('Done.')
  })

  it('drives a fresh round to a new conclusion after completion', async () => {
    const { store, messages, get } = makeStore(seedDiscussion())
    const participants = [agent('system', 'System')]

    // Round 1 → first conclusion.
    const h1 = harness({
      store,
      participants,
      organizer: agent('system', 'System'),
      organizerScript: ['{"action":"conclude","conclusion":"First."}'],
    })
    await runDiscussion('d1', new AbortController().signal, h1.deps)
    expect(get().status).toBe('completed')
    expect(get().conclusion).toBe('First.')

    // Simulate `continue_discussion`: append the human question + flip back to
    // in_progress, then re-run the engine over the grown transcript.
    store.appendMessage({
      discussionId: 'd1',
      speakerKind: 'human',
      speakerName: 'Human',
      content: 'What about X?',
    })
    store.updateDiscussionStatus('d1', 'in_progress')
    const before = messages.length

    const h2 = harness({
      store,
      participants,
      organizer: agent('system', 'System'),
      organizerScript: ['{"action":"conclude","conclusion":"Second."}'],
    })
    await runDiscussion('d1', new AbortController().signal, h2.deps)

    expect(get().status).toBe('completed')
    expect(get().conclusion).toBe('Second.')
    // Transcript carries the prior conclusion, the human question, and the new one.
    expect(messages.some((m) => m.speakerKind === 'human' && m.content === 'What about X?')).toBe(
      true,
    )
    expect(messages.filter((m) => m.content === 'First.').length).toBe(1)
    expect(messages[messages.length - 1].content).toBe('Second.')
    expect(messages.length).toBeGreaterThan(before)
  })
})
