/**
 * Pure decision + parsing logic for the organizer-driven discussion engine.
 *
 * No I/O, no SDK, no store — every function here is a pure transform over
 * plain data, so the engine's two hardest pieces ("whose turn / what next" and
 * "what did a turn actually say") are unit-tested in isolation and injected into
 * the orchestrator loop ({@link ../orchestrator.ts}) as dependencies.
 *
 * The model: at each round the *organizer* (an agent) is asked, over the current
 * transcript and the active workflow stage, to emit a decision —
 * `speak` (nominate a participant), `advance` (move to the next stage, carrying a
 * note such as a summary), or `conclude` (finish, with the final conclusion).
 * {@link parseOrganizerDecision} turns its free text into that decision (JSON
 * first, keyword fallback, always a safe default); {@link resolveStep} folds in
 * the stage and the per-stage round cap to yield the concrete step the loop runs.
 *
 * Agent-facing prompts are English (the skeleton stays out of i18n — see
 * specs/style/i18n-spec.md §7); the JSON contract keeps
 * parsing deterministic.
 */

import type { Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import type {
  DiscussionStageKind,
  DiscussionTypeDef,
  DiscussionWorkflowStage,
} from '@ccc/shared/discussion-types'

/** A discussion participant the organizer can nominate to speak. */
export interface DiscussionParticipant {
  id: string
  name: string
}

/** The organizer's parsed decision for one round. */
export type OrganizerDecision =
  | { action: 'speak'; speakerId: string; note: string }
  | { action: 'broadcast'; speakerIds: string[]; note: string }
  | { action: 'set_agenda'; subtopics: string[]; note: string }
  | { action: 'focus_subtopic'; index?: number; note: string }
  | { action: 'advance'; note: string }
  | { action: 'conclude'; conclusion: string }

/** The concrete step the engine runs, after folding stage + round cap into the decision. */
export type DiscussionStep =
  | { kind: 'speak'; speakerId: string; organizerNote: string }
  | { kind: 'broadcast'; speakerIds: string[]; organizerNote: string }
  | { kind: 'set_agenda'; subtopics: string[]; organizerNote: string }
  | { kind: 'focus_subtopic'; index: number; organizerNote: string }
  | { kind: 'advance'; organizerNote: string }
  | { kind: 'conclude'; conclusion: string }

/**
 * The live agenda the engine folds into a step: the ordered subtopics the
 * organizer set, and the 0-based index of the current one. `index === items.length`
 * means every subtopic is done. Empty `items` means no agenda is set yet — the
 * engine then behaves exactly as it did before agendas existed.
 */
export interface AgendaState {
  items: readonly string[]
  index: number
}

const EMPTY_AGENDA: AgendaState = { items: [], index: 0 }

/** Extract the first JSON object from `text` (handles ```json fences), or null. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(c.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/** Strip code fences and collapse outer whitespace — the conclusion fallback text. */
function cleanText(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Resolve a `broadcast` decision's `speakers` field into a concrete, ordered, deduped
 * list of valid participant ids. `"all"`/`"全部"`/missing ⇒ every participant (the
 * default — broadcast asks everyone); an explicit id array is intersected with the
 * valid set (order preserved). An unusable value yields `[]`, which degrades the
 * decision to the safe `advance` default.
 */
function resolveBroadcastSpeakers(raw: unknown, validSpeakerIds: readonly string[]): string[] {
  const allValid = [...new Set(validSpeakerIds.filter(Boolean))]
  if (raw == null) return allValid
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    return s === '' || s === 'all' || s === '全部' ? allValid : []
  }
  if (Array.isArray(raw)) {
    const valid = new Set(allValid)
    const out: string[] = []
    for (const item of raw) {
      const id = str(item)
      if (valid.has(id) && !out.includes(id)) out.push(id)
    }
    return out
  }
  return []
}

/**
 * Parse the organizer's reply into a {@link OrganizerDecision}. JSON object first
 * (`{action, speaker, speakers, subtopics, index, note, conclusion}`), then keyword
 * heuristics, and finally a safe default of `advance` so the engine can never hang on
 * an unparseable reply. A `speak` whose `speaker` is not a known participant id
 * degrades the same way; a `set_agenda` with no usable subtopics, or a `broadcast`
 * whose resolved speaker set is empty, also degrade.
 *
 * Agenda actions: `set_agenda` decomposes the goal into ordered subtopics (its
 * `subtopics` must be a non-empty string array — there is no prose fallback for it,
 * a list can't be reliably extracted from free text); `focus_subtopic` moves to the
 * next subtopic (or the optional numeric `index`).
 *
 * Batch action: `broadcast` (discuss only) asks several participants the same
 * sub-question at once — `speakers` is an id array or `"all"`/`"全部"`/missing for
 * everyone (see {@link resolveBroadcastSpeakers}); the engine then runs them in
 * parallel. Outside `discuss`, {@link resolveStep} degrades it to a serial advance.
 */
export function parseOrganizerDecision(
  text: string,
  validSpeakerIds: readonly string[],
): OrganizerDecision {
  const valid = new Set(validSpeakerIds.filter(Boolean))
  const json = extractJsonObject(text)
  if (json) {
    const action = str(json.action).toLowerCase()
    const note = str(json.note)
    if (action === 'conclude') {
      return { action: 'conclude', conclusion: str(json.conclusion) || note || cleanText(text) }
    }
    if (action === 'set_agenda') {
      const subtopics = Array.isArray(json.subtopics) ? json.subtopics.map(str).filter(Boolean) : []
      if (subtopics.length) return { action: 'set_agenda', subtopics, note }
      // empty/unusable subtopics → degrade through the fallback below
    }
    if (action === 'focus_subtopic') {
      const index = typeof json.index === 'number' ? json.index : undefined
      return { action: 'focus_subtopic', index, note }
    }
    if (action === 'broadcast') {
      // An explicit-but-all-invalid speaker list recovers to "everyone" rather than
      // degrading — broadcast's natural default is the whole roster, and asking all
      // beats silently advancing on a typo'd id. Only a truly empty roster degrades.
      let speakerIds = resolveBroadcastSpeakers(json.speakers, validSpeakerIds)
      if (!speakerIds.length) speakerIds = resolveBroadcastSpeakers('all', validSpeakerIds)
      if (speakerIds.length) return { action: 'broadcast', speakerIds, note }
      // no valid participants at all → degrade through the fallback below
    }
    if (action === 'speak') {
      const speaker = str(json.speaker)
      if (valid.has(speaker)) return { action: 'speak', speakerId: speaker, note }
      // fall through: unknown speaker id is treated heuristically below
    }
    if (action === 'advance') return { action: 'advance', note }
  }

  // Keyword fallback over the raw text.
  const lower = text.toLowerCase()
  if (/\b(conclude|conclusion)\b/.test(lower) || /结论|定论|结束讨论/.test(text)) {
    return { action: 'conclude', conclusion: cleanText(text) }
  }
  // Moving on to the next subtopic — before the stage-advance keyword so the more
  // specific "next subtopic" intent wins over a bare "next".
  if (/\b(focus[_ ]?subtopic|next subtopic)\b/.test(lower) || /下一(个)?子(议)?题/.test(text)) {
    return { action: 'focus_subtopic', note: '' }
  }
  // A batch broadcast asks everyone at once — recognized before the speak prose match
  // so a "broadcast" intent isn't swallowed by a participant id appearing in the text.
  if (/\bbroadcast\b/.test(lower) || /批次|广播|齐发|并行作答/.test(text)) {
    const speakerIds = resolveBroadcastSpeakers('all', validSpeakerIds)
    if (speakerIds.length) return { action: 'broadcast', speakerIds, note: '' }
  }
  // The organizer may have named a participant in prose — honor the first valid id.
  for (const id of validSpeakerIds) {
    if (id && text.includes(id)) return { action: 'speak', speakerId: id, note: '' }
  }
  if (/\b(advance|next stage)\b/.test(lower) || /推进|进入下一|下一阶段/.test(text)) {
    return { action: 'advance', note: '' }
  }
  // Unparseable → advance, guaranteeing forward progress.
  return { action: 'advance', note: '' }
}

/**
 * Default character budget for participant speech prompts (used when no system
 * config is threaded in). The prompt asks participants to keep replies within
 * this budget, but {@link parseParticipantSpeech} does NOT truncate — over-long
 * replies are accepted verbatim.
 */
export const MAX_SPEECH_CHARS = 300

/**
 * Normalize a participant's reply into its speech text. A leading `Name:` echo
 * (some agents prefix their own name) is stripped; empty text returns `''` and
 * the caller skips appending it (but still counts the round). Unlike earlier
 * versions, there is no hard truncation — over-long replies are accepted
 * verbatim regardless of the configured budget (the budget serves only as
 * prompt-level guidance).
 */
export function parseParticipantSpeech(
  text: string,
  speakerName?: string,
  _maxChars?: number,
): string {
  let t = cleanText(text)
  if (speakerName) {
    const prefix = `${speakerName}:`
    if (t.startsWith(prefix)) t = t.slice(prefix.length).trim()
  }
  return t
}

/** The `note` carried by any decision, or `''` for actions that don't carry one. */
function decisionNote(decision: OrganizerDecision): string {
  return decision.action === 'conclude' ? '' : decision.note
}

/**
 * Fold the active stage, the per-stage round cap, and the live agenda into the
 * organizer's decision to yield the concrete step:
 * - the terminal `conclude` stage always concludes (that is the organizer's job there);
 * - an explicit `conclude` decision concludes from any stage;
 * - hitting `maxRoundsPerStage` forces forward motion: in `discuss` with an unfinished
 *   agenda it moves to the next subtopic (not out of the stage); otherwise it advances;
 * - in `discuss`, `set_agenda` (non-empty) sets the agenda and `focus_subtopic` moves to
 *   the next subtopic — or advances to the next stage once every subtopic is done;
 * - in `discuss`, `broadcast` (non-empty speaker set) asks several participants the same
 *   sub-question at once (the engine runs them in parallel) — outside `discuss` it degrades
 *   to `advance`, so the converging stages stay serial;
 * - a `speak` with a known participant speaks; everything else advances.
 *
 * `agenda` defaults to empty, so callers that don't track an agenda (and any stage
 * other than `discuss`) keep the pre-agenda behavior exactly.
 */
export function resolveStep(input: {
  stage: DiscussionStageKind
  decision: OrganizerDecision
  validSpeakerIds: readonly string[]
  roundsInStage: number
  maxRoundsPerStage: number
  agenda?: AgendaState
}): DiscussionStep {
  const { stage, decision, validSpeakerIds, roundsInStage, maxRoundsPerStage } = input
  const agenda = input.agenda ?? EMPTY_AGENDA

  if (stage === 'conclude') {
    const conclusion = decision.action === 'conclude' ? decision.conclusion : decisionNote(decision)
    return { kind: 'conclude', conclusion: conclusion.trim() }
  }

  if (decision.action === 'conclude') {
    return { kind: 'conclude', conclusion: decision.conclusion.trim() }
  }

  // Per-stage cap: a stuck stage must move forward. In `discuss` with subtopics still
  // pending, that means the next subtopic; otherwise (last subtopic / no agenda) it
  // advances out of the stage — the pre-agenda safety-valve behavior.
  if (roundsInStage >= maxRoundsPerStage) {
    if (stage === 'discuss' && agenda.index + 1 < agenda.items.length) {
      return { kind: 'focus_subtopic', index: agenda.index + 1, organizerNote: '' }
    }
    return { kind: 'advance', organizerNote: decision.action === 'advance' ? decision.note : '' }
  }

  // Agenda actions only have meaning while the floor is open (`discuss`); elsewhere
  // they fall through to the safe `advance` default below.
  if (stage === 'discuss') {
    if (decision.action === 'set_agenda' && decision.subtopics.length) {
      return { kind: 'set_agenda', subtopics: decision.subtopics, organizerNote: decision.note }
    }
    if (decision.action === 'broadcast' && decision.speakerIds.length) {
      return { kind: 'broadcast', speakerIds: decision.speakerIds, organizerNote: decision.note }
    }
    if (decision.action === 'focus_subtopic') {
      const next =
        typeof decision.index === 'number' && decision.index >= 0
          ? decision.index
          : agenda.index + 1
      // Past the last subtopic ⇒ every subtopic is done ⇒ advance to the next stage.
      if (next >= agenda.items.length) {
        return { kind: 'advance', organizerNote: decision.note }
      }
      return { kind: 'focus_subtopic', index: next, organizerNote: decision.note }
    }
  }

  if (decision.action === 'speak' && validSpeakerIds.includes(decision.speakerId)) {
    return { kind: 'speak', speakerId: decision.speakerId, organizerNote: decision.note }
  }

  return { kind: 'advance', organizerNote: decision.action === 'advance' ? decision.note : '' }
}

/** Render the transcript so far as `name: content` lines for a prompt. */
export function renderTranscript(messages: readonly DiscussionMessage[]): string {
  if (messages.length === 0) return '(no messages yet)'
  return messages
    .map((m) => {
      const who = m.speakerName || (m.speakerKind === 'organizer' ? 'Organizer' : m.speakerKind)
      return `${who}: ${m.content}`
    })
    .join('\n')
}

function header(discussion: Discussion, def: DiscussionTypeDef | undefined): string {
  return [
    `Discussion type: ${def ? `${def.label} — ${def.description}` : discussion.type}`,
    `Goal: ${discussion.goal || '(not provided)'}`,
    // Prefer the research agent's output as background; fall back to the user's
    // original context when research produced nothing.
    `Background: ${discussion.researchResult || discussion.context || '(none)'}`,
  ].join('\n')
}

/**
 * Render the current agenda for the organizer prompt: a numbered subtopic list with
 * the current one marked, or a prompt to set one when none exists. Only the `discuss`
 * stage shows the agenda (it's the only stage where agenda actions apply).
 */
function renderAgenda(agenda: AgendaState): string {
  if (agenda.items.length === 0) {
    return 'Current agenda: (not set yet — use set_agenda to decompose the goal into ordered subtopics)'
  }
  const lines = agenda.items.map((t, i) => {
    const mark = i < agenda.index ? '✓ done' : i === agenda.index ? '▶ current' : '· pending'
    return `${i + 1}. [${mark}] ${t}`
  })
  const done = agenda.index >= agenda.items.length
  return ['Current agenda:', ...lines, done ? '(all subtopics completed)' : '']
    .filter(Boolean)
    .join('\n')
}

/**
 * Build the organizer's prompt: the discussion header, the active stage and its
 * workflow instruction, the current agenda (in `discuss`), the participant roster,
 * the transcript so far, and the strict JSON output contract
 * {@link parseOrganizerDecision} reads (including the agenda actions).
 */
export function buildOrganizerPrompt(input: {
  discussion: Discussion
  def: DiscussionTypeDef | undefined
  stage: DiscussionWorkflowStage
  messages: readonly DiscussionMessage[]
  participants: readonly DiscussionParticipant[]
  agenda?: AgendaState
  /** The display-language name (e.g. "Chinese (简体中文)") — appended as "Respond in <langName>". */
  langName?: string
}): string {
  const { discussion, def, stage, messages, participants, langName = 'English' } = input
  const agenda = input.agenda ?? EMPTY_AGENDA
  const roster = participants.map((p) => `- id=${p.id} name=${p.name}`).join('\n')
  const lines = [
    'You are the "Organizer" of this discussion. Coordinate the participants\' contributions',
    'and drive the discussion toward a conclusion.',
    '',
    header(discussion, def),
    '',
    `Current stage: ${stage.label} — ${stage.prompt}`,
  ]
  if (stage.id === 'discuss') {
    lines.push('', renderAgenda(agenda))
  }
  lines.push(
    '',
    'Participant roster:',
    roster,
    '',
    'Transcript so far:',
    renderTranscript(messages),
    '',
    'Decide the next step based on the current stage. Output only a single JSON object, no extra text:',
    '{"action":"set_agenda|focus_subtopic|broadcast|speak|advance|conclude","speaker":"<participant id (required for action=speak)>","speakers":["<participant id list (action=broadcast); \\"all\\" or omit for everyone>"],"subtopics":["<ordered subtopic list (action=set_agenda)>"],"index":<optional subtopic index 0-based (action=focus_subtopic)>,"note":"<organizer note / sub-question to broadcast, may be empty>","conclusion":"<full final conclusion (action=conclude)>"}',
    '- set_agenda: use only in the discuss stage when no agenda is set yet; decompose the goal into ordered subtopics; the engine advances through them one by one.',
    '- focus_subtopic: the current subtopic has been sufficiently discussed, move to the next (optionally via index); when all subtopics are done the engine auto-advances to the next stage.',
    '- broadcast: use only in the discuss stage, and the preferred method there — ask several (or all) participants the same sub-question around the current subtopic; they answer in parallel. Set speakers to an id list or "all"/omit for everyone, note is the sub-question.',
    '- speak: nominate a single participant (by id) to speak — for follow-up or elaboration, around the current subtopic; note may contain guidance for that participant.',
    '- advance: this stage is complete, move to the next; note carries a summary of this stage (e.g. key points for summarize).',
    '- conclude: wrap up the discussion; conclusion must be a complete, actionable final conclusion.',
    '',
    `Respond in ${langName}.`,
  )
  return lines.join('\n')
}

/**
 * Build a participant's prompt: the discussion header, the active stage focus,
 * the transcript, any organizer note for this turn, and the instruction to reply
 * with their own view only.
 */
export function buildParticipantPrompt(input: {
  discussion: Discussion
  def: DiscussionTypeDef | undefined
  stage: DiscussionWorkflowStage
  messages: readonly DiscussionMessage[]
  speaker: DiscussionParticipant
  organizerNote?: string
  /** The current agenda subtopic to focus on, when one is set. */
  subtopic?: string
  /**
   * Character budget for this turn — the prompt asks the participant to keep
   * replies within this limit as guidance. Defaults to {@link MAX_SPEECH_CHARS}.
   * Over-long replies are accepted verbatim (no hard truncation).
   */
  maxSpeechChars?: number
  /** The display-language name (e.g. "Chinese (简体中文)") — appended as "Respond in <langName>". */
  langName?: string
}): string {
  const {
    discussion,
    def,
    stage,
    messages,
    speaker,
    organizerNote,
    subtopic,
    maxSpeechChars,
    langName,
  } = input
  const budget =
    typeof maxSpeechChars === 'number' && maxSpeechChars > 0 ? maxSpeechChars : MAX_SPEECH_CHARS
  const lang = langName ?? 'English'
  const lines = [
    `You are a participant in this discussion: "${speaker.name}".`,
    '',
    header(discussion, def),
    '',
    `Current stage: ${stage.label} — ${stage.prompt}`,
  ]
  if (subtopic && subtopic.trim()) {
    lines.push('', `Current subtopic: ${subtopic.trim()} — focus on this subtopic in your reply.`)
  }
  lines.push('', 'Transcript so far:', renderTranscript(messages))
  if (organizerNote && organizerNote.trim()) {
    lines.push('', `Organizer's guidance to you: ${organizerNote.trim()}`)
  }
  lines.push(
    '',
    `Give your perspective on the current stage. Do not repeat what others have said. ` +
      `Output only your reply text (no name prefix). Keep it concise: a single paragraph, ` +
      `about ${budget} characters, straight to the point.`,
    '',
    `Respond in ${lang}.`,
  )
  return lines.join('\n')
}
