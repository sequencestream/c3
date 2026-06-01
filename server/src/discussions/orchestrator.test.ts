/**
 * Unit tests for the discussion orchestration loop, driven entirely by fakes
 * (a scripted `ask`, an in-memory store, capture hooks). Covers: the happy path
 * across all four workflow stages with status transitions + streamed messages +
 * a written conclusion; the single-agent degenerate path; mid-run abort leaving
 * the discussion `in_progress`; and the total-round-cap fallback conclusion.
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
})
