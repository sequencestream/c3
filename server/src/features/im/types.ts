/**
 * The vendor-neutral IM contract.
 *
 * Shaped after the agent adapter layer (ADR-0011): a small interface plus an
 * honest capability ledger, so a second platform is a new directory and one
 * registry entry rather than a branch threaded through the call sites. It is
 * deliberately NOT modelled on the forge integration, whose two-provider ternary
 * has to be edited in every function to admit a third.
 *
 * A provider is thin on purpose. It owns exactly what is platform-specific —
 * holding the connection, decoding the platform's frames, and delivering a
 * message — and nothing else. Everything a second platform would need in the
 * same form (whether an @-mention is required, dropping a repeat delivery,
 * running one thread at a time, splitting a long reply) lives in the neutral
 * layer above, where it is written once.
 *
 * Providers live under `features/`, never `kernel/`: they reach the network and
 * the platform SDKs, which the kernel boundary forbids (ADR-0009 R1).
 */
import type { ImConnectionStatus, ImPlatform } from '@ccc/shared/protocol'

/**
 * One inbound chat message, normalized. Platform-specific shapes (mention
 * markup, thread vs reply-chain ids, tenant envelopes) are resolved by the
 * provider; what reaches the neutral layer is this.
 */
export interface ImInboundMessage {
  /** Platform message id. The neutral layer uses it to recognise a repeat. */
  messageId: string
  chatId: string
  chatType: 'group' | 'p2p'
  senderId: string
  senderName?: string
  /** Plain-text body with any @-mention markup stripped. */
  text: string
  /** Whether this robot was mentioned. Parsing mentions is platform-specific. */
  mentionedBot: boolean
  /** Platform-native topic id, when the platform has topics and this is in one. */
  threadId?: string
  /** Reply-chain root, when this message is a reply. */
  rootId?: string
  createdAt: number
}

/** A reply to deliver. Only ever the final answer of a turn (ADR-0046). */
export interface ImOutbound {
  text: string
  /** Reply to this message, so the answer lands next to the question. */
  replyTo?: string
}

/**
 * What a provider can honestly do. Stated per capability rather than inferred
 * from the platform's name, so the neutral layer adapts instead of branching on
 * identity — the same reasoning as the agent capability ledger.
 */
export interface ImProviderCapabilities {
  /**
   * The client dials out and holds the link, so c3 needs no reachable address.
   * A provider without it would require an inbound endpoint, which this design
   * does not offer.
   */
  readonly outboundLongPoll: boolean
  /**
   * The platform has native topics. When false, thread identity degrades to
   * "one chat is one conversation" — correct, just coarser.
   */
  readonly threads: boolean
  /** The platform already suppresses repeat deliveries of one message. */
  readonly inboundDedup: boolean
  /** Longest single outbound message; the neutral layer splits to fit. */
  readonly maxOutboundChars: number
}

/** A live link to one robot's platform account. */
export interface ImConnection {
  status(): ImConnectionStatus
  /**
   * Deliver a reply. Rejects on a platform error.
   * Only the outbound guard may call this — supervisors and handlers must use
   * `sendGuarded` / the handle's `sendOutbound` wrapper.
   */
  send(chatId: string, out: ImOutbound): Promise<{ messageId: string }>
  close(): Promise<void>
}

export interface ImConnectInput {
  robotId: string
  appId: string
  /** Decrypted, held in memory only for the life of the connection. */
  appSecret: string
  /** Called for every inbound message the platform delivers, unfiltered. */
  onMessage: (m: ImInboundMessage) => void
  /** Called when the link changes state, so the console can show it. */
  onStateChange?: (s: ImConnectionStatus) => void
}

export interface ImProvider {
  readonly platform: ImPlatform
  readonly capabilities: ImProviderCapabilities
  connect(input: ImConnectInput): Promise<ImConnection>
}
