import type { ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import {
  accountNamespaceOf,
  consumeChallenge,
  getActiveBindingForSender,
  isIdentityStoreAvailable,
} from './identity-store.js'
import { chatContextFor, resolveCallScope } from './call-scope.js'
import { accepts, rejectGroupNotAccepted } from './admission-policy.js'
import { handleTodoControl } from './l2-control.js'
import { parseTodoInbound } from './todo-token-parse.js'
import { logImBindingControl, logImInboundIgnored } from './im-log.js'
import {
  beginTurn,
  claimGateMessage,
  finishTurn,
  isStoreAvailable,
  RobotStoreError,
} from './robot-store.js'
import { conversationIdentityOf, threadKeyFor } from './thread-key.js'
import type { ImInboundMessage } from './types.js'
import type { RobotMessageRef } from './outbound-guard.js'
import {
  fixed,
  bindingNotice,
  identityRequiredRef,
  renderCtx,
  targetOf,
  TOKEN_SHAPE,
  type RobotHandle,
} from './supervisor-internal.js'

export type AuditedBindingNotice = (
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  message: RobotMessageRef,
  outcome: ImTurnOutcome,
) => Promise<void>

export { accepts, rejectGroupNotAccepted } from './admission-policy.js'

export type InboundAdmissionSyncResult =
  { kind: 'reject' } | { kind: 'proceed'; robot: ImRobot; handle: RobotHandle }

export type InboundAdmissionAsyncResult =
  | { kind: 'done' }
  | {
      kind: 'start_turn'
      binding: NonNullable<ReturnType<typeof getActiveBindingForSender>>
      scope: Extract<ReturnType<typeof resolveCallScope>, { ok: true }>['scope']
      threadKey: string
      identity: ReturnType<typeof conversationIdentityOf>
    }

export interface InboundAdmissionDeps {
  broadcastIntents?: (workspacePath: string) => void
  auditedBindingNotice?: AuditedBindingNotice
  handleBindingControl?: (r: ImRobot, h: RobotHandle, m: ImInboundMessage) => Promise<boolean>
}

export function evaluateInboundSyncAdmission(
  handle: RobotHandle | undefined,
  robot: ImRobot | null,
  message: ImInboundMessage,
): InboundAdmissionSyncResult {
  if (!handle || !robot || !robot.enabled || !message.senderId.trim()) {
    if (robot)
      logImInboundIgnored(
        robot,
        !handle ? 'not_connected' : !robot.enabled ? 'disabled' : 'blank_sender',
      )
    return { kind: 'reject' }
  }
  return { kind: 'proceed', robot, handle }
}

export async function processInboundAdmission(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  deps: InboundAdmissionDeps = {},
): Promise<InboundAdmissionAsyncResult> {
  const target = targetOf(m)
  const ctx = renderCtx(r)
  const auditedBindingNotice = deps.auditedBindingNotice ?? defaultAuditedBindingNotice
  const handleBindingControl = deps.handleBindingControl ?? defaultHandleBindingControl

  if (!isStoreAvailable() || !isIdentityStoreAvailable()) {
    logImInboundIgnored(r, 'store_unavailable')
    void fixed(h, { key: 'runtime.storeUnavailable', params: {} }, target, ctx)
    return { kind: 'done' }
  }

  const tokenText = m.text.trim()

  if (parseTodoInbound(tokenText)) {
    if (rejectGroupNotAccepted(r, m)) {
      logImInboundIgnored(r, 'not_accepted', `chat=${m.chatType} mentioned=${m.mentionedBot}`)
      return { kind: 'done' }
    }
    if (
      await handleTodoControl(r, m, {
        sendFixed: async (message, t, c) => {
          const s = await fixed(h, message, t, c)
          return {
            ok: s.ok,
            outboundChars: s.ok ? s.outboundChars : 0,
            messageId: s.ok ? s.messageId : null,
            reason: s.ok ? undefined : s.reason,
          }
        },
        renderCtx: (subject) => renderCtx(r, subject),
        accepts,
        broadcastIntents: deps.broadcastIntents,
      })
    ) {
      return { kind: 'done' }
    }
  }

  if (TOKEN_SHAPE.test(tokenText)) {
    if (rejectGroupNotAccepted(r, m)) {
      logImInboundIgnored(r, 'not_accepted', `chat=${m.chatType} mentioned=${m.mentionedBot}`)
      return { kind: 'done' }
    }
    if (await handleBindingControl(r, h, m)) return { kind: 'done' }
  }

  const ns = accountNamespaceOf(r.platform, r.appId)
  const binding = getActiveBindingForSender(ns, m.senderId)
  if (!binding) {
    if (rejectGroupNotAccepted(r, m)) {
      logImInboundIgnored(r, 'not_accepted', `chat=${m.chatType} mentioned=${m.mentionedBot}`)
      return { kind: 'done' }
    }
    const gate = await claimControlMessage(r, h, m)
    if (gate !== 'claimed') {
      logImInboundIgnored(r, gate)
      return { kind: 'done' }
    }
    await auditedBindingNotice(r, h, m, identityRequiredRef(m.chatType), 'identity_required')
    return { kind: 'done' }
  }

  if (!accepts(r, m)) {
    logImInboundIgnored(r, 'not_accepted', `chat=${m.chatType} mentioned=${m.mentionedBot}`)
    return { kind: 'done' }
  }

  const chat = chatContextFor(r.platform, r.appId, m.chatType, m.chatId)
  const scope = resolveCallScope({
    robotId: r.id,
    senderId: m.senderId,
    chat,
    expectedBindingId: binding.id,
  })
  if (!scope.ok) {
    const tid = beginTurn({
      robotId: r.id,
      threadKey: threadKeyFor(m),
      chatId: m.chatId,
      senderId: m.senderId,
      messageId: m.messageId,
    })
    const s = await bindingNotice(
      h,
      identityRequiredRef(m.chatType),
      target,
      renderCtx(r, binding.subject),
    )
    finishTurn(tid, {
      outcome: 'identity_required',
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
      error: s.ok ? null : s.reason,
    })
    return { kind: 'done' }
  }

  const threadKey = threadKeyFor(m)
  const identity = conversationIdentityOf(
    r.platform,
    r.id,
    threadKey,
    m.senderId,
    binding.id,
    binding.subject,
    scope.scope.scopeHash,
  )

  return {
    kind: 'start_turn',
    binding,
    scope: scope.scope,
    threadKey,
    identity,
  }
}

async function claimControlMessage(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
): Promise<'duplicate' | 'claimed' | 'error'> {
  const ctx = renderCtx(r)
  try {
    return claimGateMessage({
      platform: r.platform,
      robotId: r.id,
      threadKey: threadKeyFor(m),
      senderId: m.senderId,
      messageId: m.messageId,
    })
  } catch (e) {
    void fixed(
      h,
      e instanceof RobotStoreError && e.code === 'db_unavailable'
        ? { key: 'runtime.storeUnavailable', params: {} }
        : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      targetOf(m),
      ctx,
    )
    return 'error'
  }
}

async function defaultAuditedBindingNotice(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  message: RobotMessageRef,
  outcome: ImTurnOutcome,
): Promise<void> {
  const tid = beginTurn({
    robotId: r.id,
    threadKey: threadKeyFor(m),
    chatId: m.chatId,
    senderId: m.senderId,
    messageId: m.messageId,
  })
  const s = await bindingNotice(h, message, targetOf(m), renderCtx(r))
  finishTurn(tid, {
    outcome,
    outboundChars: s.ok ? s.outboundChars : 0,
    outMessageId: s.ok ? s.messageId : null,
    error: s.ok ? null : s.reason,
  })
}

export async function defaultHandleBindingControl(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
): Promise<boolean> {
  const text = m.text.trim()
  if (!TOKEN_SHAPE.test(text)) return false

  const gate = await claimControlMessage(r, h, m)
  if (gate !== 'claimed') return true

  if (m.chatType === 'group') {
    logImBindingControl({ robot: r, chatType: 'group', path: 'use_dm' })
    await defaultAuditedBindingNotice(
      r,
      h,
      m,
      { key: 'binding.useDm', params: {} },
      'identity_required',
    )
    return true
  }

  const ns = accountNamespaceOf(r.platform, r.appId)
  const result = consumeChallenge({
    robotId: r.id,
    accountNamespace: ns,
    senderId: m.senderId,
    token: text,
  })
  logImBindingControl({
    robot: r,
    chatType: 'p2p',
    path: 'consume',
    result: result.ok ? 'ok' : result.reason === 'rate_limited' ? 'rate_limited' : 'failed',
  })
  await defaultAuditedBindingNotice(
    r,
    h,
    m,
    result.ok
      ? { key: 'binding.success', params: {} }
      : { key: 'binding.tokenUnusable', params: {} },
    result.ok ? 'complete' : 'identity_required',
  )
  return true
}
