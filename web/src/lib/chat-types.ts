import type { AnyConsensusOutcome, VendorId } from '@ccc/shared/protocol'

/**
 * Chat model shared across the message-rendering components. A `ChatMsg` is one
 * normalized entry in the flat transcript buffer; `Block` is the grouped render
 * unit (free-standing text, or a collapsible batch of tool messages).
 */

/**
 * Optional speaker meta attached to a `user` / `assistant` text bubble. Set by
 * the discussion path (multi-speaker chat) so the renderer can draw a small
 * 「icon + name」 line above the body; the session path never sets it, so the
 * shared `ChatMessages` renderer leaves the bubble header-less.
 */
export interface SpeakerView {
  /** Display icon: an emoji or short text. Never empty — resolvers always fall back. */
  icon: string
  /** Display name (agent's name, or an i18n role label for unnamed human turns). */
  name: string
  /**
   * The vendor backing this speaker, resolved from the agent config by
   * `speakerAgentId` (2026-06-06-004). Set only for `agent` turns in a
   * heterogeneous discussion so the renderer can draw a small vendor tag —
   * a Claude turn and an OpenCode turn are visually distinguishable while both
   * normalize to the same canonical bubble. Absent for human/organizer turns.
   */
  vendor?: VendorId
}

export type ChatBody =
  | { kind: 'user'; text: string; speaker?: SpeakerView }
  | { kind: 'assistant'; text: string; speaker?: SpeakerView }
  | {
      kind: 'tool-use'
      toolUseId?: string
      toolName: string
      input: unknown
      preApproved?: boolean
    }
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

/**
 * Fine-grained run activity for the viewed session, inferred entirely on the
 * client from the event stream (the server only sends events for the session a
 * connection is viewing). Drives the status bar above the input box; the
 * authoritative on/off remains `sessionStatus` (server-broadcast).
 * - `idle` — no turn in flight (the input is free).
 * - `thinking` — a turn is running and the model is producing text / deciding.
 * - `tool` — a tool call is executing (`toolName` is the running tool).
 * - `awaiting` — blocked on a permission decision.
 * - `error` — the last turn failed; held until the next prompt clears it.
 */
export type RunActivity =
  | { phase: 'idle' }
  | { phase: 'thinking' }
  | { phase: 'tool'; toolName: string }
  | { phase: 'awaiting' }
  | { phase: 'error'; message: string }
export type TextMsg = Extract<ChatMsg, { kind: 'user' | 'assistant' | 'system' }>

/**
 * A rendered chat block: either a free-standing text message, or a *batch* of
 * consecutive tool messages (tool-use / tool-result / permission) bounded by
 * text output. A batch is collapsed by default and shows a `Name.count` summary
 * plus a one-line preview of the first tool-use's input (collapsed header only).
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
      /** One-line `oneLine(fmt(input))` of the batch's first tool-use; '' when the batch has none. */
      preview: string
      hasPending: boolean
    }
