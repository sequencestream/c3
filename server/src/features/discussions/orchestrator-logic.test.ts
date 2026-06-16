/**
 * Unit tests for the pure discussion-engine logic: organizer-decision parsing
 * (JSON, keyword fallback, invalid speaker, unparseable → safe advance),
 * participant-speech normalization, the stage/round-cap step resolution, and the
 * prompt builders (key fields present). No I/O.
 */
import { describe, expect, it } from 'vitest'
import { getDiscussionType } from '@ccc/shared/discussion-types'
import type { Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import {
  buildOrganizerPrompt,
  buildOrganizerDeltaPrompt,
  buildParticipantPrompt,
  buildParticipantDeltaPrompt,
  MAX_SPEECH_CHARS,
  parseOrganizerDecision,
  parseParticipantSpeech,
  renderTranscript,
  resolveStep,
} from './orchestrator-logic.js'

const IDS = ['system', 'gpt']

const discussion: Discussion = {
  id: 'd1',
  workspaceId: '/abs/proj',
  title: 'Pick a cache',
  type: 'decision',
  goal: 'Choose a caching layer',
  context: 'High read load.',
  researchResult: '',
  status: 'in_progress',
  agenda: [],
  agendaIndex: 0,
  participantAgentIds: [],
  organizerAgentId: null,
  conclusion: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
}

const msg = (seq: number, name: string, content: string): DiscussionMessage => ({
  id: `m${seq}`,
  discussionId: 'd1',
  seq,
  speakerKind: name === 'Organizer' ? 'organizer' : 'agent',
  speakerAgentId: name === 'Organizer' ? null : 'gpt',
  speakerName: name,
  content,
  createdAt: seq,
})

describe('parseOrganizerDecision', () => {
  it('parses a speak decision from JSON', () => {
    const d = parseOrganizerDecision('{"action":"speak","speaker":"gpt","note":"go"}', IDS)
    expect(d).toEqual({ action: 'speak', speakerId: 'gpt', note: 'go' })
  })

  it('parses a fenced advance decision with a summary note', () => {
    const d = parseOrganizerDecision('```json\n{"action":"advance","note":"two options"}\n```', IDS)
    expect(d).toEqual({ action: 'advance', note: 'two options' })
  })

  it('parses a conclude decision, falling back to note when conclusion is empty', () => {
    const d = parseOrganizerDecision('{"action":"conclude","conclusion":"Use Redis."}', IDS)
    expect(d).toEqual({ action: 'conclude', conclusion: 'Use Redis.' })
  })

  it('treats an unknown speaker id as not-speak and degrades', () => {
    const d = parseOrganizerDecision('{"action":"speak","speaker":"ghost"}', IDS)
    expect(d.action).not.toBe('speak')
  })

  it('keyword fallback: detects a conclusion in prose', () => {
    const d = parseOrganizerDecision('我认为可以下结论了:就用 Redis。', IDS)
    expect(d.action).toBe('conclude')
  })

  it('keyword fallback: honors a participant id named in prose', () => {
    const d = parseOrganizerDecision('接下来请 gpt 发言。', IDS)
    expect(d).toEqual({ action: 'speak', speakerId: 'gpt', note: '' })
  })

  it('defaults to advance on an unparseable reply (never hangs)', () => {
    const d = parseOrganizerDecision('...', IDS)
    expect(d).toEqual({ action: 'advance', note: '' })
  })

  it('parses a set_agenda decision with a subtopic list', () => {
    const d = parseOrganizerDecision(
      '{"action":"set_agenda","subtopics":["延迟","成本"," "],"note":"先拆题"}',
      IDS,
    )
    // Blank entries are dropped.
    expect(d).toEqual({ action: 'set_agenda', subtopics: ['延迟', '成本'], note: '先拆题' })
  })

  it('degrades a set_agenda with no usable subtopics (does not hang)', () => {
    const d = parseOrganizerDecision('{"action":"set_agenda","subtopics":[]}', IDS)
    expect(d.action).not.toBe('set_agenda')
  })

  it('parses a focus_subtopic decision with an explicit index', () => {
    const d = parseOrganizerDecision('{"action":"focus_subtopic","index":2,"note":"下一题"}', IDS)
    expect(d).toEqual({ action: 'focus_subtopic', index: 2, note: '下一题' })
  })

  it('keyword fallback: detects moving to the next subtopic in prose', () => {
    const d = parseOrganizerDecision('这个子题讨论够了,进入下一个子题。', IDS)
    expect(d).toEqual({ action: 'focus_subtopic', note: '' })
  })

  it('parses a broadcast decision with an explicit speaker list (intersected + deduped)', () => {
    const d = parseOrganizerDecision(
      '{"action":"broadcast","speakers":["gpt","gpt","ghost","system"],"note":"各自给方案"}',
      IDS,
    )
    // ghost is dropped (not valid); gpt deduped; order preserved.
    expect(d).toEqual({ action: 'broadcast', speakerIds: ['gpt', 'system'], note: '各自给方案' })
  })

  it('parses a broadcast with speakers="all" / omitted as every participant', () => {
    expect(parseOrganizerDecision('{"action":"broadcast","speakers":"all"}', IDS)).toEqual({
      action: 'broadcast',
      speakerIds: ['system', 'gpt'],
      note: '',
    })
    expect(parseOrganizerDecision('{"action":"broadcast","note":"问全体"}', IDS)).toEqual({
      action: 'broadcast',
      speakerIds: ['system', 'gpt'],
      note: '问全体',
    })
  })

  it('recovers a broadcast with an all-invalid speaker list to the whole roster', () => {
    const d = parseOrganizerDecision('{"action":"broadcast","speakers":["ghost"]}', IDS)
    expect(d).toEqual({ action: 'broadcast', speakerIds: ['system', 'gpt'], note: '' })
  })

  it('degrades a broadcast to advance when there are no valid participants at all', () => {
    const d = parseOrganizerDecision('{"action":"broadcast","speakers":["ghost"]}', [])
    expect(d.action).not.toBe('broadcast')
  })

  it('keyword fallback: detects a broadcast in prose (asks everyone)', () => {
    const d = parseOrganizerDecision('就这个子议题做一次批次广播,请大家并行作答。', IDS)
    expect(d).toEqual({ action: 'broadcast', speakerIds: ['system', 'gpt'], note: '' })
  })
})

describe('parseParticipantSpeech', () => {
  it('trims and strips code fences', () => {
    expect(parseParticipantSpeech('  ```\nhello\n```  ')).toBe('hello')
  })

  it('strips a leading self name prefix', () => {
    expect(parseParticipantSpeech('GPT: my view', 'GPT')).toBe('my view')
  })

  it('returns empty string for blank text', () => {
    expect(parseParticipantSpeech('   ')).toBe('')
  })

  it('preserves over-long text verbatim (no hard truncation)', () => {
    const long = 'a'.repeat(MAX_SPEECH_CHARS + 500)
    const out = parseParticipantSpeech(long)
    expect(out.length).toBe(MAX_SPEECH_CHARS + 500)
    expect(out).toBe(long)
  })

  it('leaves a normal short speech untouched (no ellipsis, no truncation)', () => {
    const short = '我支持引入缓存层,成本可控且收益明显。'
    expect(parseParticipantSpeech(short)).toBe(short)
  })

  it('ignores the maxChars parameter (truncation removed — text preserved verbatim)', () => {
    // The maxChars parameter is kept as a no-op for backward compatibility;
    // truncation no longer happens regardless of its value.
    expect(parseParticipantSpeech('abcdef', undefined, 4)).toBe('abcdef')
  })
})

describe('resolveStep', () => {
  const base = { validSpeakerIds: IDS, roundsInStage: 0, maxRoundsPerStage: 4 }

  it('conclude stage always concludes', () => {
    const step = resolveStep({
      ...base,
      stage: 'conclude',
      decision: { action: 'advance', note: 'Final wrap-up.' },
    })
    expect(step).toEqual({ kind: 'conclude', conclusion: 'Final wrap-up.' })
  })

  it('an explicit conclude decision concludes from a non-terminal stage', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'conclude', conclusion: 'Done.' },
    })
    expect(step).toEqual({ kind: 'conclude', conclusion: 'Done.' })
  })

  it('hitting the per-stage cap forces an advance', () => {
    const step = resolveStep({
      ...base,
      roundsInStage: 4,
      stage: 'discuss',
      decision: { action: 'speak', speakerId: 'gpt', note: '' },
    })
    expect(step.kind).toBe('advance')
  })

  it('a valid speak decision speaks', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'speak', speakerId: 'gpt', note: 'hi' },
    })
    expect(step).toEqual({ kind: 'speak', speakerId: 'gpt', organizerNote: 'hi' })
  })

  it('a speak decision with an invalid id advances', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'speak', speakerId: 'ghost', note: '' },
    })
    expect(step.kind).toBe('advance')
  })

  it('set_agenda in discuss yields a set_agenda step', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'set_agenda', subtopics: ['A', 'B'], note: 'go' },
    })
    expect(step).toEqual({ kind: 'set_agenda', subtopics: ['A', 'B'], organizerNote: 'go' })
  })

  it('focus_subtopic advances to the next subtopic', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'focus_subtopic', note: '' },
      agenda: { items: ['A', 'B', 'C'], index: 0 },
    })
    expect(step).toEqual({ kind: 'focus_subtopic', index: 1, organizerNote: '' })
  })

  it('focus_subtopic past the last subtopic advances out of the stage', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'focus_subtopic', note: 'done' },
      agenda: { items: ['A', 'B'], index: 1 },
    })
    expect(step).toEqual({ kind: 'advance', organizerNote: 'done' })
  })

  it('the per-stage cap moves to the next subtopic when the agenda is unfinished', () => {
    const step = resolveStep({
      ...base,
      roundsInStage: 4,
      stage: 'discuss',
      decision: { action: 'speak', speakerId: 'gpt', note: '' },
      agenda: { items: ['A', 'B'], index: 0 },
    })
    expect(step).toEqual({ kind: 'focus_subtopic', index: 1, organizerNote: '' })
  })

  it('the per-stage cap advances out of the stage on the last subtopic', () => {
    const step = resolveStep({
      ...base,
      roundsInStage: 4,
      stage: 'discuss',
      decision: { action: 'speak', speakerId: 'gpt', note: '' },
      agenda: { items: ['A', 'B'], index: 1 },
    })
    expect(step.kind).toBe('advance')
  })

  it('agenda actions degrade to advance outside the discuss stage', () => {
    const step = resolveStep({
      ...base,
      stage: 'summarize',
      decision: { action: 'set_agenda', subtopics: ['A'], note: '' },
    })
    expect(step.kind).toBe('advance')
  })

  it('broadcast in discuss yields a broadcast step', () => {
    const step = resolveStep({
      ...base,
      stage: 'discuss',
      decision: { action: 'broadcast', speakerIds: ['system', 'gpt'], note: '问各位' },
    })
    expect(step).toEqual({
      kind: 'broadcast',
      speakerIds: ['system', 'gpt'],
      organizerNote: '问各位',
    })
  })

  it('broadcast degrades to advance outside the discuss stage (converging stays serial)', () => {
    const step = resolveStep({
      ...base,
      stage: 'summarize',
      decision: { action: 'broadcast', speakerIds: ['system', 'gpt'], note: '' },
    })
    expect(step.kind).toBe('advance')
  })

  it('the per-stage cap forces forward motion even with a pending broadcast', () => {
    const step = resolveStep({
      ...base,
      roundsInStage: 4,
      stage: 'discuss',
      decision: { action: 'broadcast', speakerIds: ['system', 'gpt'], note: '' },
      agenda: { items: ['A', 'B'], index: 0 },
    })
    // Cap is checked before the agenda/broadcast block → moves to the next subtopic.
    expect(step).toEqual({ kind: 'focus_subtopic', index: 1, organizerNote: '' })
  })
})

describe('renderTranscript', () => {
  it('shows a placeholder when empty', () => {
    expect(renderTranscript([])).toBe('(no messages yet)')
  })

  it('renders name: content lines', () => {
    expect(renderTranscript([msg(1, 'GPT', 'hi'), msg(2, 'Organizer', 'ok')])).toBe(
      'GPT: hi\nOrganizer: ok',
    )
  })
})

describe('prompt builders', () => {
  const def = getDiscussionType('decision')
  const stage = def!.workflow[0]

  it('organizer prompt carries header, stage, roster, transcript, and JSON contract', () => {
    const p = buildOrganizerPrompt({
      discussion,
      def,
      stage,
      messages: [msg(1, 'GPT', 'hi')],
      participants: [
        { id: 'system', name: 'System' },
        { id: 'gpt', name: 'GPT' },
      ],
    })
    expect(p).toContain('Choose a caching layer')
    expect(p).toContain(stage.prompt)
    expect(p).toContain('id=gpt name=GPT')
    expect(p).toContain('GPT: hi')
    expect(p).toContain('set_agenda|focus_subtopic|broadcast|speak|advance|conclude')
    // The broadcast action is documented as the preferred discuss mechanism.
    expect(p).toContain('broadcast:')
    // Default langName is English.
    expect(p).toContain('Respond in English')
  })

  it('header background prefers researchResult over the user context, falling back to context', () => {
    const withResearch = buildOrganizerPrompt({
      discussion: { ...discussion, researchResult: 'RESEARCHED BACKGROUND' },
      def,
      stage,
      messages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
    })
    expect(withResearch).toContain('RESEARCHED BACKGROUND')
    expect(withResearch).not.toContain('High read load.') // user context not used when research exists

    // No research → fall back to the user's original context.
    const fallback = buildOrganizerPrompt({
      discussion, // researchResult: ''
      def,
      stage,
      messages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
    })
    expect(fallback).toContain('High read load.')
  })

  it('organizer prompt in discuss carries the agenda and marks the current subtopic', () => {
    const p = buildOrganizerPrompt({
      discussion,
      def,
      stage, // decision workflow[0] is the `discuss` stage
      messages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
      agenda: { items: ['延迟', '成本'], index: 1 },
    })
    expect(p).toContain('Current agenda:')
    expect(p).toContain('延迟')
    expect(p).toContain('成本')
    expect(p).toContain('set_agenda')
    expect(p).toContain('focus_subtopic')
  })

  it('participant prompt carries the current subtopic when one is set', () => {
    const p = buildParticipantPrompt({
      discussion,
      def,
      stage,
      messages: [],
      speaker: { id: 'gpt', name: 'GPT' },
      subtopic: '延迟',
    })
    expect(p).toContain('Current subtopic:')
    expect(p).toContain('延迟')
  })

  it('participant prompt carries the speaker, stage focus, and organizer note', () => {
    const p = buildParticipantPrompt({
      discussion,
      def,
      stage,
      messages: [],
      speaker: { id: 'gpt', name: 'GPT' },
      organizerNote: 'focus on cost',
    })
    expect(p).toContain('"GPT"')
    expect(p).toContain(stage.prompt)
    expect(p).toContain('focus on cost')
  })

  it('participant prompt carries the one-paragraph length constraint', () => {
    const p = buildParticipantPrompt({
      discussion,
      def,
      stage,
      messages: [],
      speaker: { id: 'gpt', name: 'GPT' },
    })
    expect(p).toContain('a single paragraph')
    expect(p).toContain(String(MAX_SPEECH_CHARS))
    expect(p).toContain('Respond in English')
  })

  it('participant prompt reflects the configured maxSpeechChars value', () => {
    const p = buildParticipantPrompt({
      discussion,
      def,
      stage,
      messages: [],
      speaker: { id: 'gpt', name: 'GPT' },
      maxSpeechChars: 500,
    })
    expect(p).toContain('500')
    expect(p).not.toContain(String(MAX_SPEECH_CHARS))
  })

  it('participant prompt with langName includes Respond in instruction', () => {
    const p = buildParticipantPrompt({
      discussion,
      def,
      stage,
      messages: [],
      speaker: { id: 'gpt', name: 'GPT' },
      langName: 'Chinese (简体中文)',
    })
    expect(p).toContain('Respond in Chinese (简体中文)')
  })
})

describe('delta prompt builders', () => {
  const def = getDiscussionType('decision')
  const stage = def!.workflow[0]

  it('buildOrganizerDeltaPrompt includes resume context and new messages only', () => {
    const p = buildOrganizerDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [msg(3, 'GPT', 'new view')],
      participants: [{ id: 'gpt', name: 'GPT' }],
    })
    // Contains the resume context
    expect(p).toContain('Continue coordinating the discussion')
    // Contains the header info
    expect(p).toContain('Choose a caching layer')
    // Contains the new messages section heading
    expect(p).toContain('New messages since your last decision')
    // Contains the new message content
    expect(p).toContain('new view')
    // Does NOT contain the old messages that weren't passed
    expect(p).not.toContain('GPT: hi')
    // Contains the JSON contract (key actions)
    expect(p).toContain('set_agenda')
    expect(p).toContain('broadcast')
    expect(p).toContain('conclude')
  })

  it('buildOrganizerDeltaPrompt handles empty newMessages gracefully', () => {
    const p = buildOrganizerDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
    })
    expect(p).toContain('no new messages')
    expect(p).toContain('Based on these new messages, decide the next step')
  })

  it('buildOrganizerDeltaPrompt in discuss shows the agenda', () => {
    const p = buildOrganizerDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
      agenda: { items: ['成本', '延迟'], index: 0 },
    })
    expect(p).toContain('Current agenda:')
    expect(p).toContain('成本')
    expect(p).toContain('延迟')
  })

  it('buildOrganizerDeltaPrompt responds in the specified language', () => {
    const p = buildOrganizerDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [],
      participants: [{ id: 'gpt', name: 'GPT' }],
      langName: 'Chinese (简体中文)',
    })
    expect(p).toContain('Respond in Chinese (简体中文)')
  })

  it('buildParticipantDeltaPrompt includes resume context and new messages only', () => {
    const p = buildParticipantDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [msg(3, 'GPT', 'new view')],
      speaker: { id: 'gpt', name: 'GPT' },
    })
    // Contains the resume context
    expect(p).toContain('"GPT"')
    expect(p).toContain('New messages since your last turn')
    // Contains the new message, not a full transcript heading
    expect(p).toContain('new view')
    expect(p).not.toContain('GPT: hi') // from the earlier msg(1) in test data
    // Contains the one-paragraph length constraint
    expect(p).toContain('single paragraph')
  })

  it('buildParticipantDeltaPrompt handles empty newMessages gracefully', () => {
    const p = buildParticipantDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [],
      speaker: { id: 'gpt', name: 'GPT' },
    })
    expect(p).toContain('no new messages')
    expect(p).toContain('continue based on your existing context')
  })

  it('buildParticipantDeltaPrompt includes subtopic and organizer guidance', () => {
    const p = buildParticipantDeltaPrompt({
      discussion,
      def,
      stage,
      newMessages: [],
      speaker: { id: 'gpt', name: 'GPT' },
      organizerNote: 'focus on latency',
      subtopic: 'Latency',
    })
    expect(p).toContain('Current subtopic:')
    expect(p).toContain('Latency')
    expect(p).toContain('focus on latency')
  })
})
