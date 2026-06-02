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
