/**
 * Wiring — automation scheduler startup (server refactor 3/3e-3).
 *
 * The `if (isAutomationStoreAvailable()) { … startScheduler() … }` block that
 * used to live at the bottom of `server.ts`. It wires the automation feature's
 * execution store to the shared broadcaster, then starts the scheduler.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1):
 * - This module lives in `wiring/`. It imports the automation feature (its
 *   store, scheduler) and the broadcaster — exactly the assembly the
 *   composition root used to do inline.
 */
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import type { GenericEventEnvelope, PrOperationEvent } from '@ccc/shared/protocol'
import {
  appendExecutionLog,
  deleteAutomation,
  getDueAutomations,
  getEventAutomations,
  getAutomation,
  isStoreAvailable as isAutomationStoreAvailable,
  updateNextRunAt,
  updateAutomation as updateAutomationStore,
  updateExecutionLog,
} from '../features/automations/store.js'
import { setExecutionStore, setEventBus } from '../features/automations/engine.js'
import { startScheduler, stopScheduler } from '../features/schedules/index.js'
import { dispatchEventTriggers } from '../features/triggers/index.js'
import { PR_EVENT_TYPE, projectPrOperationEvent } from '../features/pr-events/tool-defs.js'
import { registerAgentQuotaRecovery } from '../features/agent-quota-recovery.js'
import type { Broadcasts } from './broadcasts.js'

/** Start the scheduler + wire its execution store. */
export function startSchedulerWiring(deps: {
  broadcasts: Pick<Broadcasts, 'broadcastAutomations'>
  eventBus: EventBus<EventBusEvents>
}): void {
  const { broadcasts, eventBus } = deps
  registerAgentQuotaRecovery({ eventBus })
  if (!isAutomationStoreAvailable()) return

  // Wire the kernel event bus for scheduling run lifecycle events (2026-06-08-010).
  setEventBus(eventBus)

  setExecutionStore({
    getDueAutomations,
    getEventAutomations,
    getAutomation,
    updateNextRunAt,
    updateAutomation: (id: string, patch: { status?: string }) => {
      updateAutomationStore(id, {
        status: patch.status as import('@ccc/shared/protocol').AutomationStatus | undefined,
      })
    },
    deleteAutomation,
    appendExecutionLog: (input) => {
      return appendExecutionLog({
        automationId: input.automationId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode,
        output: input.output ?? '',
        error: input.error,
        status: 'running',
      })
    },
    updateExecutionLog,
    broadcast: broadcasts.broadcastAutomations,
  })

  // Bridge run lifecycle events → event-triggered automations (ADR-0018, 2026-06-08).
  // These are process-lifetime subscriptions (no dispose): the scheduler lives for
  // the whole server run, so the handlers are intentionally never torn down.
  eventBus.subscribe('run:started', (e) => dispatchEventTriggers('run:started', e))
  eventBus.subscribe('run:settled', (e) => dispatchEventTriggers('run:settled', e))
  // Bridge model-published events → event-triggered automations. The single
  // generic `'event'` topic carries every model-publishable event; this bridge
  // discriminates `pr:operation` and projects `operation`/`result` off the
  // normalized event before reusing the existing `pr:operation` dispatch (topic,
  // workspace, PR filter, in-flight gate). Same resident, never-disposed
  // subscription as the run topics. Persisted automation config still uses the
  // `eventTopic: 'pr:operation'` discriminant — only the bus topic is unified.
  eventBus.subscribe('event', (envelope) =>
    dispatchPrEventFromEnvelope(envelope, (payload) =>
      dispatchEventTriggers('pr:operation', payload),
    ),
  )
  eventBus.subscribe('intent:lifecycle', (e) => dispatchEventTriggers('intent:lifecycle', e))
  startScheduler()
}

/**
 * Bridge a generic `'event'` bus envelope to the `pr:operation` automation
 * dispatch. Discriminates the PR type, projects the normalized event to a
 * {@link PrOperationEvent} (operation/result + optional pr/repo/ref/association),
 * and forwards `{ sessionId, workspacePath } & PrOperationEvent` to `dispatch`
 * (which the caller binds to `dispatchEventTriggers('pr:operation', …)`). A non-PR
 * type or an un-projectable event is a no-op. Exported for unit coverage of the
 * projection bridge.
 */
export function dispatchPrEventFromEnvelope(
  envelope: GenericEventEnvelope,
  dispatch: (payload: { sessionId: string; workspacePath: string } & PrOperationEvent) => void,
): void {
  if (envelope.event.type !== PR_EVENT_TYPE) return
  const pr = projectPrOperationEvent(envelope.event)
  if (!pr) return
  dispatch({ sessionId: envelope.sessionId, workspacePath: envelope.workspacePath, ...pr })
}

/** Tear down the scheduler (used by SIGINT/SIGTERM graceful shutdown). */
export async function stopSchedulerWiring(graceMs: number): Promise<void> {
  await stopScheduler(graceMs)
}
