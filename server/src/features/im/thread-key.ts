/**
 * Thread identity: which messages belong to one continuing conversation.
 *
 * A pure function so the rule is testable on its own and shared by every
 * platform. The order matters and is a product decision, not a technical one:
 *
 *  1. the platform's native topic, when it has topics and the message is in one;
 *  2. otherwise the root of the reply chain, so a reply continues what it replies to;
 *  3. otherwise the chat itself — one chat is one long conversation.
 *
 * The third rule is the interesting one. It means two unrelated questions asked
 * in the same group, outside any topic or reply chain, share one agent session
 * and therefore one context. That is deliberate: in a chat, the previous message
 * usually IS the context. A platform with no topics at all lands here for every
 * message, which is coarse but never wrong.
 */
import type { ImInboundMessage } from './types.js'

export function threadKeyFor(m: Pick<ImInboundMessage, 'chatId' | 'threadId' | 'rootId'>): string {
  const topic = m.threadId?.trim()
  if (topic) return `t:${topic}`
  const root = m.rootId?.trim()
  if (root) return `r:${root}`
  return `c:${m.chatId}`
}
