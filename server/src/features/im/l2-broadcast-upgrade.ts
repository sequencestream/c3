/**
 * L2 broadcast upgrade — replaces L0 p2p templates with answerable todo prompts
 * when grant, binding, scope, and DM policy all allow.
 */
import type { ImBroadcastCandidate, ImRobot } from '@ccc/shared/protocol'
import { getAnswerContract } from '../user-involve/answer-contract-store.js'
import { getEvent, getEventByRequestId } from '../user-involve/store.js'
import { accountNamespaceOf, listActiveBindings } from './identity-store.js'
import { computeWriteConfigHash } from './write-config-hash.js'
import { isWriteGrantActive } from './write-grant-store.js'
import { issueTodoToken } from './todo-token-store.js'
import { resolveCallScope, chatContextFor } from './call-scope.js'
import {
  sendGuarded,
  type GuardedSendResult,
  type OutboundTarget,
  type RawImSend,
} from './outbound-guard.js'
import { resolveRobotRenderContext } from './robot-message-registry.js'
import type { BroadcastDeliveryTarget } from './broadcast-recipients.js'

function dmAllowed(robot: ImRobot, senderId: string): boolean {
  if (robot.dmMode === 'open') return true
  if (robot.dmMode === 'allowlist') return robot.dmAllowlist.includes(senderId)
  return false
}

/** Resolve the WorkCenter todo row id for broadcast kinds that may upgrade to L2. */
export function todoIdForL2Broadcast(candidate: ImBroadcastCandidate): string | null {
  switch (candidate.kind) {
    case 'permission_queued': {
      const row = getEventByRequestId(candidate.requestId)
      return row?.status === 'todo' ? row.id : null
    }
    case 'intent_spec_awaiting_approval': {
      const row = getEventByRequestId(`spec:${candidate.intentId}:${candidate.specFingerprint}`)
      return row?.status === 'todo' ? row.id : null
    }
    default:
      return null
  }
}

export function broadcastKindSupportsL2Upgrade(kind: ImBroadcastCandidate['kind']): boolean {
  return kind === 'permission_queued' || kind === 'intent_spec_awaiting_approval'
}

/**
 * Attempt L2 delivery for one p2p broadcast target. Returns null when L2 does not
 * apply (fall through to L0). Returns a result when L2 was attempted.
 */
export async function tryDeliverL2TodoPrompt(input: {
  robot: ImRobot
  target: Extract<BroadcastDeliveryTarget, { kind: 'p2p_dm' }>
  todoId: string
  maxOutboundChars: number
  rawSend: RawImSend
}): Promise<GuardedSendResult | null> {
  const contract = getAnswerContract(input.todoId)
  if (!contract) return null
  const event = getEvent(input.todoId)
  if (!event || event.status !== 'todo') return null
  if (!isWriteGrantActive(input.robot, contract.capability)) return null

  const ns = accountNamespaceOf(input.robot.platform, input.robot.appId)
  const binding = listActiveBindings(ns).find(
    (b) => b.subject === contract.actorSubject && b.senderId === input.target.senderId,
  )
  if (!binding || !dmAllowed(input.robot, binding.senderId)) return null

  const chat = chatContextFor(input.robot.platform, input.robot.appId, 'p2p', binding.senderId)
  const scope = resolveCallScope({
    robotId: input.robot.id,
    senderId: binding.senderId,
    chat,
    expectedBindingId: binding.id,
  })
  if (!scope.ok || !scope.scope.detailWorkspaces.some((w) => w.name === contract.workspaceName)) {
    return null
  }

  const hash = computeWriteConfigHash(input.robot)
  const issued = issueTodoToken({
    robotId: input.robot.id,
    todoId: input.todoId,
    bindingId: binding.id,
    actorSenderId: binding.senderId,
    actorSubject: contract.actorSubject,
    workspaceName: contract.workspaceName,
    capability: contract.capability,
    todoFingerprint: contract.todoFingerprint,
    configHash: hash,
  })
  if (!issued) return { ok: false, reason: 'empty', outboundChars: 0, templateKey: 'todo.l2Prompt' }

  const target: OutboundTarget = {
    chatId: binding.senderId,
    chatType: 'p2p',
    senderId: binding.senderId,
    replyTo: '',
  }
  return sendGuarded({
    robotId: input.robot.id,
    target,
    content: {
      category: 'fixed_notice',
      message: {
        key: 'todo.l2Prompt',
        params: {
          token: issued.plaintext,
          answerList: contract.answers.map((a) => a.answerId).join(', '),
        },
      },
    },
    renderContext: resolveRobotRenderContext({
      subject: binding.subject,
      robotLocale: input.robot.locale,
    }),
    maxOutboundChars: input.maxOutboundChars,
    rawSend: input.rawSend,
  })
}
