/**
 * The sole controlled outbound entry for IM — replies and L0 broadcasts.
 *
 * Every final answer, fixed notice, and registered broadcast template leaves
 * only through {@link sendGuarded} or {@link sendGuardedBroadcast}. The
 * supervisor never holds a raw sender: provider `ImConnection.send` stays
 * inside the provider, and this module is the only caller that may invoke
 * a bound `rawSend`.
 *
 * Decision order (re-read live robot state each time):
 *   1. robot enabled, outbound acknowledged, config hash still matches ack
 *   2. target allowed (inbound reply chat, or solver-produced broadcast target)
 *   3. content is a registered closed category
 *   4. credential shape + truncation
 *   5. rawSend; callers write unified audit from the result
 */
import type { ImBroadcastType } from '@ccc/shared/protocol'
import type { ImRobot } from '@ccc/shared/protocol'
import { detectCredentialShape, redactSecrets } from '../../kernel/security/index.js'
import { renderBroadcastTemplate, type TemplateFieldValues } from './broadcast-templates.js'
import type { BroadcastDeliveryTarget } from './broadcast-recipients.js'
import { logImOutbound } from './im-log.js'
import { outboundConfigAcknowledged } from './outbound-config-hash.js'
import { getRobot } from './robot-store.js'
import {
  assertSendableCategory,
  isBindingGroupAllowedKey,
  renderRobotMessage,
  type RobotMessageRef,
  type RobotRenderContext,
} from './robot-message-registry.js'
import type { ImOutbound } from './types.js'

export type { RobotMessageRef, RobotRenderContext } from './robot-message-registry.js'

export type OutboundContent =
  | { category: 'final_answer'; text: string }
  | { category: 'fixed_notice'; message: RobotMessageRef }
  | {
      category: 'binding_notice'
      message: RobotMessageRef
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
  | 'outbound_config_stale'
  | 'chat_not_allowed'
  | 'dm_not_allowed'
  | 'binding_target_mismatch'
  | 'binding_not_p2p'
  | 'invalid_notice'
  | 'invalid_template'
  | 'credential'
  | 'empty'
  | 'send_failed'

export type GuardedSendInput = {
  robotId: string
  target: OutboundTarget
  content: OutboundContent
  maxOutboundChars: number
  renderContext: RobotRenderContext
  /** Provider raw send — only this module may call it. */
  rawSend: RawImSend
}

export type GuardedSendResult =
  | { ok: true; messageId: string; outboundChars: number; text: string; templateKey?: string }
  | {
      ok: false
      reason: GuardRefuseReason
      /** Present when a credential hit still delivered the intercept notice. */
      messageId?: string
      outboundChars?: number
      templateKey?: string
      /** Sanitized platform failure; never a full provider dump. */
      error?: string
    }

export type GuardedBroadcastInput = {
  robotId: string
  target: BroadcastDeliveryTarget
  kind: ImBroadcastType
  fields: TemplateFieldValues
  idempotencyKey: string
  objectWorkspace: string
  maxOutboundChars: number
  rawSend: RawImSend
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

function renderFixed(
  message: RobotMessageRef,
  category: 'fixed_notice' | 'binding_notice',
  ctx: RobotRenderContext,
  maxChars: number,
): string | null {
  if (!assertSendableCategory(message, category)) return null
  const text = renderRobotMessage(message, ctx).trim()
  if (!text) return null
  return truncateVisible(text, maxChars)
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
  if (!outboundConfigAcknowledged(robot)) return 'outbound_config_stale'
  return null
}

function proactiveTargetAllowed(
  robot: ImRobot,
  target: BroadcastDeliveryTarget,
): GuardRefuseReason | null {
  if (target.kind === 'group') {
    if (robot.chatAllowlist.length > 0 && !robot.chatAllowlist.includes(target.chatId)) {
      return 'chat_not_allowed'
    }
    if (!robot.broadcastGroupChatIds.includes(target.chatId)) return 'chat_not_allowed'
    return null
  }
  if (!robot.broadcastToBoundUsers) return 'dm_not_allowed'
  if (robot.dmMode === 'disabled') return 'dm_not_allowed'
  if (robot.dmMode === 'allowlist' && !robot.dmAllowlist.includes(target.senderId)) {
    return 'dm_not_allowed'
  }
  return null
}

async function deliverRawReply(input: GuardedSendInput, text: string): Promise<GuardedSendResult> {
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

async function deliverRawProactive(
  input: GuardedBroadcastInput,
  text: string,
  templateKey: string,
): Promise<GuardedSendResult> {
  try {
    const { messageId } = await input.rawSend(input.target.chatId, { text })
    return { ok: true, messageId, outboundChars: text.length, text, templateKey }
  } catch (err) {
    return {
      ok: false,
      reason: 'send_failed',
      error: errText(err),
      outboundChars: 0,
      templateKey,
    }
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
  const result = await sendGuardedInner(input)
  const robot = getRobot(input.robotId)
  const noticeKey =
    input.content.category === 'binding_notice' || input.content.category === 'fixed_notice'
      ? input.content.message.key
      : undefined
  logImOutbound({
    robot: robot ?? { id: input.robotId, name: input.robotId, platform: 'feishu' },
    category: input.content.category,
    chatType: input.target.chatType,
    noticeKey,
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    outboundChars: result.ok ? result.outboundChars : result.outboundChars,
    outMessageId: result.ok ? result.messageId : result.messageId,
  })
  return result
}

async function sendGuardedInner(input: GuardedSendInput): Promise<GuardedSendResult> {
  const robot = getRobot(input.robotId)
  const ready = readinessRefuse(robot)
  if (ready) return { ok: false, reason: ready, outboundChars: 0 }
  const live = robot!

  if (input.content.category === 'binding_notice') {
    const allowsGroup = isBindingGroupAllowedKey(input.content.message.key)
    if (!allowsGroup && input.target.chatType !== 'p2p') {
      return { ok: false, reason: 'binding_not_p2p', outboundChars: 0 }
    }
    if (!sameOrigin(input.target, input.content.origin)) {
      return { ok: false, reason: 'binding_target_mismatch', outboundChars: 0 }
    }
    const skipDm = input.target.chatType === 'p2p'
    const targetRefuse = outboundTargetAllowed(live, input.target, { skipDmAllowlist: skipDm })
    if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }
    const body = renderFixed(
      input.content.message,
      'binding_notice',
      input.renderContext,
      input.maxOutboundChars,
    )
    if (!body) return { ok: false, reason: 'invalid_notice', outboundChars: 0 }
    return deliverRawReply(input, body)
  }

  const targetRefuse = outboundTargetAllowed(live, input.target)
  if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }

  if (input.content.category === 'fixed_notice') {
    const text = renderFixed(
      input.content.message,
      'fixed_notice',
      input.renderContext,
      input.maxOutboundChars,
    )
    if (!text) return { ok: false, reason: 'invalid_notice', outboundChars: 0 }
    return deliverRawReply(input, text)
  }

  const screened = screenOutbound(input.content.text, input.maxOutboundChars)
  if (!screened.ok) {
    const notice = renderFixed(
      { key: 'runtime.guardRefused', params: { nav: { kind: 'webEntry' } } },
      'fixed_notice',
      input.renderContext,
      input.maxOutboundChars,
    )
    if (!notice) return { ok: false, reason: 'invalid_notice', outboundChars: 0 }
    const delivered = await deliverRawReply(input, notice)
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
  return deliverRawReply(input, screened.text)
}

/**
 * Proactive L0 broadcast through the same guard pipeline as inbound replies.
 */
export async function sendGuardedBroadcast(
  input: GuardedBroadcastInput,
): Promise<GuardedSendResult> {
  const result = await sendGuardedBroadcastInner(input)
  const robot = getRobot(input.robotId)
  logImOutbound({
    robot: robot ?? { id: input.robotId, name: input.robotId, platform: 'feishu' },
    category: 'broadcast_template',
    chatType: input.target.kind === 'group' ? 'group' : 'dm',
    templateKey: result.ok ? result.templateKey : result.templateKey,
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    outboundChars: result.ok ? result.outboundChars : result.outboundChars,
    outMessageId: result.ok ? result.messageId : result.messageId,
  })
  return result
}

async function sendGuardedBroadcastInner(input: GuardedBroadcastInput): Promise<GuardedSendResult> {
  const robot = getRobot(input.robotId)
  const ready = readinessRefuse(robot)
  if (ready) return { ok: false, reason: ready, outboundChars: 0 }
  const live = robot!

  if (!live.broadcastEventTypes.includes(input.kind)) {
    return { ok: false, reason: 'invalid_template', outboundChars: 0 }
  }

  const targetRefuse = proactiveTargetAllowed(live, input.target)
  if (targetRefuse) return { ok: false, reason: targetRefuse, outboundChars: 0 }

  const rendered = renderBroadcastTemplate({
    kind: input.kind,
    fields: input.fields,
    groupDowngrade: input.target.kind === 'group' && !input.target.fullTemplate,
  })
  if (!rendered.ok) {
    return { ok: false, reason: 'invalid_template', outboundChars: 0 }
  }

  const text = truncateVisible(rendered.text, input.maxOutboundChars)
  if (detectCredentialShape(text)) {
    return { ok: false, reason: 'credential', outboundChars: 0, templateKey: rendered.templateKey }
  }
  if (!text) return { ok: false, reason: 'empty', outboundChars: 0 }

  return deliverRawProactive(input, text, rendered.templateKey)
}
