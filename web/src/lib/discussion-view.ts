import type { DiscussionMessage } from '@ccc/shared/protocol'
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
