/**
 * Direct L2 todo notifications for events without an L0 broadcast candidate.
 */
import type { ImRobot } from '@ccc/shared/protocol'
import { listEnabledRobots } from './robot-store.js'
import {
  accountNamespaceOf,
  getActiveBindingForSender,
  listActiveBindings,
} from './identity-store.js'
import { getAnswerContract } from '../user-involve/answer-contract-store.js'
import { getEvent } from '../user-involve/store.js'
import { getRobotHandle } from './supervisor-access.js'
import { tryDeliverL2TodoPrompt } from './l2-broadcast-upgrade.js'

/** Notify the frozen actor via L2 when no broadcast dispatcher will run. */
export function maybeNotifyL2ForTodo(todoId: string): void {
  const contract = getAnswerContract(todoId)
  if (!contract) return
  const event = getEvent(todoId)
  if (!event || event.status !== 'todo') return

  for (const robot of listEnabledRobots()) {
    const handle = getRobotHandle(robot.id)
    if (!handle) continue
    const ns = accountNamespaceOf(robot.platform, robot.appId)
    const binding = listActiveBindings(ns).find((b) => b.subject === contract.actorSubject)
    if (!binding) continue
    void tryDeliverL2TodoPrompt({
      robot,
      target: {
        kind: 'p2p_dm',
        chatId: binding.senderId,
        senderId: binding.senderId,
        fullTemplate: true,
      },
      todoId,
      maxOutboundChars: handle.maxOutboundChars,
      rawSend: handle.rawSend,
    }).then((result) => {
      if (result?.ok) return
    })
    return
  }
}

/** Resolve binding for inbound token execution. */
export function activeBindingForActor(
  robot: ImRobot,
  actorSubject: string,
  senderId: string,
): ReturnType<typeof getActiveBindingForSender> {
  const ns = accountNamespaceOf(robot.platform, robot.appId)
  const binding = getActiveBindingForSender(ns, senderId)
  if (!binding || binding.subject !== actorSubject) return null
  return binding
}
