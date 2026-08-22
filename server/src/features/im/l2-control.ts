/**
 * L2 inbound todo token control path — terminates before binding or model.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ImRobot, RobotWritableCapability } from '@ccc/shared/protocol'
import { accountNamespaceOf, getActiveBindingForSender } from './identity-store.js'
import { resolveCallScope, chatContextFor } from './call-scope.js'
import { computeWriteConfigHash } from './write-config-hash.js'
import { isWriteGrantActive, appendWriteAudit } from './write-grant-store.js'
import {
  claimTokenForExecution,
  finalizeTokenResult,
  lookupTokenByPlaintext,
} from './todo-token-store.js'
import { parseTodoInbound } from './todo-token-parse.js'
import { beginTurn, claimGateMessage, finishTurn } from './robot-store.js'
import { threadKeyFor } from './thread-key.js'
import { getAnswerContract } from '../user-involve/answer-contract-store.js'
import { executeL2Action } from './l2-executor.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { markQueueDirty } from '../intents/workflow.js'
import type { ImInboundMessage } from './types.js'
import type { OutboundTarget, RobotMessageRef } from './outbound-guard.js'
import type { RobotRenderContext } from './robot-message-registry.js'

export interface L2ControlDeps {
  sendFixed: (
    message: RobotMessageRef,
    target: OutboundTarget,
    ctx: RobotRenderContext,
  ) => Promise<{ ok: boolean; outboundChars: number; messageId?: string | null; reason?: string }>
  renderCtx: (subject?: string | null) => RobotRenderContext
  accepts: (robot: ImRobot, msg: ImInboundMessage) => boolean
  broadcastIntents?: (workspacePath: string) => void
}

function redactSender(senderId: string): string {
  if (senderId.length <= 4) return '****'
  return `${senderId.slice(0, 2)}…${senderId.slice(-2)}`
}

function audit(
  robot: ImRobot,
  input: Omit<Parameters<typeof appendWriteAudit>[0], 'robotId'>,
): void {
  appendWriteAudit({ robotId: robot.id, ...input })
}

/**
 * Handle inbound messages starting with `c3todo_`. Returns true when fully handled.
 */
export async function handleTodoControl(
  robot: ImRobot,
  msg: ImInboundMessage,
  deps: L2ControlDeps,
): Promise<boolean> {
  const parsed = parseTodoInbound(msg.text)
  if (!parsed) return false

  const target: OutboundTarget = {
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    replyTo: msg.messageId,
  }
  const ctx = deps.renderCtx()

  if (parsed.kind === 'malformed') {
    await deps.sendFixed({ key: 'token.unusable', params: {} }, target, ctx)
    audit(robot, { result: 'format_invalid', senderIdRedacted: redactSender(msg.senderId) })
    return true
  }

  if (msg.chatType === 'group') {
    if (!deps.accepts(robot, msg)) return true
    await deps.sendFixed({ key: 'token.wrongChat', params: {} }, target, ctx)
    audit(robot, { result: 'format_invalid', senderIdRedacted: redactSender(msg.senderId) })
    return true
  }

  if (parsed.kind === 'token_only') {
    await deps.sendFixed({ key: 'todo.answerFormatHint', params: {} }, target, ctx)
    audit(robot, { result: 'format_invalid', senderIdRedacted: redactSender(msg.senderId) })
    return true
  }

  const gate = claimGateMessage({
    platform: robot.platform,
    robotId: robot.id,
    threadKey: threadKeyFor(msg),
    senderId: msg.senderId,
    messageId: msg.messageId,
  })
  if (gate !== 'claimed') return true

  const tid = beginTurn({
    robotId: robot.id,
    threadKey: threadKeyFor(msg),
    chatId: msg.chatId,
    senderId: msg.senderId,
    messageId: msg.messageId,
  })

  const tokenPlain = parsed.token!
  const answerId = parsed.answerId!
  const row = lookupTokenByPlaintext(tokenPlain)
  if (!row) {
    const s = await deps.sendFixed({ key: 'token.unusable', params: {} }, target, ctx)
    audit(robot, {
      result: 'unavailable',
      answerId,
      senderIdRedacted: redactSender(msg.senderId),
    })
    finishTurn(tid, {
      outcome: 'complete',
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
    })
    return true
  }

  const ns = accountNamespaceOf(robot.platform, robot.appId)
  const binding = getActiveBindingForSender(ns, msg.senderId)
  if (!binding || binding.id !== row.binding_id || binding.subject !== row.actor_subject) {
    const s = await deps.sendFixed({ key: 'token.unusable', params: {} }, target, ctx)
    audit(robot, {
      todoId: row.todo_id,
      result: 'actor_denied',
      answerId,
      senderIdRedacted: redactSender(msg.senderId),
    })
    finishTurn(tid, {
      outcome: 'complete',
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return true
  }

  if (row.robot_id !== robot.id || row.actor_sender_id !== msg.senderId) {
    const s = await deps.sendFixed({ key: 'token.unusable', params: {} }, target, ctx)
    audit(robot, { todoId: row.todo_id, result: 'unavailable', answerId })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const capability = row.capability as RobotWritableCapability
  if (!isWriteGrantActive(robot, capability)) {
    const s = await deps.sendFixed(
      { key: 'todo.grantMissing', params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: 'grant_missing',
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const liveHash = computeWriteConfigHash(robot)
  if (liveHash !== row.config_hash) {
    const s = await deps.sendFixed(
      { key: 'token.unusable', params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      capability,
      answerId,
      result: 'stale',
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const chat = chatContextFor(robot.platform, robot.appId, msg.chatType, msg.chatId)
  const scope = resolveCallScope({
    robotId: robot.id,
    senderId: msg.senderId,
    chat,
    expectedBindingId: binding.id,
  })
  if (!scope.ok || !scope.scope.detailWorkspaces.some((w) => w.name === row.workspace_name)) {
    const s = await deps.sendFixed(
      { key: 'token.unusable', params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: 'scope_denied',
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const idempotencyKey = createHash('sha256').update(`${row.id}\0${answerId}`, 'utf8').digest('hex')
  const claim = claimTokenForExecution({
    tokenId: row.id,
    answerId,
    idempotencyKey,
  })

  if (!claim.ok) {
    const key =
      claim.result === 'expired'
        ? 'token.expired'
        : claim.result === 'cancelled'
          ? 'token.cancelled'
          : claim.result === 'consumed'
            ? 'token.consumed'
            : 'token.unusable'
    const s = await deps.sendFixed({ key, params: {} }, target, deps.renderCtx(binding.subject))
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: claim.result,
      idempotencyKey,
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  if (claim.result === 'already_applied') {
    const s = await deps.sendFixed(
      { key: 'todo.alreadyApplied', params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: 'already_applied',
      idempotencyKey,
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  // Domain execution
  const contract = getAnswerContract(row.todo_id)
  if (!contract) {
    finalizeTokenResult(row.id, 'refused', { reason: 'no_contract' })
    const s = await deps.sendFixed(
      { key: 'token.unusable', params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: 'domain_refused',
      idempotencyKey,
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const wsPath = resolveWorkspaceRoot(row.workspace_name)
  const exec = executeL2Action({
    robot,
    contract,
    answerId,
    actorSubject: binding.subject,
    idempotencyKey,
    broadcastIntents: deps.broadcastIntents,
    requestQueuePass: wsPath ? () => void markQueueDirty(wsPath) : undefined,
  })

  if (exec.ok) {
    finalizeTokenResult(row.id, 'succeeded', { outcome: exec.outcome })
    const msgKey =
      exec.outcome === 'already_applied' ? 'todo.alreadyApplied' : ('todo.applied' as const)
    const s = await deps.sendFixed(
      { key: msgKey, params: {} },
      target,
      deps.renderCtx(binding.subject),
    )
    audit(robot, {
      todoId: row.todo_id,
      bindingSubject: binding.subject,
      actorSubject: binding.subject,
      objectWorkspace: row.workspace_name,
      capability,
      answerId,
      result: exec.outcome,
      idempotencyKey,
    })
    finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
    return true
  }

  const msgKey =
    exec.outcome === 'stale'
      ? 'token.unusable'
      : exec.outcome === 'domain_refused'
        ? 'visibility.webRequired'
        : 'token.unusable'
  finalizeTokenResult(row.id, 'refused', { outcome: exec.outcome, reason: exec.reason })
  const s = await deps.sendFixed(
    {
      key: msgKey,
      params: msgKey === 'visibility.webRequired' ? { nav: { kind: 'webEntry' } } : {},
    },
    target,
    deps.renderCtx(binding.subject),
  )
  audit(robot, {
    todoId: row.todo_id,
    bindingSubject: binding.subject,
    actorSubject: binding.subject,
    objectWorkspace: row.workspace_name,
    capability,
    answerId,
    result: exec.outcome,
    idempotencyKey,
  })
  finishTurn(tid, { outcome: 'complete', outboundChars: s.ok ? s.outboundChars : 0 })
  return true
}

export function stableActionIdempotencyKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

export function mintActionIdempotencyKey(): string {
  return randomUUID()
}
