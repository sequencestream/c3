import type { AnyConsensusOutcome } from '@ccc/shared/protocol'

/**
 * Chat model shared across the message-rendering components. A `ChatMsg` is one
 * normalized entry in the flat transcript buffer; `Block` is the grouped render
 * unit (free-standing text, or a collapsible batch of tool messages).
 */
export type ChatBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-use'; toolUseId?: string; toolName: string; input: unknown }
  | { kind: 'tool-result'; toolUseId?: string; content: string; isError: boolean }
  | {
      kind: 'permission'
      requestId: string
      toolName: string
      input: unknown
      decision: 'allow' | 'deny' | null
      /** Agents' opinions when consensus ran but was split. */
      consensus?: AnyConsensusOutcome
    }
  | {
      kind: 'consensus'
      toolName: string
      input: unknown
      outcome: AnyConsensusOutcome
    }
  | { kind: 'system'; text: string }

export type ChatMsg = ChatBody & { id: number }
export type PermissionMsg = Extract<ChatMsg, { kind: 'permission' }>
export type TextMsg = Extract<ChatMsg, { kind: 'user' | 'assistant' | 'system' }>

/**
 * A rendered chat block: either a free-standing text message, or a *batch* of
 * consecutive tool messages (tool-use / tool-result / permission) bounded by
 * text output. A batch is collapsed by default and shows a `Name.count` summary.
 */
export type Block =
  | { type: 'text'; key: string; msg: TextMsg }
  | {
      type: 'batch'
      key: string
      id: number
      msgs: ChatMsg[]
      /** Render order: each tool-result moved directly under its tool-use, flagged for indent. */
      rows: { msg: ChatMsg; indent: boolean }[]
      summary: string
      hasPending: boolean
    }
