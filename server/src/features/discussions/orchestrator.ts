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
import { askAgentOnce } from '../../agent-once.js'
import { enabledAgents, resolveAgent } from '../../kernel/agent-config/index.js'
import { getMaxRoundsPerStage, getMaxSpeechChars } from '../../kernel/config/index.js'
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

/** Minimal identity of a dispatched participant, carried by {@link DispatchStatus}. */
export interface DispatchAgent {
  id: string
  name: string
}

/**
 * A runtime-only, transient in-flight signal for the agents the organizer just
 * dispatched — emitted via {@link DiscussionDeps.onDispatchStatus} before/after the
 * `askAgentOnce` turn so viewers see who is replying. Never persisted, never a
 * `discussion_message`.
 *
 * - `pending`: `agents` were dispatched and are now replying (`broadcast` lists several).
 * - `cleared`: `agents` finished — drop them from the in-flight set. The reliable
 *   clear for an empty/skipped speech (which appends no message).
 * - `failed`: `agent` failed to reply (`error` is brief); the speech is skipped and
 *   the round still proceeds.
 */
export type DispatchStatus =
  | { phase: 'pending'; agents: DispatchAgent[] }
  | { phase: 'cleared'; agents: DispatchAgent[] }
  | { phase: 'failed'; agent: DispatchAgent; error: string }

/** Brief, human-readable reason from a thrown agent turn (for the `failed` status). */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.trim() || 'agent failed to reply'
}

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
  /**
   * Emit the transient in-flight status of dispatched participants (pending →
   * cleared/failed) so viewers see who is replying. Runtime-only, not persisted.
   * Absent = no dispatch signal is surfaced (the loop runs identically).
   */
  onDispatchStatus?: (s: DispatchStatus) => void
  /** Round cap per workflow stage (defaults to the system-configured value). */
  maxRoundsPerStage?: number
  /**
   * Per-turn character budget for participant speech (prompt-level guidance).
   * Defaults to the system-configured value when absent.
   */
  maxSpeechChars?: number
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
    name: a.displayName,
  }))
  const validIds = participants.map((p) => p.id)
  const byId = new Map(participantCfgs.map((a) => [a.id, a]))
  const maxPerStage = deps.maxRoundsPerStage ?? getMaxRoundsPerStage(cwd)
  const speechBudget = deps.maxSpeechChars ?? getMaxSpeechChars(cwd)
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
      // Re-broadcast the discussion list so viewers see the new agenda live (the
      // persisted agenda/index rides the refreshed `discussions` push).
      deps.onStatusChange(id)
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
      // Live-broadcast the advanced agenda index (current subtopic moved forward).
      deps.onStatusChange(id)
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
          maxSpeechChars: speechBudget,
        }),
      )
      // Surface the whole batch as in-flight before awaiting; broadcast may have
      // several agents replying at once.
      deps.onDispatchStatus?.({ phase: 'pending', agents: batch.map((b) => b.speaker) })
      // Settle (not all-or-nothing): a thrown turn is exposed as `failed` rather than
      // silently swallowed into an empty speech, while the rest of the batch proceeds.
      const results = await Promise.allSettled(
        batch.map((b, i) => ask(b.cfg, prompts[i], cwd, signal)),
      )
      if (signal.aborted) break
      // Sequential, in-order append: under the single synchronous connection each
      // appendMessage takes the next seq, so the batch's seqs match the nomination order.
      const settled: DispatchAgent[] = []
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i]
        const r = results[i]
        if (r.status === 'rejected') {
          // Failure is exposed (not appended); the round still proceeds.
          deps.onDispatchStatus?.({ phase: 'failed', agent: b.speaker, error: errText(r.reason) })
          continue
        }
        settled.push(b.speaker)
        const speech = parseParticipantSpeech(r.value, b.speaker.name)
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
      // Clear the non-failed agents (covers empty/skipped speeches that append no
      // message); failed ones were already dropped from pending by their `failed`.
      if (settled.length) deps.onDispatchStatus?.({ phase: 'cleared', agents: settled })
      roundsInStage++
      total++
      continue
    }

    // step.kind === 'speak'
    if (step.organizerNote.trim()) appendOrganizer(step.organizerNote)
    const speakerCfg = byId.get(step.speakerId)
    const speaker = participants.find((p) => p.id === step.speakerId)
    if (speakerCfg && speaker) {
      const dispatched: DispatchAgent = { id: speaker.id, name: speaker.name }
      deps.onDispatchStatus?.({ phase: 'pending', agents: [dispatched] })
      let speechText = ''
      let failed = false
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
            maxSpeechChars: speechBudget,
          }),
          cwd,
          signal,
        )
      } catch (err) {
        // Expose the failure (not silently swallowed into an empty speech); the
        // speech is skipped and the round still proceeds.
        failed = true
        deps.onDispatchStatus?.({ phase: 'failed', agent: dispatched, error: errText(err) })
      }
      if (signal.aborted) break
      if (!failed) {
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
        // Clear pending (covers an empty/skipped speech that appends no message).
        deps.onDispatchStatus?.({ phase: 'cleared', agents: [dispatched] })
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
  /** Stream the transient dispatch (in-flight/failed) status of nominated agents. */
  onDispatchStatus?: (s: DispatchStatus) => void
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
    participants: () => enabledAgents(),
    // Deps values are optional overrides — the actual per-project defaults are
    // resolved inside `runDiscussion` from the discussion's project path.
    maxRoundsPerStage: undefined,
    maxSpeechChars: undefined,
    onMessage: hooks.onMessage,
    onStatusChange: hooks.onStatusChange,
    ...(hooks.onDispatchStatus ? { onDispatchStatus: hooks.onDispatchStatus } : {}),
    ...(hooks.gate ? { gate: hooks.gate } : {}),
  }
}
