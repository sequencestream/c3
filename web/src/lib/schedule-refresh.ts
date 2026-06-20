import type { ScheduleExecutionLog } from '@ccc/shared/protocol'

/*
 * schedule-refresh — pure decision logic for live-refreshing a running schedule
 * execution on the history page.
 *
 * The history page polls the selected, running execution: every interval it
 * re-fetches the schedule detail (status / duration) and the execution
 * transcript (session content). When the run reaches a terminal state the poll
 * stops, after one final transcript fetch so the last content lands.
 *
 * This module holds only the booleans (no DOM, no timers, no `send`), so the
 * control layer can wire it to `setInterval` / `watch` while the decision stays
 * unit-testable.
 */

/** Poll cadence: a compromise between freshness and request volume. */
export const SCHEDULE_REFRESH_INTERVAL_MS = 5_000

/**
 * Whether an execution log is still running. Mirrors the same inference the
 * history rows use for their status badge: an explicit `running` status, or an
 * absent status with no finish time yet.
 */
export function isExecutionRunning(log: ScheduleExecutionLog | null): boolean {
  if (!log) return false
  if (log.status) return log.status === 'running'
  return log.finishedAt === null
}

export interface ScheduleRefreshInput {
  /** The selected execution is running (and is a refreshable llm session). */
  running: boolean
  /** The schedules tab is the active view. */
  tabActive: boolean
  /** The document is currently visible. */
  visible: boolean
  /** Whether the previous evaluation considered the execution running. */
  prevRunning: boolean
}

export interface ScheduleRefreshDecision {
  /** Issue a periodic poll now (refresh detail + transcript). */
  shouldPoll: boolean
  /** Issue a one-shot final transcript fetch now (running → terminal). */
  finalFetch: boolean
}

/**
 * Decide what to do for the current state of the selected execution.
 *
 * - `shouldPoll`: poll only while the run is live, the page is active, and the
 *   document is visible (hidden → skip this tick, AC#4).
 * - `finalFetch`: when the run transitions running → terminal while the page is
 *   active, fetch the transcript once more so the final content lands (AC#2).
 *   Visibility-independent: completion may be observed while hidden, and the
 *   final content must not be lost.
 */
export function decideScheduleRefresh(input: ScheduleRefreshInput): ScheduleRefreshDecision {
  const { running, tabActive, visible, prevRunning } = input
  return {
    shouldPoll: running && tabActive && visible,
    finalFetch: prevRunning && !running && tabActive,
  }
}
