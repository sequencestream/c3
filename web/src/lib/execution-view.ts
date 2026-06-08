import type { TranscriptItem } from '@ccc/shared/protocol'
import type { ChatBody, ChatMsg } from './chat-types'

/*
 * execution-view — pure mapper for the read-only execution transcript.
 *
 * The execution Session tab reuses the session chat renderer (ChatMessages), so
 * each persisted `TranscriptItem` is normalized into a `ChatBody` then a `ChatMsg`
 * (with an auto-incrementing id). The renderer is read-only: no permission
 * responses, no streaming, no continue interaction.
 *
 * Pure & defensive: empty or malformed transcripts produce an empty list; unknown
 * future kinds fall through to a `system` kind as a safety net (never throws).
 */

/**
 * Map one `TranscriptItem` to a `ChatBody`. The transcript is a historical replay
 * (never pending/streaming), so `tool_use` items carry no `preApproved` flag and
 * `permission`/`consensus` kinds are absent — the raw tool replay skips the
 * permission layer entirely (the permission prompt was resolved in the live
 * session; the transcript only records the tool calls and results).
 */
export function transcriptItemToChat(item: TranscriptItem): ChatBody {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.text }
    case 'assistant':
      return { kind: 'assistant', text: item.text }
    case 'tool_use':
      return {
        kind: 'tool-use',
        toolUseId: item.toolUseId,
        toolName: item.toolName,
        input: item.input,
      }
    case 'tool_result':
      return {
        kind: 'tool-result',
        toolUseId: item.toolUseId,
        content: item.content,
        isError: item.isError,
      }
    case 'notice':
      // A thinking-only turn with no visible output — render as a muted system line.
      return { kind: 'system', text: item.text }
    default:
      // Safety net for future untagged kinds — render as a system line so the
      // chat doesn't silently swallow them.
      return { kind: 'system', text: JSON.stringify(item) }
  }
}

/**
 * Map a full `TranscriptItem[]` to `ChatMsg[]` for the ChatMessages renderer.
 * Each entry gets an auto-incrementing numeric id (0-based) so Vue's `:key`
 * binding stays stable across re-renders of the same transcript.
 *
 * Returns an empty array for `null` / `undefined` / empty input.
 */
export function transcriptToChat(items: TranscriptItem[] | null | undefined): ChatMsg[] {
  if (!items) return []
  return items.map((item, i) => ({ ...transcriptItemToChat(item), id: i }))
}
