import type { Discussion, DiscussionMessage, DiscussionStatus } from '@ccc/shared/protocol'
import type { ChatBody } from './chat-types'

/*
 * discussion-view — pure mappers for the read-only discussion transcript.
 *
 * The discussion right pane reuses the session chat renderer (ChatMessages), so
 * each persisted `DiscussionMessage` is normalized into a `ChatBody`. The human
 * speaks as `user`; the organizer and agents render as `assistant`. The renderer
 * shows plain text only, so a speaker name is prefixed (for non-human turns) to
 * keep multi-agent discussions legible.
 */
export function discussionMessageToChat(m: DiscussionMessage): ChatBody {
  if (m.speakerKind === 'human') return { kind: 'user', text: m.content }
  const text = m.speakerName ? `${m.speakerName}: ${m.content}` : m.content
  return { kind: 'assistant', text }
}

export function discussionMessagesToChat(messages: DiscussionMessage[]): ChatBody[] {
  return messages.map(discussionMessageToChat)
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

/**
 * Auto-grow geometry for a textarea: given its natural content height
 * (`scrollHeight`, measured after resetting `height` to `auto`) and a pixel cap,
 * return the height to apply and whether an inner scrollbar is needed. The
 * textarea grows with its content up to `maxPx`; beyond that it stays fixed and
 * scrolls internally. Pure, so it is unit-tested without a DOM.
 */
export interface AutoGrowStyle {
  height: number
  overflowY: 'auto' | 'hidden'
}

export function autoGrowHeight(scrollHeight: number, maxPx: number): AutoGrowStyle {
  return {
    height: Math.min(scrollHeight, maxPx),
    overflowY: scrollHeight > maxPx ? 'auto' : 'hidden',
  }
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
