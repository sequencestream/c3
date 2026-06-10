/**
 * Wiring — schedule scheduler startup (server refactor 3/3e-3).
 *
 * The `if (isScheduleStoreAvailable()) { … startScheduler() … }` block that
 * used to live at the bottom of `server.ts`. It wires the schedule feature's
 * execution store to the shared broadcaster, then starts the scheduler.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1):
 * - This module lives in `wiring/`. It imports the schedule feature (its
 *   store, scheduler) and the broadcaster — exactly the assembly the
 *   composition root used to do inline.
 */
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import {
  appendExecutionLog,
  getDueSchedules,
  getEventSchedules,
  getSchedule,
  isStoreAvailable as isScheduleStoreAvailable,
  updateNextRunAt,
  updateSchedule as updateScheduleStore,
  updateExecutionLog,
} from '../features/schedules/store.js'
import {
  dispatchEventSchedules,
  setExecutionStore,
  setEventBus,
  startScheduler,
  stopScheduler,
} from '../features/schedules/scheduler.js'
import type { Broadcasts } from './broadcasts.js'

/** Start the scheduler + wire its execution store. */
export function startSchedulerWiring(deps: {
  broadcasts: Pick<Broadcasts, 'broadcastSchedules'>
  eventBus: EventBus<EventBusEvents>
}): void {
  if (!isScheduleStoreAvailable()) return
  const { broadcasts, eventBus } = deps

  // Wire the kernel event bus for scheduling run lifecycle events (2026-06-08-010).
  setEventBus(eventBus)

  setExecutionStore({
    getDueSchedules,
    getEventSchedules,
    getSchedule,
    updateNextRunAt,
    updateSchedule: (id: string, patch: { status?: string }) => {
      updateScheduleStore(id, {
        status: patch.status as import('@ccc/shared/protocol').ScheduleStatus | undefined,
      })
    },
    appendExecutionLog: (input) => {
      return appendExecutionLog({
        scheduleId: input.scheduleId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode,
        output: input.output ?? '',
        error: input.error,
        status: 'running',
      })
    },
    updateExecutionLog,
    broadcast: broadcasts.broadcastSchedules,
  })

  // Bridge run lifecycle events → event-triggered schedules (ADR-0018, 2026-06-08).
  // These are process-lifetime subscriptions (no dispose): the scheduler lives for
  // the whole server run, so the handlers are intentionally never torn down.
  eventBus.subscribe('run:started', (e) => dispatchEventSchedules('run:started', e))
  eventBus.subscribe('run:settled', (e) => dispatchEventSchedules('run:settled', e))

  startScheduler()
}

/** Tear down the scheduler (used by SIGINT/SIGTERM graceful shutdown). */
export async function stopSchedulerWiring(graceMs: number): Promise<void> {
  await stopScheduler(graceMs)
}
