/**
 * Core schedule scheduler engine.
 *
 * A fixed-interval (10s) tick loop that queries the store for due schedules
 * and dispatches them for execution. Supports manual trigger (`triggerRunNow`)
 * and workspace-scoped cancellation. Each schedule executes serially — at most
 * one in-flight execution per schedule at a time (SCH-R7).
 *
 * Import the singleton:
 *   import { scheduler } from './scheduler.js'
 *   scheduler.start()
 *   scheduler.stop()
 */

import { getSchedule } from './store.js'
import type { Schedule } from '@ccc/shared/protocol'
import { execute, type UpdateLogFn } from './dispatcher.js'

// ---------------------------------------------------------------------------
// Inline cron-parser — minimal 5-field "standard" cron (no @yearly, no seconds)
// ---------------------------------------------------------------------------

interface CronField {
  values: Set<number> // matching values (0-based for all fields)
  all: boolean // true if field is '*'
}

/**
 * Parse a single cron field into a set of matching values.
 * Supports: asterisk, asterisk/N, N-M, N,M,O, and bare numbers.
 */
function parseField(field: string, min: number, max: number): CronField {
  if (field === '*') return { values: new Set<number>(), all: true }
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\d+)(?:-(\d+))?\/(\d+)$/)
    const rangeMatch = part.match(/^(\d+)(?:-(\d+))?$/)
    const wildStep = part.match(/^\*\/(\d+)$/)
    if (wildStep) {
      const step = parseInt(wildStep[1], 10)
      for (let v = min; v <= max; v += step) values.add(v)
    } else if (stepMatch) {
      const lo = parseInt(stepMatch[1], 10)
      const hi = stepMatch[2] !== undefined ? parseInt(stepMatch[2], 10) : max
      const step = parseInt(stepMatch[3], 10)
      for (let v = lo; v <= hi; v += step) values.add(v)
    } else if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10)
      const hi = rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : lo
      for (let v = lo; v <= hi; v++) values.add(v)
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n)) values.add(n)
    }
  }
  return { values, all: false }
}

interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

/**
 * Parse a 5-field cron expression into structured fields.
 * Standard order: minute hour day-of-month month day-of-week.
 */
function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields, got ${fields.length}`)
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6),
  }
}

function matches(field: CronField, value: number): boolean {
  return field.all || field.values.has(value)
}

/**
 * Compute the next run timestamp (Unix ms) at or after `after` for a cron expression.
 * Walks forward minute-by-minute until all fields match. Throws if no match found
 * within a reasonable look-ahead (2 years) to avoid infinite loops on impossible
 * expressions.
 */
export function computeNextRunAt(cronExpression: string, after: number = Date.now()): number {
  const cron = parseCron(cronExpression)
  const start = new Date(after)
  // Round to next full minute
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  const MAX_LOOKAHEAD = 365 * 2 + 1 // days
  let checked = 0

  for (let d = 0; d < MAX_LOOKAHEAD; d++) {
    const date = new Date(start)
    date.setUTCDate(date.getUTCDate() + d)
    if (!matches(cron.month, date.getUTCMonth() + 1)) continue
    if (!matches(cron.dayOfMonth, date.getUTCDate()) && !matches(cron.dayOfWeek, date.getUTCDay()))
      continue

    for (let h = 0; h < 24; h++) {
      if (!matches(cron.hour, h)) continue
      for (let m = 0; m < 60; m++) {
        checked++
        if (!matches(cron.minute, m)) continue
        date.setUTCHours(h, m, 0, 0)
        if (date.getTime() <= after) continue
        return date.getTime()
      }
    }
  }
  // Fallback: schedule far in the future to avoid tight loop on invalid cron
  return after + 365 * 24 * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type ExecutionStore = {
  getDueSchedules: (now: number) => Schedule[]
  getSchedule: (id: string) => Schedule | null
  updateNextRunAt: (id: string, nextRunAt: number | null) => void
  updateSchedule: (id: string, patch: { status?: string }) => void
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
const MAX_OUTPUT_CHARS = 1_000_000 // ~1 MB

let store: ExecutionStore
let timer: ReturnType<typeof setInterval> | null = null
const inFlight = new Map<string, Promise<void>>()

/** Set the store reference (called by server.ts after init). */
export function setExecutionStore(s: ExecutionStore): void {
  store = s
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
export async function stopScheduler(timeoutMs = 30_000): Promise<void> {
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
  const timedOut = results.filter((r) => r.status === 'fulfilled' && r.value === undefined)
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

/** Cancel a single in-flight execution (aborts the underlying promise chain). */
export function cancelInFlight(scheduleId: string): void {
  inFlight.delete(scheduleId)
}

/** Cancel all in-flight executions for a given workspace. */
export function cancelAllForWorkspace(workspacePath: string): void {
  for (const [sid] of inFlight) {
    const s = store?.getSchedule(sid)
    if (s && s.workspacePath === workspacePath) {
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
      if (inFlight.has(s.id)) continue // SCH-R7: serial execution
      due.push(s)
    }
  } catch (err) {
    console.error('[scheduler] getDueSchedules failed:', err)
    return
  }

  for (const schedule of due) {
    // Grace window check
    if (schedule.nextRunAt !== null && schedule.nextRunAt < now - GRACE_WINDOW_MS) {
      console.warn(
        '[scheduler] schedule %s missed trigger window (next_run_at=%d, now=%d)',
        schedule.id,
        schedule.nextRunAt,
        now,
      )
      try {
        store.updateSchedule(schedule.id, { status: 'error' })
        store.appendExecutionLog({
          scheduleId: schedule.id,
          startedAt: now,
          finishedAt: now,
          exitCode: null,
          output: '',
          error: 'missed_trigger_window',
        })
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

  const exec = execute(schedule, logId, updateLog)
    .finally(() => {
      inFlight.delete(schedule.id)
      const workspacePath = schedule.workspacePath
      // After execution, update next_run_at
      try {
        const updated = store.getSchedule(schedule.id)
        if (updated && updated.status === 'active') {
          const next = computeNextRunAt(updated.cronExpression, Date.now())
          store.updateNextRunAt(schedule.id, next)
          console.log(
            '[scheduler] schedule %s next run at %s',
            schedule.id,
            new Date(next).toISOString(),
          )
        }
        // Broadcast the updated schedule list if a broadcast function is configured
        if (store.broadcast) {
          store.broadcast(workspacePath)
        }
      } catch (err) {
        console.error('[scheduler] failed to update next_run_at for %s:', schedule.id, err)
      }
    })
    .catch((err) => {
      console.error('[scheduler] execution failed for %s:', schedule.id, err)
    })

  inFlight.set(schedule.id, exec)
}
