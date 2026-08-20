/**
 * The last check before text leaves the machine for a chat platform.
 *
 * ADR-0046 requires it: an answer that happens to contain a credential shape is
 * not delivered, and the refusal never quotes what it matched. The credential
 * patterns are shared with the memory guard rather than restated here — one set
 * of rules, one place to improve them.
 *
 * It deliberately does NOT apply the memory guard's artifact rules. Those refuse
 * code fences and transcript framing, which is right for a durable note and
 * wrong here: a robot answering a question about code will legitimately reply
 * with a code block, and refusing that would make the robot useless for its most
 * common question.
 *
 * Nothing here pretends to be complete. Shape detection stops the well-known
 * credential formats; it cannot stop a secret written out in prose.
 */
import { detectCredentialShape } from '../memory/content-guard.js'

export type OutboundVerdict = { ok: true; text: string } | { ok: false; reason: 'credential' }

/**
 * Decide whether an answer may be sent, and cut it to what the platform accepts.
 *
 * Truncation is visible: the reader is told the answer was cut rather than being
 * handed a sentence that simply stops. The full answer stays available in the
 * session itself.
 */
export function screenOutbound(text: string, maxChars: number): OutboundVerdict {
  if (detectCredentialShape(text)) return { ok: false, reason: 'credential' }

  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return { ok: true, text: trimmed }

  const notice = '\n…（回答过长已截断,完整内容见 c3 会话）'
  return { ok: true, text: `${trimmed.slice(0, Math.max(0, maxChars - notice.length))}${notice}` }
}
