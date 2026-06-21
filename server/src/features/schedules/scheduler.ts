/**
 * Core schedule scheduler engine.
 *
 * A fixed-interval (10s) tick loop that queries the store for due schedules
 * and dispatches them for execution. Supports manual trigger (`triggerRunNow`)
 * and workspace-scoped cancellation. Each schedule executes serially — at most
 * one in-flight execution per schedule at a time (SCH-R7).
 *
 * Each execution now publishes run lifecycle events (`run:started` / `run:bound` /
 * `run:settled`) with `kind='schedule'` on the kernel event bus (ADR-0018
 * amendment, 2026-06-08-010). The resident schedule subscription in
 * `run-domain-subscriptions.ts` reacts to `run:settled` to broadcast the
 * refreshed schedule list.
 *
 * Import the singleton:
 *   import { scheduler } from './scheduler.js'
 *   scheduler.start()
 *   scheduler.stop()
 */

import { resolve } from 'node:path'
import type {
  IntentLifecycleEvent,
  IntentLifecycleFilter,
  PrOperation,
  PrOperationEvent,
  PrOperationFilter,
  PrOperationResult,
  RunEndReason,
  RunKind,
  RunLifecycleTopic,
  Schedule,
  ScheduleEventTopic,
} from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { computeNextRunAt } from '@ccc/shared/cron'
import type { EventBus, EventBusEvents } from '../../kernel/events/event-bus.js'

/**
 * Explicit RunKind whitelist for event-triggered schedules. Only `session`
 * runs (user/dev sessions) trigger schedules; every other RunKind (intent
 * comm, discussion, consensus, internal tool, the scheduler's own runs) is
 * internal and never triggers a schedule. Defined as a const array so it is
 * both testable and impossible to accidentally widen via a loose comparison.
 */
const SCHEDULE_TRIGGER_KINDS: readonly RunKind[] = ['session']
import { getTimezone } from '../../kernel/config/index.js'
import { execute, type UpdateLogFn } from './dispatcher.js'
import { isAgentQuotaRecoverySchedule } from './store.js'

export { computeNextRunAt }

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type ExecutionStore = {
  getDueSchedules: (now: number) => Schedule[]
  getEventSchedules: (topic: ScheduleEventTopic) => Schedule[]
  getSchedule: (id: string) => Schedule | null
  updateNextRunAt: (id: string, nextRunAt: number | null) => void
  updateSchedule: (id: string, patch: { status?: string }) => void
  deleteSchedule: (id: string) => void
  appendExecutionLog: (input: {
    scheduleId: string
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

export interface ScheduleScheduler {
  start(): void
  stop(timeoutMs?: number): Promise<void>
  triggerRunNow(scheduleId: string): Promise<void>
  cancelInFlight(scheduleId: string): void
  cancelAllForWorkspace(workspacePath: string): void
}

const GRACE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_TICK_MS = 10_000 // 10 seconds
const _MAX_OUTPUT_CHARS = 1_000_000 // ~1 MB

let store: ExecutionStore
let timer: ReturnType<typeof setInterval> | null = null
const inFlight = new Map<string, Promise<void>>()
/**
 * Kernel event bus for publishing run lifecycle events (2026-06-08-010).
 * Set by `scheduler-startup.ts` via `setEventBus()`.
 */
let eventBus: EventBus<EventBusEvents> | null = null

/** Set the store reference (called by server.ts after init). */
export function setExecutionStore(s: ExecutionStore): void {
  store = s
}

/** Set the event bus reference for publishing lifecycle events (2026-06-08-010). */
export function setEventBus(eb: EventBus<EventBusEvents>): void {
  eventBus = eb
}

/** Start the tick loop. No-op if no store is configured or already running. */
export function startScheduler(tickMs = DEFAULT_TICK_MS): void {
  if (timer !== null || !store) return
  console.log('[scheduler] starting tick loop every %dms', tickMs)
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] tick error:', err))
  }, tickMs)
}

/** Stop the tick loop and await in-flight executions. */
export async function stopScheduler(_timeoutMs = 30_000): Promise<void> {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
    console.log('[scheduler] tick loop stopped')
  }
  if (inFlight.size === 0) return
  console.log('[scheduler] waiting for %d in-flight executions...', inFlight.size)
  const results = await Promise.allSettled(
    [...inFlight.values()].map((p) => p.catch(() => {})),
    // Use a timeout via a race
  )
  const _timedOut = results.filter((r) => r.status === 'fulfilled' && r.value === undefined)
  console.log('[scheduler] %d executions settled', inFlight.size)
  inFlight.clear()
}

/** Manual trigger: execute a schedule immediately outside the tick loop. */
export async function triggerRunNow(scheduleId: string): Promise<void> {
  if (!store) return
  const schedule = store.getSchedule(scheduleId)
  if (!schedule) {
    console.warn('[scheduler] triggerRunNow: schedule %s not found', scheduleId)
    return
  }
  if (schedule.status !== 'active') {
    console.warn(
      '[scheduler] triggerRunNow: schedule %s not active (%s)',
      scheduleId,
      schedule.status,
    )
    return
  }
  if (inFlight.has(scheduleId)) {
    console.warn('[scheduler] triggerRunNow: schedule %s already in flight', scheduleId)
    return
  }
  dispatchAndTrack(schedule)
}

/** Run-lifecycle dispatch payload (`run:started` / `run:settled`). */
type RunDispatchPayload = {
  sessionId: string
  workspacePath: string
  reason?: RunEndReason
  kind: RunKind
}

/** PR-event dispatch payload (`pr:operation`) — the validated, normalized event. */
type PrDispatchPayload = { sessionId: string; workspacePath: string } & PrOperationEvent
type IntentDispatchPayload = { workspacePath: string } & IntentLifecycleEvent

/**
 * Whether a `pr:operation` event matches a schedule's PR filter. A null filter,
 * or an empty dimension, matches any value of that dimension (2026-06-20).
 */
function prFilterMatches(
  filter: PrOperationFilter | null,
  operation: PrOperation,
  result: PrOperationResult,
): boolean {
  if (!filter) return true
  if (filter.operations && filter.operations.length && !filter.operations.includes(operation)) {
    return false
  }
  if (filter.results && filter.results.length && !filter.results.includes(result)) {
    return false
  }
  return true
}

export function intentFilterMatches(
  filter: IntentLifecycleFilter | null,
  phase: IntentLifecycleEvent['phase'],
): boolean {
  return !filter?.phases?.length || filter.phases.includes(phase)
}

/**
 * Dispatch event-triggered schedules in response to a run lifecycle event
 * (2026-06-08) OR a model-published PR operation event (2026-06-20). Wired to the
 * kernel event bus in the composition root: the event arrives, and every active
 * event-trigger schedule that matches is executed via the SAME path as a cron run
 * (`dispatchAndTrack` → `execute`), reusing the three-tier MCP security model and
 * the write-approval queue.
 *
 * Filters, in order:
 *  - `kind` (run topics only): only `session` runs fire user schedules; every
 *    other RunKind is internal. PR events carry no RunKind — they are published by
 *    the model inside a work session and are never RunKind-filtered.
 *  - workspace: the event's workspace must equal the schedule's workspace.
 *  - reason (run:settled) / PR filter (pr:operation): topic-specific match.
 *  - in-flight: SCH-R7 serial execution doubles as event-storm throttling — a
 *    schedule already running skips the new event rather than stacking.
 */
export function dispatchEventSchedules(topic: RunLifecycleTopic, payload: RunDispatchPayload): void
export function dispatchEventSchedules(topic: 'pr:operation', payload: PrDispatchPayload): void
export function dispatchEventSchedules(
  topic: 'intent:lifecycle',
  payload: IntentDispatchPayload,
): void
export function dispatchEventSchedules(
  topic: ScheduleEventTopic,
  payload: RunDispatchPayload | PrDispatchPayload | IntentDispatchPayload,
): void {
  if (!store) return
  // Explicit RunKind whitelist: only `session` runs (user/dev) fire user
  // schedules; every other RunKind is internal. PR events carry no RunKind (the
  // whitelist is run-lifecycle-specific), so they bypass this gate by design.
  if (topic !== 'pr:operation' && topic !== 'intent:lifecycle') {
    const kind = (payload as RunDispatchPayload).kind
    if (!SCHEDULE_TRIGGER_KINDS.includes(kind)) return
  }

  let candidates: Schedule[]
  try {
    candidates = store.getEventSchedules(topic)
  } catch (err) {
    console.error('[scheduler] getEventSchedules failed for %s:', topic, err)
    return
  }

  const eventWorkspace = resolve(payload.workspacePath)
  for (const schedule of candidates) {
    if (schedule.status !== 'active') continue
    // Workspace filter: both sides are resolved to compare canonical paths.
    if (resolveWorkspaceRoot(schedule.workspaceId)! !== eventWorkspace) continue
    // Topic-specific filter.
    if (topic === 'pr:operation') {
      const e = payload as PrDispatchPayload
      if (!prFilterMatches(schedule.eventPrFilter, e.operation, e.result)) continue
    } else if (topic === 'intent:lifecycle') {
      if (
        !intentFilterMatches(
          schedule.eventIntentFilter ?? null,
          (payload as IntentDispatchPayload).phase,
        )
      )
        continue
    } else {
      // Reason filter (run:settled only — run:started carries no reason).
      const reason = (payload as RunDispatchPayload).reason
      const filter = schedule.eventReasonFilter
      if (filter && filter.length && reason && !filter.includes(reason)) continue
    }
    // SCH-R7 / event-storm throttle: one in-flight execution per schedule.
    if (inFlight.has(schedule.id)) {
      console.warn(
        '[scheduler] event %s: schedule %s already in flight, skipping',
        topic,
        schedule.id,
      )
      continue
    }
    dispatchAndTrack(schedule)
  }
}

/** Cancel a single in-flight execution (aborts the underlying promise chain). */
export function cancelInFlight(scheduleId: string): void {
  inFlight.delete(scheduleId)
}

/** Cancel all in-flight executions for a given workspace. */
export function cancelAllForWorkspace(workspacePath: string): void {
  for (const [sid] of inFlight) {
    const s = store?.getSchedule(sid)
    if (s && resolveWorkspaceRoot(s.workspaceId)! === workspacePath) {
      inFlight.delete(sid)
    }
  }
}

/** Check if a schedule has an in-flight execution. */
export function hasInFlight(scheduleId: string): boolean {
  return inFlight.has(scheduleId)
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (!store) return
  const now = Date.now()
  const due: Schedule[] = []

  try {
    const rows = store.getDueSchedules(now)
    for (const s of rows) {
      if (s.status !== 'active') continue
      if (s.triggerType === 'event') continue // event schedules never fire from the tick loop
      if (inFlight.has(s.id)) continue // SCH-R7: serial execution
      due.push(s)
    }
  } catch (err) {
    console.error('[scheduler] getDueSchedules failed:', err)
    return
  }

  for (const schedule of due) {
    // Grace window check
    if (
      schedule.nextRunAt !== null &&
      schedule.nextRunAt < now - GRACE_WINDOW_MS &&
      !isAgentQuotaRecoverySchedule(schedule)
    ) {
      console.warn(
        '[scheduler] schedule %s missed trigger window (next_run_at=%d, now=%d)',
        schedule.id,
        schedule.nextRunAt,
        now,
      )
      try {
        store.appendExecutionLog({
          scheduleId: schedule.id,
          startedAt: now,
          finishedAt: now,
          exitCode: null,
          output: '',
          error: 'missed_trigger_window',
        })
        // A delayed tick must not disable a recurring schedule. Record the
        // missed occurrence, then re-arm it from the current time so that the
        // same stale instant cannot be reported on every following tick.
        const next = computeNextRunAt(schedule.cronExpression, now, getTimezone())
        store.updateNextRunAt(schedule.id, next)
      } catch (logErr) {
        console.error('[scheduler] failed to record missed trigger for %s:', schedule.id, logErr)
      }
      continue
    }

    dispatchAndTrack(schedule)
  }
}

function dispatchAndTrack(schedule: Schedule): void {
  // Create execution log before dispatch
  let logId: string
  try {
    const log = store.appendExecutionLog({
      scheduleId: schedule.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
    })
    logId = log.id
  } catch (err) {
    console.error('[scheduler] failed to create execution log for %s:', schedule.id, err)
    return
  }

  const updateLog: UpdateLogFn = (id: string, patch: Record<string, unknown>) => {
    try {
      store.updateExecutionLog(id, patch)
    } catch (err) {
      console.error('[scheduler] updateExecutionLog failed:', err)
    }
  }

  // Publish schedule run lifecycle events (2026-06-08-010).
  eventBus?.publish('run:started', {
    sessionId: logId,
    workspacePath: resolveWorkspaceRoot(schedule.workspaceId)!,
    kind: 'schedule',
  })
  eventBus?.publish('run:bound', {
    prevId: logId,
    realId: logId,
    workspacePath: resolveWorkspaceRoot(schedule.workspaceId)!,
  })

  // Track execution outcome via the updateLog wrapper so we can set the
  // correct settled reason (complete vs error).
  let success = true
  const trackingUpdateLog: UpdateLogFn = (id, patch) => {
    if (patch.status === 'failed' || patch.status === 'cancelled') success = false
    updateLog(id, patch)
  }

  const exec = execute(schedule, logId, trackingUpdateLog)
    .finally(() => {
      inFlight.delete(schedule.id)
      const workspacePath = resolveWorkspaceRoot(schedule.workspaceId)!
      // After execution, update next_run_at
      try {
        const updated = store.getSchedule(schedule.id)
        // Event-triggered schedules have no cron: they re-arm by waiting for the
        // next lifecycle event, so next_run_at stays null (never recompute it).
        if (updated && updated.status === 'active' && isAgentQuotaRecoverySchedule(updated)) {
          // One-shot agent recovery schedule: its sole job (re-enable the agent
          // once its quota resets) is done the moment it fires. Delete it outright
          // — along with its execution logs — instead of leaving a paused zombie
          // behind; the next quota error simply creates a fresh recovery schedule.
          store.deleteSchedule(schedule.id)
          console.log(
            '[scheduler] one-shot agent recovery schedule %s deleted after recovery',
            schedule.id,
          )
        } else if (updated && updated.status === 'active' && updated.triggerType !== 'event') {
          const next = computeNextRunAt(updated.cronExpression, Date.now(), getTimezone())
          store.updateNextRunAt(schedule.id, next)
          console.log(
            '[scheduler] schedule %s next run at %s',
            schedule.id,
            new Date(next).toISOString(),
          )
        }
        // Schedule list broadcast is now handled by the resident subscription
        // on `run:settled` (kind=schedule) in run-domain-subscriptions.ts.
      } catch (err) {
        console.error('[scheduler] failed to update next_run_at for %s:', schedule.id, err)
      }

      // Publish settled lifecycle event — the subscription broadcasts the
      // refreshed schedule list synchronously when this fires.
      const reason: RunEndReason = success ? 'complete' : 'error'
      eventBus?.publish('run:settled', {
        sessionId: logId,
        workspacePath,
        reason,
        kind: 'schedule',
      })
    })
    .catch((err) => {
      console.error('[scheduler] execution failed for %s:', schedule.id, err)
    })

  inFlight.set(schedule.id, exec)
}
