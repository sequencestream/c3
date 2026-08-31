import type { ImRobot } from '@ccc/shared/protocol'
import type { ImInboundMessage } from './types.js'

export function accepts(r: ImRobot, m: ImInboundMessage): boolean {
  if (m.chatType === 'group')
    return (
      (!r.requireMention || m.mentionedBot) &&
      (!r.chatAllowlist.length || r.chatAllowlist.includes(m.chatId))
    )
  return r.dmMode === 'open' || (r.dmMode === 'allowlist' && r.dmAllowlist.includes(m.senderId))
}

/**
 * Group-only admission guard: silently drop group messages the robot would not
 * answer. Used before todo, binding, and unbound-identity control paths.
 */
export function rejectGroupNotAccepted(r: ImRobot, m: ImInboundMessage): boolean {
  return m.chatType === 'group' && !accepts(r, m)
}
