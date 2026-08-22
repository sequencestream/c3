/**
 * Thread and Conversation identity for IM robots.
 *
 * Conversation identity includes the bound c3 subject and a monotonic
 * `scopeHash` so binding, revoke, or authorization-input changes cut recovery.
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

/**
 * Full Conversation identity — isolation and concurrency boundary after identity
 * binding. Pre-binding traffic never reaches Conversation recovery.
 */
export interface ConversationIdentity {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
  bindingId: string
  subject: string
  scopeHash: string
}

export function conversationIdentityOf(
  platform: ImPlatform,
  robotId: string,
  threadKey: string,
  senderId: string,
  bindingId: string,
  subject: string,
  scopeHash: string,
): ConversationIdentity {
  return { platform, robotId, threadKey, senderId, bindingId, subject, scopeHash }
}

/** In-process serialization gate key for one Conversation. */
export function conversationGateKey(id: ConversationIdentity): string {
  return `${id.platform}::${id.robotId}::${id.threadKey}::${id.senderId}::${id.bindingId}::${id.scopeHash}`
}
