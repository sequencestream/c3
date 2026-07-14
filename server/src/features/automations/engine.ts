/**
 * Automation execution engine — the shared core used by BOTH the time-schedule
 * tick loop (`../schedules`) and the event-trigger dispatch (`../triggers`).
 *
 * Owns the singleton execution state: the store reference, the kernel event bus,
 * and the in-flight map that enforces serial execution per automation (SCH-R7).
 * Each execution publishes run lifecycle events (`run:started` / `run:bound` /
 * `run:settled`) with `sessionKind='automation'` on the kernel event bus. The
 * resident automation subscription in `run-domain-subscriptions.ts` reacts to
 * `run:settled` to broadcast the refreshed automation list.
 */

import type { Automation, RunEndReason } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { computeNextRunAt } from '@ccc/shared/cron'
import type { EventBus, EventBusEvents } from '../../kernel/events/event-bus.js'
import { getTimezone } from '../../kernel/config/index.js'
import { execute, type UpdateLogFn } from './dispatcher.js'
import { isAgentQuotaRecoveryAutomation } from './store.js'

export { computeNextRunAt }

export type ExecutionStore = {
  getDueAutomations: (now: number) => Automation[]
  /** Active event-trigger automations with a subscription row accepting the given type. */
  getEventAutomations: (type: string) => Automation[]
  getAutomation: (id: string) => Automation | null
  updateNextRunAt: (id: string, nextRunAt: number | null) => void
  updateAutomation: (id: string, patch: { status?: string }) => void
  deleteAutomation: (id: string) => void
  appendExecutionLog: (input: {
    automationId: string
    startedAt: number
    finishedAt: number | null
    exitCode: number | null
    output: string
    error: string | null
  }) => { id: string }
  updateExecutionLog: (id: string, patch: Record<string, unknown>) => void
  /** Optional: called after an execution completes to notify subscribers. */
  broadcast?: (workspacePath: string) => void
}

let store: ExecutionStore | undefined
/**
 * Kernel event bus for publishing run lifecycle events (2026-06-08-010).
 * Set by `scheduler-startup.ts` via `setEventBus()`.
 */
let eventBus: EventBus<EventBusEvents> | null = null

/** In-flight executions, keyed by automation id — SCH-R7 serial execution. */
export const inFlight = new Map<string, Promise<void>>()

/** Set the store reference (called by server.ts after init). */
export function setExecutionStore(s: ExecutionStore): void {
  store = s
}

/** Set the event bus reference for publishing lifecycle events (2026-06-08-010). */
export function setEventBus(eb: EventBus<EventBusEvents>): void {
  eventBus = eb
}

/** The configured store, or undefined when the db is unavailable. */
export function getStore(): ExecutionStore | undefined {
  return store
}

/** Manual trigger: execute an automation immediately outside the tick loop. */
export async function triggerRunNow(automationId: string): Promise<void> {
  if (!store) return
  const automation = store.getAutomation(automationId)
  if (!automation) {
    console.warn('[scheduler] triggerRunNow: automation %s not found', automationId)
    return
  }
  if (automation.status === 'archived') {
    console.warn(
      '[scheduler] triggerRunNow: automation %s archived (%s)',
      automationId,
      automation.status,
    )
    return
  }
  if (inFlight.has(automationId)) {
    console.warn('[scheduler] triggerRunNow: automation %s already in flight', automationId)
    return
  }
  dispatchAndTrack(automation)
}

/** Cancel a single in-flight execution (aborts the underlying promise chain). */
export function cancelInFlight(automationId: string): void {
  inFlight.delete(automationId)
}

/** Cancel all in-flight executions for a given workspace. */
export function cancelAllForWorkspace(workspacePath: string): void {
  for (const [sid] of inFlight) {
    const s = store?.getAutomation(sid)
    if (s && resolveWorkspaceRoot(s.workspaceId)! === workspacePath) {
      inFlight.delete(sid)
    }
  }
}

/** Check if an automation has an in-flight execution. */
export function hasInFlight(automationId: string): boolean {
  return inFlight.has(automationId)
}

/**
 * Create the execution log, publish run lifecycle events, run the automation via
 * the dispatcher, and re-arm / clean up on settle. Shared by the tick loop and
 * the event-trigger dispatch so both use the identical execution path.
 */
export function dispatchAndTrack(automation: Automation): void {
  if (!store) return
  const activeStore = store
  // Create execution log before dispatch
  let logId: string
  try {
    const log = activeStore.appendExecutionLog({
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
    })
    logId = log.id
  } catch (err) {
    console.error('[scheduler] failed to create execution log for %s:', automation.id, err)
    return
  }

  const updateLog: UpdateLogFn = (id: string, patch: Record<string, unknown>) => {
    try {
      activeStore.updateExecutionLog(id, patch)
    } catch (err) {
      console.error('[scheduler] updateExecutionLog failed:', err)
    }
  }

  // Publish automation run lifecycle events (2026-06-08-010). Only the scheduler's
  // own automation run stamps `metadata` onto the payload (the automation's configured
  // annotations), so downstream event-triggered automations can chain by metadata.
  const eventMetadata = automation.metadata ?? null
  eventBus?.publish('run:started', {
    sessionId: logId,
    workspacePath: resolveWorkspaceRoot(automation.workspaceId)!,
    sessionKind: 'automation',
    runKind: 'headless',
    metadata: eventMetadata,
  })
  eventBus?.publish('run:bound', {
    prevId: logId,
    realId: logId,
    workspacePath: resolveWorkspaceRoot(automation.workspaceId)!,
  })

  // Track execution outcome via the updateLog wrapper so we can set the
  // correct settled reason (complete vs error).
  let success = true
  const trackingUpdateLog: UpdateLogFn = (id, patch) => {
    if (patch.status === 'failed' || patch.status === 'cancelled') success = false
    updateLog(id, patch)
  }

  const exec = execute(automation, logId, trackingUpdateLog)
    .finally(() => {
      inFlight.delete(automation.id)
      const workspacePath = resolveWorkspaceRoot(automation.workspaceId)!
      // After execution, update next_run_at
      try {
        const updated = activeStore.getAutomation(automation.id)
        // Event-triggered automations have no cron: they re-arm by waiting for the
        // next lifecycle event, so next_run_at stays null (never recompute it).
        if (updated && updated.status === 'active' && isAgentQuotaRecoveryAutomation(updated)) {
          // One-shot agent recovery automation: its sole job (re-enable the agent
          // once its quota resets) is done the moment it fires. Delete it outright
          // — along with its execution logs — instead of leaving a paused zombie
          // behind; the next quota error simply creates a fresh recovery automation.
          activeStore.deleteAutomation(automation.id)
          console.log(
            '[scheduler] one-shot agent recovery automation %s deleted after recovery',
            automation.id,
          )
        } else if (updated && updated.status === 'active' && updated.triggerType !== 'event') {
          const next = computeNextRunAt(updated.cronExpression, Date.now(), getTimezone())
          activeStore.updateNextRunAt(automation.id, next)
          console.log(
            '[scheduler] automation %s next run at %s',
            automation.id,
            new Date(next).toISOString(),
          )
        }
        // Automation list broadcast is now handled by the resident subscription
        // on `run:settled` (sessionKind=automation) in run-domain-subscriptions.ts.
      } catch (err) {
        console.error('[scheduler] failed to update next_run_at for %s:', automation.id, err)
      }

      // Publish settled lifecycle event — the subscription broadcasts the
      // refreshed automation list synchronously when this fires.
      const reason: RunEndReason = success ? 'complete' : 'error'
      eventBus?.publish('run:settled', {
        sessionId: logId,
        workspacePath,
        reason,
        sessionKind: 'automation',
        runKind: 'headless',
        metadata: eventMetadata,
      })
    })
    .catch((err) => {
      console.error('[scheduler] execution failed for %s:', automation.id, err)
    })

  inFlight.set(automation.id, exec)
}
