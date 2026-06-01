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
  buildParticipantPrompt,
  parseOrganizerDecision,
  parseParticipantSpeech,
  renderTranscript,
  resolveStep,
} from './orchestrator-logic.js'

const IDS = ['system', 'gpt']

const discussion: Discussion = {
  id: 'd1',
  projectPath: '/abs/proj',
  title: 'Pick a cache',
  type: 'decision',
  goal: 'Choose a caching layer',
  context: 'High read load.',
  status: 'in_progress',
  conclusion: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
}

const msg = (seq: number, name: string, content: string): DiscussionMessage => ({
  id: `m${seq}`,
  discussionId: 'd1',
  seq,
  speakerKind: name === '组织者' ? 'organizer' : 'agent',
  speakerAgentId: name === '组织者' ? null : 'gpt',
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
})

describe('renderTranscript', () => {
  it('shows a placeholder when empty', () => {
    expect(renderTranscript([])).toBe('(暂无发言)')
  })

  it('renders name: content lines', () => {
    expect(renderTranscript([msg(1, 'GPT', 'hi'), msg(2, '组织者', 'ok')])).toBe(
      'GPT: hi\n组织者: ok',
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
    expect(p).toContain('id=gpt 名称=GPT')
    expect(p).toContain('GPT: hi')
    expect(p).toContain('"action":"speak|advance|conclude"')
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
    expect(p).toContain('「GPT」')
    expect(p).toContain(stage.prompt)
    expect(p).toContain('focus on cost')
  })
})
