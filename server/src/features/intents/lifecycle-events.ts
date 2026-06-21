import type { Intent, IntentLifecyclePhase, IntentStatus } from '@ccc/shared/protocol'
import type { EventBus, EventBusEvents } from '../../kernel/events/event-bus.js'

let eventBus: EventBus<EventBusEvents> | null = null

/** Wire the process-wide event bus at the composition root. */
export function setIntentLifecycleEventBus(bus: EventBus<EventBusEvents>): void {
  eventBus = bus
}

/** Publish one safe, non-persistent lifecycle boundary for an intent. */
export function publishIntentLifecycle(
  workspacePath: string,
  intent: Intent,
  phase: IntentLifecyclePhase,
): void {
  eventBus?.publish('intent:lifecycle', {
    workspacePath,
    phase,
    intentId: intent.id,
    title: intent.title,
    module: intent.module ?? null,
    toStatus: intent.status,
  })
}

/** Map status transitions that are lifecycle boundaries; same-state writes publish nothing. */
export function publishIntentStatusTransition(
  workspacePath: string,
  intent: Intent,
  fromStatus: IntentStatus,
  toStatus: IntentStatus,
): void {
  if (fromStatus === toStatus) return
  const phase: IntentLifecyclePhase | null =
    toStatus === 'in_progress'
      ? 'dev_started'
      : toStatus === 'done'
        ? 'done'
        : toStatus === 'failed'
          ? 'failed'
          : toStatus === 'cancelled'
            ? 'cancelled'
            : null
  if (!phase) return
  publishIntentLifecycle(workspacePath, { ...intent, status: toStatus }, phase)
}
