/**
 * The sole controlled outbound entry for IM replies.
 *
 * Every final answer and every registered fixed notice leaves the machine only
 * through {@link sendGuarded}. The supervisor never holds a raw sender: provider
 * `ImConnection.send` / platform HTTP APIs stay inside the provider, and this
 * module is the only caller that may invoke a bound `rawSend`.
 *
 * Decision order (re-read live robot state each time — never reuse the inbound
 * accept snapshot):
 *   1. robot still enabled and outboundAckAt recorded
 *   2. target is still the inbound chat; group/DM allowlists still pass
 *   3. content is a final answer or a registered fixed notice
 *   4. final answers: credential shape refuse → swap to intercept notice (no
 *      recursive credential scan); all texts truncated to the platform limit
 *   5. rawSend; callers audit from the result (success / refuse / send failure)
 *
 * Credential shape rules are shared with the memory guard. Artifact rules are
 * deliberately NOT applied here: a robot answering about code must be allowed
 * to send a code fence.
 */
import type { ImRobot } from '@ccc/shared/protocol'
import { detectCredentialShape } from '../memory/content-guard.js'
import { getRobot } from './robot-store.js'
import type { ImOutbound } from './types.js'

/** Fixed control prompts. Bodies are registered here so free text cannot sneak in. */
export const FIXED_NOTICES = {
  timeout: '这个问题处理超时了,已经中止。',
  blocked: '这一步需要人工授权,我在群里无法完成。请到 c3 中继续。',
  error: '处理时出错了,请到 c3 会话中查看详情。',
  guard_refused: '回答里包含疑似凭据的内容,已拦下未发送。请到 c3 会话中查看。',
  busy: '上一个问题还在处理,稍后再问我。',
} as const

export type FixedNoticeId = keyof typeof FIXED_NOTICES

export type OutboundContent =
  { category: 'final_answer'; text: string } | { category: 'fixed_notice'; notice: FixedNoticeId }

export type OutboundTarget = {
  chatId: string
  chatType: 'group' | 'p2p'
  /** Needed to re-check dm allowlist at send time. */
  senderId: string
  replyTo: string
}

export type RawImSend = (chatId: string, out: ImOutbound) => Promise<{ messageId: string }>

export type GuardRefuseReason =
  | 'disabled'
  | 'outbound_not_acknowledged'
  | 'chat_not_allowed'
  | 'dm_not_allowed'
  | 'credential'
  | 'empty'
  | 'send_failed'

export type GuardedSendInput = {
  robotId: string
  target: OutboundTarget
  content: OutboundContent
  maxOutboundChars: number
  /** Provider raw send — only this module may call it. */
  rawSend: RawImSend
}

export type GuardedSendResult =
  | { ok: true; messageId: string; outboundChars: number; text: string }
  | {
      ok: false
      reason: GuardRefuseReason
      /** Present when a credential hit still delivered the intercept notice. */
      messageId?: string
      outboundChars?: number
      /** Sanitized platform failure; never a full provider dump. */
      error?: string
    }

const TRUNCATION_NOTICE = '\n…（回答过长已截断,完整内容见 c3 会话）'

/**
 * Content-only screening for a model final answer. Kept for unit tests and as
 * the credential/truncation step inside {@link sendGuarded}; callers must not
 * treat this as a send path.
 */
export type OutboundVerdict = { ok: true; text: string } | { ok: false; reason: 'credential' }

export function screenOutbound(text: string, maxChars: number): OutboundVerdict {
  if (detectCredentialShape(text)) return { ok: false, reason: 'credential' }
  return { ok: true, text: truncateVisible(text, maxChars) }
}

function truncateVisible(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  if (maxChars <= TRUNCATION_NOTICE.length) return trimmed.slice(0, maxChars)
  return `${trimmed.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200)
  return String(err).slice(0, 200)
}

/**
 * Outbound target check. `requireMention` is an inbound accept rule only — it
 * must not widen or redefine where a reply may go.
 */
export function outboundTargetAllowed(
  robot: ImRobot,
  target: OutboundTarget,
): GuardRefuseReason | null {
  if (target.chatType === 'group') {
    if (robot.chatAllowlist.length > 0 && !robot.chatAllowlist.includes(target.chatId)) {
      return 'chat_not_allowed'
    }
    return null
  }
  if (robot.dmMode === 'disabled') return 'dm_not_allowed'
  if (robot.dmMode === 'allowlist' && !robot.dmAllowlist.includes(target.senderId)) {
    return 'dm_not_allowed'
  }
  return null
}

function readinessRefuse(robot: ImRobot | null | undefined): GuardRefuseReason | null {
  if (!robot || !robot.enabled) return 'disabled'
  if (robot.outboundAckAt == null) return 'outbound_not_acknowledged'
  return null
}

async function deliverRaw(input: GuardedSendInput, text: string): Promise<GuardedSendResult> {
  try {
    const { messageId } = await input.rawSend(input.target.chatId, {
      text,
      replyTo: input.target.replyTo,
    })
    return { ok: true, messageId, outboundChars: text.length, text }
  } catch (err) {
    return { ok: false, reason: 'send_failed', error: errText(err), outboundChars: 0 }
  }
}

/**
 * Decide and (when allowed) deliver. Returns what actually happened so the
 * caller can write one accurate audit row — never retry on audit failure here.
 */
export async function sendGuarded(input: GuardedSendInput): Promise<GuardedSendResult> {
  const robot = getRobot(input.robotId)
  const ready = readinessRefuse(robot)
  if (ready) return { ok: false, reason: ready, outboundChars: 0 }
  // robot is non-null when ready is null
  const live = robot!
  const targetRefuse = outboundTargetAllowed(live, input.target)
  if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }

  if (input.content.category === 'fixed_notice') {
    const text = truncateVisible(FIXED_NOTICES[input.content.notice], input.maxOutboundChars)
    return deliverRaw(input, text)
  }

  const screened = screenOutbound(input.content.text, input.maxOutboundChars)
  if (!screened.ok) {
    // Intercept notice: truncation + target rules only — no credential re-scan.
    const notice = truncateVisible(FIXED_NOTICES.guard_refused, input.maxOutboundChars)
    const delivered = await deliverRaw(input, notice)
    if (delivered.ok) {
      return {
        ok: false,
        reason: 'credential',
        messageId: delivered.messageId,
        outboundChars: delivered.outboundChars,
      }
    }
    return {
      ok: false,
      reason: delivered.reason === 'send_failed' ? 'send_failed' : 'credential',
      outboundChars: 0,
      ...(delivered.error ? { error: delivered.error } : {}),
    }
  }

  if (!screened.text) return { ok: false, reason: 'empty', outboundChars: 0 }
  return deliverRaw(input, screened.text)
}
