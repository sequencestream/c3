/**
 * Organizer-driven multi-agent discussion engine (the orchestration loop).
 *
 * Drives a `draft` discussion to a `conclusion` in the background: the organizer
 * (the default agent) is asked each round — over the live transcript and the
 * active workflow stage — to nominate a participant, broadcast a sub-question to
 * several participants at once (`discuss` only; they answer in parallel), advance
 * the stage, or conclude; nominated participants speak via the one-shot, tool-disabled
 * {@link askAgentOnce} primitive (the consensus paradigm). Every organizer note,
 * participant speech, and the final conclusion is appended to the store and
 * streamed out via `onMessage`. The discussion walks `draft → in_progress →
 * completed`, writing its `conclusion` at the end.
 *
 * All decision/parsing logic lives in {@link ./orchestrator-logic.ts} as pure,
 * unit-tested functions; this module only wires them to the store, the agents,
 * and the broadcast hooks — and all of those are injected ({@link DiscussionDeps})
 * so the loop itself is driven by fakes in tests.
 *
 * Termination is guaranteed: stages only ever move forward (discuss → summarize →
 * confirm → conclude, conclude is terminal), a per-stage round cap forces an
 * advance out of a stuck stage, and a total-round cap writes a fallback
 * conclusion. A single configured agent degenerates gracefully (it is both
 * organizer and sole participant), mirroring consensus with no voters.
 */

import type {
  AgentConfig,
  Discussion,
  DiscussionMessage,
  DiscussionStatus,
} from '@ccc/shared/protocol'
import {
  getDiscussionType,
  nextDiscussionStage,
  type DiscussionStageKind,
} from '@ccc/shared/discussion-types'
import { askAgentOnce } from '../agent-once.js'
import { getMaxRoundsPerStage, loadSettings, resolveAgent } from '../settings.js'
import {
  appendMessage as storeAppendMessage,
  getDiscussion as storeGetDiscussion,
  listMessages as storeListMessages,
  setAgenda as storeSetAgenda,
  setConclusion as storeSetConclusion,
  updateDiscussionStatus as storeUpdateStatus,
} from './store.js'
import {
  buildOrganizerPrompt,
  buildParticipantPrompt,
  parseOrganizerDecision,
  parseParticipantSpeech,
  resolveStep,
  type DiscussionParticipant,
} from './orchestrator-logic.js'

/** The display name used for the organizer's own (role) messages. */
export const ORGANIZER_NAME = '组织者'

/** The slice of the discussion store the engine needs (structurally typed for DI). */
export interface DiscussionStore {
  getDiscussion(id: string): Discussion | null
  listMessages(discussionId: string): DiscussionMessage[]
  appendMessage(input: {
    discussionId: string
    speakerKind: 'organizer' | 'agent' | 'human'
    speakerAgentId?: string | null
    speakerName?: string | null
    content: string
  }): DiscussionMessage
  setConclusion(id: string, conclusion: string): void
  updateDiscussionStatus(id: string, status: DiscussionStatus): void
  /** Persist the agenda: ordered subtopics + the 0-based current index. */
  setAgenda(id: string, items: readonly string[], index: number): void
}

/** Injected dependencies for {@link runDiscussion}. */
export interface DiscussionDeps {
  /** One-shot, tool-disabled agent turn (the consensus `askAgentOnce` primitive). */
  ask: (agent: AgentConfig, prompt: string, cwd: string, signal: AbortSignal) => Promise<string>
  store: DiscussionStore
  /** The agent that organizes (drives the workflow). */
  organizer: () => AgentConfig
  /** All configured agents — the participants the organizer may nominate. */
  participants: () => AgentConfig[]
  /** Stream a freshly-appended message to viewers. */
  onMessage: (m: DiscussionMessage) => void
  /** Notify that the discussion's status/conclusion changed (e.g. refresh the list). */
  onStatusChange: (id: string) => void
  /** Round cap per workflow stage (defaults to the system-configured value). */
  maxRoundsPerStage?: number
  /** Total round cap across the whole discussion (hard backstop). */
  maxTotalRounds?: number
  /**
   * Awaited at the top of every round; resolves immediately unless the run is
   * paused, in which case it blocks until resume (or abort). This is how the
   * background carrier suspends the loop without aborting it — while paused no
   * organizer decision is made and no agent speaks, so "no new speech while
   * paused" holds at round boundaries. Absent = the loop never pauses.
   */
  gate?: (signal: AbortSignal) => Promise<void>
}

/**
 * Run the organizer engine for one discussion to completion (or until `signal`
 * aborts). Idempotent against missing discussions; safe to call only on a `draft`
 * (the caller gates that). On normal completion the discussion is `completed`
 * with a non-empty `conclusion`.
 */
export async function runDiscussion(
  id: string,
  signal: AbortSignal,
  deps: DiscussionDeps,
): Promise<void> {
  const { ask, store } = deps
  const initial = store.getDiscussion(id)
  if (!initial) return

  const cwd = initial.projectPath
  const def = getDiscussionType(initial.type)
  const participantCfgs = deps.participants()
  const organizerCfg = deps.organizer()
  const participants: DiscussionParticipant[] = participantCfgs.map((a) => ({
    id: a.id,
    name: a.name,
  }))
  const validIds = participants.map((p) => p.id)
  const byId = new Map(participantCfgs.map((a) => [a.id, a]))
  const maxPerStage = deps.maxRoundsPerStage ?? getMaxRoundsPerStage()
  const maxTotal = deps.maxTotalRounds ?? 40

  // draft → in_progress.
  store.updateDiscussionStatus(id, 'in_progress')
  deps.onStatusChange(id)

  const appendOrganizer = (content: string): void => {
    if (!content.trim()) return
    deps.onMessage(
      store.appendMessage({
        discussionId: id,
        speakerKind: 'organizer',
        speakerAgentId: null,
        speakerName: ORGANIZER_NAME,
        content: content.trim(),
      }),
    )
  }

  const concludeWith = (conclusion: string): void => {
    const text = conclusion.trim() || '(讨论结束,未形成明确结论)'
    appendOrganizer(text)
    store.setConclusion(id, text)
    store.updateDiscussionStatus(id, 'completed')
    deps.onStatusChange(id)
  }

  let stage: DiscussionStageKind = nextDiscussionStage(initial.type)?.id ?? 'discuss'
  let roundsInStage = 0
  let total = 0
  let lastSummary = ''
  // Live agenda, seeded from the persisted discussion (empty ⇒ no agenda yet).
  let agenda: string[] = [...(initial.agenda ?? [])]
  let agendaIndex = initial.agendaIndex ?? 0

  while (!signal.aborted && total < maxTotal) {
    // Pause point: suspend at the round boundary while paused (no decision, no
    // speech) until resume or abort. A no-op when not paused / no gate injected.
    if (deps.gate) await deps.gate(signal)
    if (signal.aborted) break

    const stageDef = def?.workflow.find((s) => s.id === stage)
    if (!stageDef) break // unknown type / exhausted workflow → fall through to fallback conclusion

    const current = store.getDiscussion(id) ?? initial

    // 1) Organizer decides the next step for this stage.
    let decisionText = ''
    try {
      decisionText = await ask(
        organizerCfg,
        buildOrganizerPrompt({
          discussion: current,
          def,
          stage: stageDef,
          messages: store.listMessages(id),
          participants,
          agenda: { items: agenda, index: agendaIndex },
        }),
        cwd,
        signal,
      )
    } catch {
      /* keep '' on failure — parseOrganizerDecision defaults to a safe advance */
    }
    if (signal.aborted) break

    const decision = parseOrganizerDecision(decisionText, validIds)
    const step = resolveStep({
      stage,
      decision,
      validSpeakerIds: validIds,
      roundsInStage,
      maxRoundsPerStage: maxPerStage,
      agenda: { items: agenda, index: agendaIndex },
    })

    if (step.kind === 'conclude') {
      concludeWith(step.conclusion || lastSummary)
      return
    }

    // Set/replace the agenda: subtopics decomposed from the goal; restart at the
    // first subtopic. Stays in `discuss`; `total` bumps as the termination backstop.
    if (step.kind === 'set_agenda') {
      agenda = [...step.subtopics]
      agendaIndex = 0
      store.setAgenda(id, agenda, agendaIndex)
      const announce =
        step.organizerNote.trim() ||
        `议程已设定:${agenda.map((t, i) => `${i + 1}. ${t}`).join(' ')}`
      appendOrganizer(announce)
      roundsInStage = 0
      total++
      continue
    }

    // Move to the next subtopic (per-subtopic round budget resets). Stays in `discuss`.
    if (step.kind === 'focus_subtopic') {
      agendaIndex = step.index
      store.setAgenda(id, agenda, agendaIndex)
      const announce =
        step.organizerNote.trim() ||
        (agenda[agendaIndex] ? `进入子议题:${agenda[agendaIndex]}` : '')
      if (announce) appendOrganizer(announce)
      roundsInStage = 0
      total++
      continue
    }

    if (step.kind === 'advance') {
      if (step.organizerNote.trim()) {
        lastSummary = step.organizerNote.trim()
        appendOrganizer(step.organizerNote)
      }
      // Leaving `discuss` with an agenda set ⇒ every subtopic is done; snap the
      // persisted index to `length` so the state truthfully reads "agenda complete".
      if (stage === 'discuss' && agenda.length > 0 && agendaIndex < agenda.length) {
        agendaIndex = agenda.length
        store.setAgenda(id, agenda, agendaIndex)
      }
      const next = nextDiscussionStage(initial.type, stage)
      if (!next) {
        concludeWith(lastSummary)
        return
      }
      stage = next.id
      roundsInStage = 0
      continue
    }

    // step.kind === 'broadcast' (discuss only): one organizer sub-question, several
    // participants answer in PARALLEL. Speeches are appended in nomination order — not
    // completion order — so `seq` is deterministic no matter which agent finishes first.
    // The whole batch counts as a single round (roundsInStage/total each +1), so the
    // R2 per-subtopic cap and the maxTotalRounds backstop are unaffected.
    if (step.kind === 'broadcast') {
      // Announce the sub-question first, then snapshot the transcript: every participant
      // in the batch sees the same context — the question, but none of the batch's answers.
      if (step.organizerNote.trim()) appendOrganizer(step.organizerNote)
      const snapshot = store.listMessages(id)
      const discussionNow = store.getDiscussion(id) ?? initial
      const batch = step.speakerIds
        .map((sid) => ({ cfg: byId.get(sid), speaker: participants.find((p) => p.id === sid) }))
        .filter(
          (b): b is { cfg: AgentConfig; speaker: DiscussionParticipant } => !!b.cfg && !!b.speaker,
        )
      const prompts = batch.map((b) =>
        buildParticipantPrompt({
          discussion: discussionNow,
          def,
          stage: stageDef,
          messages: snapshot,
          speaker: b.speaker,
          organizerNote: step.organizerNote,
          subtopic: agenda[agendaIndex],
        }),
      )
      const texts = await Promise.all(
        batch.map((b, i) => ask(b.cfg, prompts[i], cwd, signal).catch(() => '')),
      )
      if (signal.aborted) break
      // Sequential, in-order append: under the single synchronous connection each
      // appendMessage takes the next seq, so the batch's seqs match the nomination order.
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i]
        const speech = parseParticipantSpeech(texts[i], b.speaker.name)
        if (speech) {
          deps.onMessage(
            store.appendMessage({
              discussionId: id,
              speakerKind: 'agent',
              speakerAgentId: b.speaker.id,
              speakerName: b.speaker.name,
              content: speech,
            }),
          )
        }
      }
      roundsInStage++
      total++
      continue
    }

    // step.kind === 'speak'
    if (step.organizerNote.trim()) appendOrganizer(step.organizerNote)
    const speakerCfg = byId.get(step.speakerId)
    const speaker = participants.find((p) => p.id === step.speakerId)
    if (speakerCfg && speaker) {
      let speechText = ''
      try {
        speechText = await ask(
          speakerCfg,
          buildParticipantPrompt({
            discussion: store.getDiscussion(id) ?? initial,
            def,
            stage: stageDef,
            messages: store.listMessages(id),
            speaker,
            organizerNote: step.organizerNote,
            subtopic: agenda[agendaIndex],
          }),
          cwd,
          signal,
        )
      } catch {
        /* keep '' on failure — an empty speech is simply skipped below */
      }
      if (signal.aborted) break
      const speech = parseParticipantSpeech(speechText, speaker.name)
      if (speech) {
        deps.onMessage(
          store.appendMessage({
            discussionId: id,
            speakerKind: 'agent',
            speakerAgentId: speaker.id,
            speakerName: speaker.name,
            content: speech,
          }),
        )
      }
    }
    roundsInStage++
    total++
  }

  // Loop ended without an explicit conclusion (total cap reached). Honor the Done
  // contract — write a fallback conclusion and complete — unless we were aborted
  // mid-run (a stopped discussion stays `in_progress`).
  if (!signal.aborted) {
    const cur = store.getDiscussion(id)
    if (cur && cur.status !== 'completed') {
      concludeWith(lastSummary || '(已达讨论轮数上限,未形成最终结论)')
    }
  }
}

/**
 * Build the production {@link DiscussionDeps}: real `askAgentOnce`, the discussion
 * store, settings-derived organizer/participants, and the caller's broadcast
 * hooks. The organizer is the default agent; participants are all configured
 * agents (the organizer included — it may nominate itself, and is the sole
 * speaker when only one agent is configured).
 */
export function defaultDiscussionDeps(hooks: {
  onMessage: (m: DiscussionMessage) => void
  onStatusChange: (id: string) => void
  /** Optional pause gate (the server wires it to its per-run pause control). */
  gate?: (signal: AbortSignal) => Promise<void>
}): DiscussionDeps {
  return {
    ask: askAgentOnce,
    store: {
      getDiscussion: storeGetDiscussion,
      listMessages: storeListMessages,
      appendMessage: storeAppendMessage,
      setConclusion: storeSetConclusion,
      updateDiscussionStatus: storeUpdateStatus,
      setAgenda: storeSetAgenda,
    },
    organizer: () => resolveAgent(null),
    participants: () => loadSettings().agents,
    maxRoundsPerStage: getMaxRoundsPerStage(),
    onMessage: hooks.onMessage,
    onStatusChange: hooks.onStatusChange,
    ...(hooks.gate ? { gate: hooks.gate } : {}),
  }
}
