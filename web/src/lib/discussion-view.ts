import type {
  AgentConfig,
  Discussion,
  DiscussionMessage,
  DiscussionStatus,
  ResearchMessage,
} from '@ccc/shared/protocol'
import type { ChatBody, SpeakerView } from './chat-types'

/*
 * discussion-view — pure mappers for the read-only discussion transcript.
 *
 * The discussion right pane reuses the session chat renderer (ChatMessages), so
 * each persisted `DiscussionMessage` is normalized into a `ChatBody`. The human
 * speaks as `user`; the organizer and agents render as `assistant`. The renderer
 * shows a small 「icon + name」 line above each body when `ChatBody.speaker` is
 * set (set here for discussion messages; never set by the session path), so the
 * multi-agent discussion reads as a real chat. Name prefixes are no longer
 * inlined into the body — they live on the speaker line.
 */

/**
 * Fallback icons used when the configured agent has no `icon` (or the speaker
 * can't be resolved to an agent). Kept module-private: callers always go
 * through `resolveDiscussionSpeaker` so the fallback is consistent.
 */
const HUMAN_FALLBACK_ICON = '🙋'
const AGENT_FALLBACK_ICON = '🤖'

/**
 * Resolve the speaker meta for a discussion message. The rules:
 *
 * - `human` — always renders the fixed human icon and the i18n 「You」 label
 *   (humans have no agent profile, so there is nothing to look up).
 * - `organizer` — the organizer is the default agent (server-side
 *   `resolveAgent(null) === agents.find(a => a.id === defaultAgentId)`); use
 *   that agent's `icon` and `name`. If the agent can't be found or has no icon,
 *   fall back to the generic agent icon and the i18n 「Organizer」 label.
 * - `agent` — look up `m.speakerAgentId` in `agents`; use the agent's `icon` and
 *   `m.speakerName`. If the agent is missing or has no icon, fall back to the
 *   generic agent icon; the name falls back to `m.speakerName` itself, or the
 *   i18n 「Agent」 label as a last resort (defensive — the server should always
 *   set a name for an agent turn).
 *
 * Pure & defensive: empty `agents` list, missing `defaultAgentId`, or unknown
 * ids all fall through to the fixed fallbacks — never throws, never returns an
 * empty icon.
 */
export function resolveDiscussionSpeaker(
  m: DiscussionMessage,
  agents: readonly AgentConfig[],
  defaultAgentId: string | null | undefined,
  t: (
    key: 'discussion.speaker.you' | 'discussion.speaker.organizer' | 'discussion.speaker.agent',
  ) => string,
): SpeakerView {
  if (m.speakerKind === 'human') {
    return { icon: HUMAN_FALLBACK_ICON, name: t('discussion.speaker.you') }
  }
  if (m.speakerKind === 'organizer') {
    const agent = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) : undefined
    if (agent) {
      return { icon: agent.icon?.trim() || AGENT_FALLBACK_ICON, name: agent.name }
    }
    return { icon: AGENT_FALLBACK_ICON, name: t('discussion.speaker.organizer') }
  }
  // 'agent'
  const agent = m.speakerAgentId ? agents.find((a) => a.id === m.speakerAgentId) : undefined
  if (agent) {
    return {
      icon: agent.icon?.trim() || AGENT_FALLBACK_ICON,
      name: m.speakerName ?? agent.name,
    }
  }
  return {
    icon: AGENT_FALLBACK_ICON,
    name: m.speakerName || t('discussion.speaker.agent'),
  }
}

export function discussionMessageToChat(
  m: DiscussionMessage,
  agents: readonly AgentConfig[],
  defaultAgentId: string | null | undefined,
  t: (
    key: 'discussion.speaker.you' | 'discussion.speaker.organizer' | 'discussion.speaker.agent',
  ) => string,
): ChatBody {
  const speaker = resolveDiscussionSpeaker(m, agents, defaultAgentId, t)
  if (m.speakerKind === 'human') return { kind: 'user', text: m.content, speaker }
  return { kind: 'assistant', text: m.content, speaker }
}

export function discussionMessagesToChat(
  messages: DiscussionMessage[],
  agents: readonly AgentConfig[],
  defaultAgentId: string | null | undefined,
  t: (
    key: 'discussion.speaker.you' | 'discussion.speaker.organizer' | 'discussion.speaker.agent',
  ) => string,
): ChatBody[] {
  return messages.map((m) => discussionMessageToChat(m, agents, defaultAgentId, t))
}

/*
 * Left-panel view helpers — mirror the requirement list's collapse/accordion
 * paradigm (see req-list-view.ts) but with discussion-flavored wording, so the
 * two lists stay visually consistent without coupling their copy. Pure, so they
 * are unit-tested in the DOM-less web test env.
 */

/** Status label for the colored pill. The pill uses the status value as a CSS class for its semantic color. */
export const STATUS_LABELS: Record<DiscussionStatus, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export function statusLabel(s: DiscussionStatus): string {
  return STATUS_LABELS[s] ?? s
}

/**
 * Title-bar status text for the open discussion's right pane. A `draft` reads as
 * `Researching…` — after create the context-research agent runs and the server
 * auto-starts the orchestration on success, so a lingering draft means research
 * has not yet completed-and-auto-started (a manual Start stays as a fallback).
 * `in_progress` reflects the live run-state (paused vs running); terminal states
 * map to their label. Pure, so it is unit-tested DOM-free.
 */
export function discussionRunLabel(
  status: DiscussionStatus,
  runState: 'running' | 'paused' | undefined,
): string {
  if (status === 'draft') return 'Researching…'
  if (status === 'in_progress') return runState === 'paused' ? 'Paused' : 'Running'
  return status === 'completed' ? 'Completed' : 'Cancelled'
}

/**
 * Reconcile the global per-discussion run-state map against a project's `discussions` snapshot.
 *
 * The server rides a `runStates` snapshot (id → running/paused, only active runs present) on every
 * `discussions` send. A freshly-(re)connected view misses the transition-only `discussion_run_status`
 * events, and a soft reconnect may have missed an `ended` — so on each list arrival we make the map
 * authoritative for THIS list's discussions: each listed id is set from the snapshot or dropped when
 * absent. Other projects' entries (ids not in `items`) are left intact, so the cross-project map stays
 * correct. Returns a new object (never mutates `prev`). Pure, so it is unit-tested DOM-free.
 */
export function reconcileRunState(
  prev: Record<string, 'running' | 'paused'>,
  items: Pick<Discussion, 'id'>[],
  snapshot: Record<string, 'running' | 'paused'> | undefined,
): Record<string, 'running' | 'paused'> {
  if (!snapshot) return prev
  const next = { ...prev }
  for (const { id } of items) {
    const state = snapshot[id]
    if (state) next[id] = state
    else delete next[id]
  }
  return next
}

/*
 * Research phase — the right pane's two phases (research stream → discussion stream)
 * and the manual Start fallback. Research liveness is runtime-only: streamed
 * `research_message` items + a `running`/`ended` `research_run_status`, snapshotted on
 * the `discussions` list as `researchStates` (id → `running`) so a reconnect mid-research
 * stays on the research phase. Pure helpers, unit-tested DOM-free.
 */

const RESEARCHER_ICON = '🔍'

/** Right-pane phase for the open discussion: the live research stream, or the discussion stream. */
export type DiscussionPhase = 'research' | 'discussion'

/** Research is showing iff its run is live; otherwise the discussion stream owns the pane. */
export function discussionPhase(researchLive: boolean): DiscussionPhase {
  return researchLive ? 'research' : 'discussion'
}

/**
 * Whether the manual Start fallback shows. Replaces the old `status === 'draft'` rule:
 * a draft auto-starts after research, so Start is only the fallback for a draft whose
 * research has ended/died (`!researchLive`) and whose orchestration has not started
 * (`!discussionLive`) — e.g. research failed and never auto-started. Pure.
 */
export function showDiscussionStart(
  status: DiscussionStatus,
  researchLive: boolean,
  discussionLive: boolean,
): boolean {
  return status === 'draft' && !researchLive && !discussionLive
}

/**
 * Map one streamed `ResearchMessage` to a `ChatBody` for the research stream. A `text`
 * turn renders as an assistant bubble under the 「researcher」 speaker; a `tool` turn
 * renders as a system line (`labels.tool` formats the tool name). Pure & DOM-free.
 */
export function researchMessageToChat(
  m: ResearchMessage,
  labels: { researcher: string; tool: (toolName: string) => string },
): ChatBody {
  if (m.kind === 'tool') return { kind: 'system', text: labels.tool(m.content) }
  return {
    kind: 'assistant',
    text: m.content,
    speaker: { icon: RESEARCHER_ICON, name: labels.researcher },
  }
}

/**
 * Reconcile the global per-discussion research-state map against a `discussions` snapshot.
 * Mirrors {@link reconcileRunState} but the only live value is `running`: each listed id is
 * set from the snapshot (present) or dropped (absent, research ended). Other projects' ids
 * are left intact. Returns a new object. Pure, unit-tested DOM-free.
 */
export function reconcileResearchState(
  prev: Record<string, 'running'>,
  items: Pick<Discussion, 'id'>[],
  snapshot: Record<string, 'running'> | undefined,
): Record<string, 'running'> {
  if (!snapshot) return prev
  const next = { ...prev }
  for (const { id } of items) {
    if (snapshot[id]) next[id] = 'running'
    else delete next[id]
  }
  return next
}

/*
 * Dispatch (in-flight) status — the transient per-discussion view of which agents
 * the organizer just dispatched are replying (`pending`) and which failed
 * (`errors`). Driven by the runtime-only `discussion_dispatch_status` event plus
 * the reply-message stream; never persisted. Pure reducers, unit-tested DOM-free.
 *
 * Self-healing (mirrors `discussion_run_status`): a `pending` agent leaves the set
 * via `cleared`, `failed`, or its reply `discussion_message`; the whole view is
 * dropped on discussion switch / run `ended`. So a refresh/reconnect (which starts
 * empty) never leaves a stuck pending — any late clear/fail/message is a no-op.
 */
export interface DispatchAgentView {
  id: string
  name: string
}

export interface DispatchErrorView {
  id: string
  name: string
  error: string
}

export interface DispatchView {
  /** Agents currently replying, in arrival order (a broadcast adds several at once). */
  pending: DispatchAgentView[]
  /** Transient failures surfaced in the chat tail. */
  errors: DispatchErrorView[]
}

/** Shape of the `discussion_dispatch_status` event (sans `type`/`discussionId`). */
export interface DispatchStatusEvent {
  phase: 'pending' | 'cleared' | 'failed'
  agents: DispatchAgentView[]
  error?: string
}

const EMPTY_DISPATCH: DispatchView = { pending: [], errors: [] }

/**
 * Apply one `discussion_dispatch_status` event to a discussion's dispatch view.
 *
 * - `pending`: append the agents (de-duped by id, arrival order preserved) and drop
 *   any stale error for those agents (a re-dispatch supersedes a prior failure).
 * - `cleared`: remove the agents from `pending`.
 * - `failed`: remove the agent from `pending` and record an error (de-duped by id).
 *
 * Returns a new object (never mutates `prev`).
 */
export function applyDispatchStatus(
  prev: DispatchView | undefined,
  ev: DispatchStatusEvent,
): DispatchView {
  const base = prev ?? EMPTY_DISPATCH
  if (ev.phase === 'cleared') {
    const drop = new Set(ev.agents.map((a) => a.id))
    return { pending: base.pending.filter((a) => !drop.has(a.id)), errors: base.errors }
  }
  if (ev.phase === 'failed') {
    const a = ev.agents[0]
    if (!a) return { pending: [...base.pending], errors: [...base.errors] }
    return {
      pending: base.pending.filter((p) => p.id !== a.id),
      errors: [
        ...base.errors.filter((e) => e.id !== a.id),
        { id: a.id, name: a.name, error: ev.error ?? 'failed to reply' },
      ],
    }
  }
  // pending
  const add = new Set(ev.agents.map((a) => a.id))
  const pending = [...base.pending.filter((a) => !add.has(a.id)), ...ev.agents]
  const errors = base.errors.filter((e) => !add.has(e.id))
  return { pending, errors }
}

/**
 * Clear a single agent's `pending` entry when its reply message arrives (matched by
 * `speakerAgentId`). Snappy primary clear for the message path — redundant with the
 * server's `cleared`, idempotent. Returns `prev` unchanged when nothing matches.
 */
export function clearDispatchAgent(
  prev: DispatchView | undefined,
  agentId: string | null | undefined,
): DispatchView | undefined {
  if (!prev || !agentId) return prev
  if (!prev.pending.some((a) => a.id === agentId)) return prev
  return { pending: prev.pending.filter((a) => a.id !== agentId), errors: prev.errors }
}

/*
 * Detail accordion tabs — the expanded row shows one field at a time behind a tab
 * bar instead of stacking goal / context / conclusion vertically. Goal / context /
 * conclusion tabs render their text as Markdown (via MarkdownText :markdown); a
 * trailing always-present `details` tab carries the structured meta (type / status /
 * timestamps), which the component renders itself rather than as Markdown.
 *
 * Empty markdown fields are dropped so no blank tab shows; `details` always exists,
 * so the list is never empty and the first tab is a safe default. Pure, so it is
 * unit-tested DOM-free; the component just reads the order and resets the active
 * tab to `tabs[0]` when the expanded row changes.
 */
export type DiscussionTabKind = 'goal' | 'context' | 'conclusion' | 'details'

export interface DiscussionTab {
  kind: DiscussionTabKind
  label: string
  /** Markdown body for goal/context/conclusion; `null` for the structured `details` tab. */
  body: string | null
}

export function discussionDetailTabs(d: Discussion): DiscussionTab[] {
  const tabs: DiscussionTab[] = []
  const goal = d.goal?.trim()
  const context = d.context?.trim()
  const conclusion = d.conclusion?.trim()
  if (goal) tabs.push({ kind: 'goal', label: 'Goal', body: d.goal })
  if (context) tabs.push({ kind: 'context', label: 'Context', body: d.context })
  if (conclusion) tabs.push({ kind: 'conclusion', label: 'Conclusion', body: d.conclusion })
  tabs.push({ kind: 'details', label: 'Details', body: null })
  return tabs
}

/** Header toggle button copy + title, reflecting the state it switches *to* on click. */
export interface ToggleLabel {
  icon: string
  text: string
  title: string
}

export function panelToggleLabel(collapsed: boolean): ToggleLabel {
  return collapsed
    ? {
        icon: '⇥',
        text: 'Expand',
        title: 'Expand the discussion list (show type and timestamps)',
      }
    : {
        icon: '⇤',
        text: 'Collapse',
        title: 'Collapse the discussion list (hide secondary info to free up chat space)',
      }
}

/** Whether a row's secondary meta (type / timestamps) renders in the current collapse state. */
export interface RowVisibility {
  showMeta: boolean
}

export function rowVisibility(collapsed: boolean): RowVisibility {
  return { showMeta: !collapsed }
}

/*
 * Agenda progress view — the explicit agenda the organizer engine decomposes the
 * discussion goal into (see discussion `agenda-engine`). `Discussion.agenda` is the
 * ordered subtopic list; `Discussion.agendaIndex` is the 0-based current subtopic
 * (`index === length` ⇒ every subtopic is done). The index is the single source of
 * completion: items before it are done, the item at it is current, the rest upcoming.
 *
 * Pure & defensive: `agendaIndex` is clamped to `[0, length]` so a stale/garbage
 * index can never produce a negative percent or an out-of-range "current". Unit-tested
 * DOM-free; the live update (engine advances the index → `discussions` re-broadcast →
 * `activeDiscussion` refresh) drives re-render with no extra state.
 */
export type AgendaItemStatus = 'done' | 'current' | 'upcoming'

export interface AgendaItemView {
  text: string
  status: AgendaItemStatus
  index: number
}

export interface AgendaProgressView {
  /** Render only when a discussion has an agenda (`agenda.length > 0`). */
  visible: boolean
  items: AgendaItemView[]
  /** Title of the current subtopic, or `null` when the agenda is complete. */
  current: string | null
  /** Completed subtopic count = clamped index. */
  completed: number
  /** Total subtopics = `agenda.length`. */
  total: number
  /** Integer 0–100; `0` when there is no agenda. */
  percent: number
  /** Every subtopic done (`completed >= total`, with `total > 0`). */
  complete: boolean
}

export function agendaProgressView(d: Discussion | null): AgendaProgressView {
  const agenda = d?.agenda ?? []
  const total = agenda.length
  if (total === 0) {
    return {
      visible: false,
      items: [],
      current: null,
      completed: 0,
      total: 0,
      percent: 0,
      complete: false,
    }
  }
  const raw = d?.agendaIndex ?? 0
  const idx = Math.min(Math.max(Math.trunc(raw), 0), total)
  const items: AgendaItemView[] = agenda.map((text, index) => ({
    text,
    index,
    status: index < idx ? 'done' : index === idx ? 'current' : 'upcoming',
  }))
  const complete = idx >= total
  return {
    visible: true,
    items,
    current: complete ? null : agenda[idx],
    completed: idx,
    total,
    percent: Math.round((idx / total) * 100),
    complete,
  }
}
