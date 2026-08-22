/**
 * Thread and Conversation identity for IM robots.
 *
 * `threadKeyFor` is platform-neutral thread scope (topic → reply root → chat).
 * Conversation identity adds platform, robot and sender so different people in
 * the same thread never share recoverable context.
 */
import type { ImPlatform } from '@ccc/shared/protocol'
import type { ImInboundMessage } from './types.js'

export function threadKeyFor(m: Pick<ImInboundMessage, 'chatId' | 'threadId' | 'rootId'>): string {
  const topic = m.threadId?.trim()
  if (topic) return `t:${topic}`
  const root = m.rootId?.trim()
  if (root) return `r:${root}`
  return `c:${m.chatId}`
}

/** Four-dimensional Conversation identity — the isolation and concurrency boundary. */
export interface ConversationIdentity {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
}

export function conversationIdentityOf(
  platform: ImPlatform,
  robotId: string,
  threadKey: string,
  senderId: string,
): ConversationIdentity {
  return { platform, robotId, threadKey, senderId }
}

/** In-process serialization gate key for one Conversation. */
export function conversationGateKey(id: ConversationIdentity): string {
  return `${id.platform}::${id.robotId}::${id.threadKey}::${id.senderId}`
}
