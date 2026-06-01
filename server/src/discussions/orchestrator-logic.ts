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
 * Agent-facing prompts are Chinese (codebase convention); the JSON contract keeps
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
  | { action: 'advance'; note: string }
  | { action: 'conclude'; conclusion: string }

/** The concrete step the engine runs, after folding stage + round cap into the decision. */
export type DiscussionStep =
  | { kind: 'speak'; speakerId: string; organizerNote: string }
  | { kind: 'advance'; organizerNote: string }
  | { kind: 'conclude'; conclusion: string }

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
 * Parse the organizer's reply into a {@link OrganizerDecision}. JSON object first
 * (`{action, speaker, note, conclusion}`), then keyword heuristics, and finally a
 * safe default of `advance` so the engine can never hang on an unparseable reply.
 * A `speak` whose `speaker` is not a known participant id degrades the same way.
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
 * Normalize a participant's reply into its speech text. A leading `Name:` echo
 * (some agents prefix their own name) is stripped; empty text returns `''` and
 * the caller skips appending it (but still counts the round).
 */
export function parseParticipantSpeech(text: string, speakerName?: string): string {
  let t = cleanText(text)
  if (speakerName) {
    const prefix = `${speakerName}:`
    if (t.startsWith(prefix)) t = t.slice(prefix.length).trim()
  }
  return t
}

/**
 * Fold the active stage and the per-stage round cap into the organizer's decision
 * to yield the concrete step:
 * - the terminal `conclude` stage always concludes (that is the organizer's job there);
 * - an explicit `conclude` decision concludes from any stage;
 * - hitting `maxRoundsPerStage` forces an `advance` (the safety valve against a stuck stage);
 * - a `speak` with a known participant speaks; everything else advances.
 */
export function resolveStep(input: {
  stage: DiscussionStageKind
  decision: OrganizerDecision
  validSpeakerIds: readonly string[]
  roundsInStage: number
  maxRoundsPerStage: number
}): DiscussionStep {
  const { stage, decision, validSpeakerIds, roundsInStage, maxRoundsPerStage } = input

  if (stage === 'conclude') {
    const conclusion =
      decision.action === 'conclude'
        ? decision.conclusion
        : decision.action === 'advance'
          ? decision.note
          : decision.note
    return { kind: 'conclude', conclusion: conclusion.trim() }
  }

  if (decision.action === 'conclude') {
    return { kind: 'conclude', conclusion: decision.conclusion.trim() }
  }

  if (roundsInStage >= maxRoundsPerStage) {
    return { kind: 'advance', organizerNote: decision.action === 'advance' ? decision.note : '' }
  }

  if (decision.action === 'speak' && validSpeakerIds.includes(decision.speakerId)) {
    return { kind: 'speak', speakerId: decision.speakerId, organizerNote: decision.note }
  }

  return { kind: 'advance', organizerNote: decision.action === 'advance' ? decision.note : '' }
}

/** Render the transcript so far as `name: content` lines for a prompt. */
export function renderTranscript(messages: readonly DiscussionMessage[]): string {
  if (messages.length === 0) return '(暂无发言)'
  return messages
    .map((m) => {
      const who = m.speakerName || (m.speakerKind === 'organizer' ? '组织者' : m.speakerKind)
      return `${who}: ${m.content}`
    })
    .join('\n')
}

function header(discussion: Discussion, def: DiscussionTypeDef | undefined): string {
  return [
    `讨论类型: ${def ? `${def.label} — ${def.description}` : discussion.type}`,
    `目标: ${discussion.goal || '(未填写)'}`,
    `背景: ${discussion.context || '(无)'}`,
  ].join('\n')
}

/**
 * Build the organizer's prompt: the discussion header, the active stage and its
 * workflow instruction, the participant roster, the transcript so far, and the
 * strict JSON output contract {@link parseOrganizerDecision} reads.
 */
export function buildOrganizerPrompt(input: {
  discussion: Discussion
  def: DiscussionTypeDef | undefined
  stage: DiscussionWorkflowStage
  messages: readonly DiscussionMessage[]
  participants: readonly DiscussionParticipant[]
}): string {
  const { discussion, def, stage, messages, participants } = input
  const roster = participants.map((p) => `- id=${p.id} 名称=${p.name}`).join('\n')
  return [
    '你是这场讨论的「组织者(organizer)」,统一编排各参与者的发言并推动讨论得出结论。',
    '',
    header(discussion, def),
    '',
    `当前阶段: ${stage.label} —— ${stage.prompt}`,
    '',
    '参与者名单:',
    roster,
    '',
    '已有发言:',
    renderTranscript(messages),
    '',
    '根据当前阶段决定下一步,只输出一个 JSON 对象,不要任何额外文字:',
    '{"action":"speak|advance|conclude","speaker":"<参与者 id,action=speak 时必填>","note":"<组织者要记录的话,可空>","conclusion":"<action=conclude 时的完整最终结论>"}',
    '- speak: 指定下一位发言的参与者(填其 id);note 可写你对该参与者的引导。当本阶段仍需更多输入时用它。',
    '- advance: 本阶段已充分,推进到下一阶段;note 写本阶段的小结(例如 summarize 阶段填归纳要点)。',
    '- conclude: 讨论已可收尾,conclusion 写完整、可执行的最终结论。',
  ].join('\n')
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
}): string {
  const { discussion, def, stage, messages, speaker, organizerNote } = input
  const lines = [
    `你是这场讨论的参与者「${speaker.name}」。`,
    '',
    header(discussion, def),
    '',
    `当前阶段: ${stage.label} —— ${stage.prompt}`,
    '',
    '已有发言:',
    renderTranscript(messages),
  ]
  if (organizerNote && organizerNote.trim()) {
    lines.push('', `组织者给你的引导: ${organizerNote.trim()}`)
  }
  lines.push(
    '',
    '请围绕当前阶段给出你的观点:简洁、直接、用中文,不要复述他人已说的内容,只输出你的发言正文(不要加你的名字前缀)。',
  )
  return lines.join('\n')
}
