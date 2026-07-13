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

  // Bridge every event → event-triggered automations (ADR-0018, 2026-06-08;
  // generalized 2026-07-13). Each source is projected onto the trusted minimal
  // {@link TriggerEventView} the generic matcher reads, then handed to the SAME
  // dispatch entry. These are process-lifetime subscriptions (no dispose): the
  // scheduler lives for the whole server run.
  //
  // Run lifecycle carries `sessionKind` (the mandatory security-boundary input);
  // `run:settled` maps its terminal `reason` to `event.status`, `run:started` has
  // no status. The scheduler's own automation runs stamp `metadata` onto the run
  // payload, which flows through as `event.metadata` for chain filtering.
  eventBus.subscribe('run:started', (e) =>
    dispatchEventTriggers({
      workspacePath: e.workspacePath,
      sessionKind: e.sessionKind,
      event: { type: 'run:started', ...(e.metadata ? { metadata: e.metadata } : {}) },
    }),
  )
  eventBus.subscribe('run:settled', (e) =>
    dispatchEventTriggers({
      workspacePath: e.workspacePath,
      sessionKind: e.sessionKind,
      event: {
        type: 'run:settled',
        status: e.reason,
        ...(e.metadata ? { metadata: e.metadata } : {}),
      },
    }),
  )
  // The single generic `'event'` topic already carries a NORMALIZED GenericEvent
  // (its `type`/`status`/`metadata` are baked in by the per-type normalizer — a PR
  // event has `status=result`, `metadata.operation=operation`). It needs no
  // per-type projection: the envelope's workspace + event ARE the trusted view, so
  // any registered event type (PR today, a future type tomorrow) flows straight to
  // the generic matcher with no code change here. PR events carry no session origin,
  // so no `sessionKind` is supplied (the sessionKind boundary is run-lifecycle only).
  eventBus.subscribe('event', (envelope) =>
    dispatchEventTriggers({ workspacePath: envelope.workspacePath, event: envelope.event }),
  )
  // Intent lifecycle: `type=intent:lifecycle`, `status=phase`. No session origin.
  eventBus.subscribe('intent:lifecycle', (e) =>
    dispatchEventTriggers({
      workspacePath: e.workspacePath,
      event: { type: 'intent:lifecycle', status: e.phase },
    }),
  )
  startScheduler()
}

/** Tear down the scheduler (used by SIGINT/SIGTERM graceful shutdown). */
export async function stopSchedulerWiring(graceMs: number): Promise<void> {
  await stopScheduler(graceMs)
}
