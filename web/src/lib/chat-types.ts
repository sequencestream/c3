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
      /** True when this tool is a user-interaction tool (e.g. AskUserQuestion, ExitPlanMode). */
      isUserInteraction?: boolean
    }
  | {
      kind: 'tool-result'
      toolUseId?: string
      content: string
      isError: boolean
      /** True when the paired tool-use was a user-interaction tool. */
      isUserInteraction?: boolean
    }
  | {
      kind: 'permission'
      requestId: string
      toolName: string
      input: unknown
      decision: 'allow' | 'deny' | null
      /** Agents' opinions when consensus ran but was split. */
      consensus?: AnyConsensusOutcome
      /** True when this tool is a user-interaction tool (e.g. AskUserQuestion, ExitPlanMode). */
      isUserInteraction?: boolean
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
 * A rendered chat block: a free-standing text message; a *batch* of consecutive
 * tool messages (tool-use / tool-result / permission/consensus) grouped between
 * text output; or a *standalone* block for a single user-interaction tool message
 * that renders outside any batch (e.g. AskUserQuestion / ExitPlanMode).
 * A batch is collapsed by default and shows a `Name.count` summary plus a
 * one-line preview of the first tool-use's input (collapsed header only).
 * A standalone block starts expanded and can be collapsed after the interaction
 * is resolved.
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
  | {
      type: 'standalone'
      key: string
      id: number
      /** The single user-interaction tool message rendered outside any batch. */
      msg: ChatMsg
      /** True when the interaction has been resolved (user answered / tool-result arrived). */
      isResolved: boolean
    }
