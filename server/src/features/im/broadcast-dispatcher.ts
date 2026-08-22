/**
 * L0 broadcast dispatcher — subscribes to `im:broadcast_candidate` and delivers
 * through the same outbound guard as inbound replies.
 */
import type { ImBroadcastCandidate } from '@ccc/shared/protocol'
import type { EventBus } from '../../kernel/events/event-bus.js'
import { dedupeBroadcastTargets, resolveBroadcastRecipients } from './broadcast-recipients.js'
import { resolveBroadcastFacts } from './broadcast-facts.js'
import {
  appendOutboundAudit,
  claimBroadcastDelivery,
  finalizeBroadcastClaim,
  isOutboundAuditAvailable,
  releaseBroadcastClaim,
} from './outbound-audit-store.js'
import { sendGuardedBroadcast, type GuardRefuseReason } from './outbound-guard.js'
import { listEnabledRobots } from './robot-store.js'
import { getRobotHandle } from './supervisor-access.js'

export function subscribeImBroadcastDispatcher(eventBus: EventBus): () => void {
  return eventBus.subscribe('im:broadcast_candidate', (candidate) => {
    void dispatchBroadcastCandidate(candidate)
  })
}

async function dispatchBroadcastCandidate(candidate: ImBroadcastCandidate): Promise<void> {
  if (!isOutboundAuditAvailable()) return

  const facts = resolveBroadcastFacts(candidate)
  if (!facts) return

  for (const robot of listEnabledRobots()) {
    const targets = dedupeBroadcastTargets(
      resolveBroadcastRecipients(robot, facts.kind, facts.workspaceName),
    )
    if (targets.length === 0) {
      appendOutboundAudit({
        robotId: robot.id,
        category: 'broadcast',
        sourceEventKind: facts.kind,
        idempotencyKey: facts.idempotencyKey,
        targetKind: 'group',
        targetRef: '*',
        objectWorkspace: facts.workspaceName,
        templateKey: null,
        result: 'zero_targets',
        refuseReason: 'no_recipients',
        outboundChars: 0,
      })
      continue
    }

    const handle = getRobotHandle(robot.id)
    if (!handle) continue

    for (const target of targets) {
      const targetKind = target.kind
      const targetRef = target.kind === 'p2p_dm' ? target.senderId : target.chatId

      const claim = claimBroadcastDelivery({
        robotId: robot.id,
        idempotencyKey: facts.idempotencyKey,
        targetKind: targetKind,
        targetRef,
      })
      if (!claim.ok) continue
      if (claim.alreadySent) {
        appendOutboundAudit({
          robotId: robot.id,
          category: 'broadcast',
          sourceEventKind: facts.kind,
          idempotencyKey: facts.idempotencyKey,
          targetKind,
          targetRef,
          objectWorkspace: facts.workspaceName,
          templateKey: null,
          result: 'sent',
          outboundChars: 0,
          platformMessageId: claim.messageId,
        })
        continue
      }

      const result = await sendGuardedBroadcast({
        robotId: robot.id,
        target,
        kind: facts.kind,
        fields: facts.fields,
        idempotencyKey: facts.idempotencyKey,
        objectWorkspace: facts.workspaceName,
        maxOutboundChars: handle.maxOutboundChars,
        rawSend: handle.rawSend,
      })

      if (result.ok) {
        finalizeBroadcastClaim({
          robotId: robot.id,
          idempotencyKey: facts.idempotencyKey,
          targetKind,
          targetRef,
          platformMessageId: result.messageId,
        })
        appendOutboundAudit({
          robotId: robot.id,
          category: 'broadcast',
          sourceEventKind: facts.kind,
          idempotencyKey: facts.idempotencyKey,
          targetKind,
          targetRef,
          objectWorkspace: facts.workspaceName,
          templateKey: result.templateKey ?? null,
          result: 'sent',
          outboundChars: result.outboundChars,
          platformMessageId: result.messageId,
        })
      } else {
        const reason = result.reason
        if (reason === 'send_failed') {
          finalizeBroadcastClaim({
            robotId: robot.id,
            idempotencyKey: facts.idempotencyKey,
            targetKind,
            targetRef,
            platformMessageId: null,
          })
          appendOutboundAudit({
            robotId: robot.id,
            category: 'broadcast',
            sourceEventKind: facts.kind,
            idempotencyKey: facts.idempotencyKey,
            targetKind,
            targetRef,
            objectWorkspace: facts.workspaceName,
            templateKey: result.templateKey ?? null,
            result: 'platform_failed',
            refuseReason: result.error ?? reason,
            outboundChars: 0,
          })
        } else {
          releaseBroadcastClaim({
            robotId: robot.id,
            idempotencyKey: facts.idempotencyKey,
            targetKind,
            targetRef,
          })
          appendOutboundAudit({
            robotId: robot.id,
            category: 'broadcast',
            sourceEventKind: facts.kind,
            idempotencyKey: facts.idempotencyKey,
            targetKind,
            targetRef,
            objectWorkspace: facts.workspaceName,
            templateKey: result.templateKey ?? null,
            result: 'refused',
            refuseReason: reason,
            outboundChars: 0,
          })
        }
      }
    }
  }
}

export type { GuardRefuseReason }
