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
 *      (`binding_notice` in p2p may skip dmMode/dmAllowlist only)
 *   3. content is a final answer, registered fixed notice, or binding_notice
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
import { redactSecrets } from '../pr-events/tool-defs.js'
import { getRobot } from './robot-store.js'
import type { ImOutbound } from './types.js'

/** Ordinary fixed control prompts — not binding/identity notices. */
export const GENERAL_FIXED_NOTICES = {
  timeout: '这个问题处理超时了,已经中止。',
  blocked: '这一步需要人工授权,我在群里无法完成。请到 c3 中继续。',
  error: '处理时出错了,请到 c3 会话中查看详情。',
  guard_refused: '回答里包含疑似凭据的内容,已拦下未发送。请到 c3 会话中查看。',
  busy: '上一个问题还在处理,稍后再问我。',
  store_unavailable: '机器人存储不可用,本回合未启动。',
  input_rejected_credential: '疑似凭据,未处理也未保存。',
  input_rejected_too_long: '消息过长,未处理也未保存。',
} as const

/** Binding-control notices — only via `binding_notice`, never `fixed_notice`. */
export const BINDING_FIXED_NOTICES = {
  identity_required:
    '请先在 c3 Web 的个人设置里发起 IM 身份绑定,再把一次性验证码发到与本机器人的私聊。',
  bind_use_dm: '请在与本机器人的私聊中完成身份绑定,群内无法验证。',
  bind_failed: '绑定未成功。请到 c3 Web 重新发起挑战,并在私聊中提交完整验证码。',
  bind_success: '身份绑定已生效。之后即可向我询问你有权查看的 c3 台账内容。',
  scope_changed: '权限已变化,请重试。',
} as const

/** All registered notice bodies (lookup only — category picks the send path). */
export const FIXED_NOTICES = { ...GENERAL_FIXED_NOTICES, ...BINDING_FIXED_NOTICES } as const

export type GeneralFixedNoticeId = keyof typeof GENERAL_FIXED_NOTICES
export type BindingNoticeId = keyof typeof BINDING_FIXED_NOTICES
/** Notices allowed on the ordinary `fixed_notice` path. */
export type FixedNoticeId = GeneralFixedNoticeId

/** Binding-control notices that may use the narrow dmMode exemption in p2p. */
export const BINDING_NOTICE_IDS = Object.keys(BINDING_FIXED_NOTICES) as BindingNoticeId[]

export function isBindingNoticeId(id: string): id is BindingNoticeId {
  return Object.prototype.hasOwnProperty.call(BINDING_FIXED_NOTICES, id)
}

export function isGeneralFixedNoticeId(id: string): id is GeneralFixedNoticeId {
  return Object.prototype.hasOwnProperty.call(GENERAL_FIXED_NOTICES, id)
}

export type OutboundContent =
  | { category: 'final_answer'; text: string }
  | { category: 'fixed_notice'; notice: GeneralFixedNoticeId }
  | {
      category: 'binding_notice'
      notice: BindingNoticeId
      /**
       * Must equal the inbound that triggered the control path. Callers cannot
       * retarget chat/sender/replyTo.
       */
      origin: OutboundTarget
    }

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
  | 'binding_target_mismatch'
  | 'binding_not_p2p'
  | 'invalid_notice'
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

/** Platform failure text for audit: redact secrets first, then truncate. */
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw).slice(0, 200)
}

/**
 * Outbound target check. `requireMention` is an inbound accept rule only — it
 * must not widen or redefine where a reply may go.
 */
export function outboundTargetAllowed(
  robot: ImRobot,
  target: OutboundTarget,
  opts?: { skipDmAllowlist?: boolean },
): GuardRefuseReason | null {
  if (target.chatType === 'group') {
    if (robot.chatAllowlist.length > 0 && !robot.chatAllowlist.includes(target.chatId)) {
      return 'chat_not_allowed'
    }
    return null
  }
  if (opts?.skipDmAllowlist) return null
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

function sameOrigin(a: OutboundTarget, b: OutboundTarget): boolean {
  return (
    a.chatId === b.chatId &&
    a.chatType === b.chatType &&
    a.senderId === b.senderId &&
    a.replyTo === b.replyTo
  )
}

/**
 * Decide and (when allowed) deliver. Returns what actually happened so the
 * caller can write one accurate audit row — never retry on audit failure here.
 */
export async function sendGuarded(input: GuardedSendInput): Promise<GuardedSendResult> {
  const robot = getRobot(input.robotId)
  const ready = readinessRefuse(robot)
  if (ready) return { ok: false, reason: ready, outboundChars: 0 }
  const live = robot!

  if (input.content.category === 'binding_notice') {
    const allowsGroup =
      input.content.notice === 'bind_use_dm' || input.content.notice === 'identity_required'
    if (!allowsGroup && input.target.chatType !== 'p2p') {
      return { ok: false, reason: 'binding_not_p2p', outboundChars: 0 }
    }
    if (!sameOrigin(input.target, input.content.origin)) {
      return { ok: false, reason: 'binding_target_mismatch', outboundChars: 0 }
    }
    // Narrow exemption: skip dmMode/dmAllowlist for p2p binding notices only.
    const skipDm = input.target.chatType === 'p2p'
    const targetRefuse = outboundTargetAllowed(live, input.target, { skipDmAllowlist: skipDm })
    if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }
    const body = truncateVisible(FIXED_NOTICES[input.content.notice], input.maxOutboundChars)
    return deliverRaw(input, body)
  }

  const targetRefuse = outboundTargetAllowed(live, input.target)
  if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }

  if (input.content.category === 'fixed_notice') {
    const notice = input.content.notice
    if (!isGeneralFixedNoticeId(notice)) {
      return { ok: false, reason: 'invalid_notice', outboundChars: 0 }
    }
    const text = truncateVisible(GENERAL_FIXED_NOTICES[notice], input.maxOutboundChars)
    return deliverRaw(input, text)
  }

  const screened = screenOutbound(input.content.text, input.maxOutboundChars)
  if (!screened.ok) {
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
