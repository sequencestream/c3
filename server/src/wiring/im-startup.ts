/**
 * Wiring — bring the IM supervisor up and down with the server.
 *
 * Mirrors `scheduler-startup.ts`: the composition root calls these two, and the
 * feature module stays free of any knowledge about process lifecycle.
 */
import type { EventBus } from '../kernel/events/event-bus.js'
import { subscribeImBroadcastDispatcher } from '../features/im/broadcast-dispatcher.js'
import { wireBroadcastCandidateBus } from '../features/im/broadcast-publish.js'
import { ensureOutboundAuditSchema } from '../features/im/outbound-audit-store.js'
import { startImSupervisor, stopImSupervisor } from '../features/im/supervisor.js'
import { ensureRobotSchema } from '../features/im/robot-store.js'
import { ensureIdentitySchema } from '../features/im/identity-store.js'
import { makeRunRobotTurn, type RobotTurnDeps } from './robot-turn.js'

let disposeBroadcast: (() => void) | null = null

export function startImRobotsWiring(deps: RobotTurnDeps, eventBus: EventBus): void {
  if (!ensureRobotSchema() || !ensureIdentitySchema() || !ensureOutboundAuditSchema()) {
    console.warn('[c3][im] robot/identity/outbound store unavailable; chat robots disabled')
    return
  }
  wireBroadcastCandidateBus(eventBus)
  disposeBroadcast = subscribeImBroadcastDispatcher(eventBus)
  startImSupervisor({ runTurn: makeRunRobotTurn(deps) })
}

export async function stopImRobotsWiring(timeoutMs = 30_000): Promise<void> {
  disposeBroadcast?.()
  disposeBroadcast = null
  await stopImSupervisor(timeoutMs)
}
