/**
 * L0 broadcast recipient resolution — bindings × personal scope × group grants.
 *
 * Solves targets twice: once when the candidate arrives and again immediately
 * before send. Callers cannot inject arbitrary chat ids — only this module and
 * the inbound reply path produce {@link BroadcastDeliveryTarget}s.
 */
import type { ImBroadcastType, ImRobot } from '@ccc/shared/protocol'
import { listWorkspacesForSubject } from '../auth/authorization.js'
import {
  accountNamespaceOf,
  groupWorkspaceNames,
  listActiveBindings,
  providerAccountKeyOf,
} from './identity-store.js'

export type BroadcastDeliveryTarget =
  | {
      kind: 'p2p_dm'
      chatId: string
      senderId: string
      /** Full template when true; never used for p2p (always full). */
      fullTemplate: true
    }
  | {
      kind: 'group'
      chatId: string
      /** Full object fields when true; category downgrade when false. */
      fullTemplate: boolean
    }

export function resolveBroadcastRecipients(
  robot: ImRobot,
  eventKind: ImBroadcastType,
  objectWorkspace: string,
): BroadcastDeliveryTarget[] {
  if (!robot.broadcastEventTypes.includes(eventKind)) return []

  const targets: BroadcastDeliveryTarget[] = []
  const ns = accountNamespaceOf(robot.platform, robot.appId)
  const providerKey = providerAccountKeyOf(robot.platform, robot.appId)

  if (robot.broadcastToBoundUsers) {
    for (const binding of listActiveBindings(ns)) {
      const personal = listWorkspacesForSubject(binding.subject).map((w) => w.name)
      if (!personal.includes(objectWorkspace)) continue
      targets.push({
        kind: 'p2p_dm',
        chatId: binding.senderId,
        senderId: binding.senderId,
        fullTemplate: true,
      })
    }
  }

  for (const chatId of robot.broadcastGroupChatIds) {
    if (robot.chatAllowlist.length > 0 && !robot.chatAllowlist.includes(chatId)) continue
    const groupScopes = groupWorkspaceNames(robot.platform, providerKey, chatId)
    const fullTemplate = groupScopes.includes(objectWorkspace)
    targets.push({ kind: 'group', chatId, fullTemplate })
  }

  return targets
}

/** Dedupe identical chat targets (same chat may not appear twice). */
export function dedupeBroadcastTargets(
  targets: BroadcastDeliveryTarget[],
): BroadcastDeliveryTarget[] {
  const seen = new Set<string>()
  const out: BroadcastDeliveryTarget[] = []
  for (const t of targets) {
    const key = t.kind === 'p2p_dm' ? `p2p:${t.chatId}` : `grp:${t.chatId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}
