import type { TranscriptItem } from '@ccc/shared/protocol'
import type { ChatBody } from '@/lib/chat-types'

// Map a server `TranscriptItem` (on-disk history baseline) into a chat bubble
// body. Pure — shared by the session-select history replay and any other
// transcript renderer; the live stream events have their own per-type mapping.
export function transcriptToChat(item: TranscriptItem): ChatBody {
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
      return { kind: 'system', text: item.text }
  }
}
