import type { DiscussionMessage, DiscussionStatus } from '@ccc/shared/protocol'
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
