/**
 * WorkCenter cross-project rollup (feature handler, ADR-0009).
 *
 * `get_timerange_stats` walks every registered workspace and aggregates the four
 * work surfaces (work sessions / intents / discussions / schedules) into one
 * {@link TimeRangeProjectStats} per project, returned in a single
 * `timerange_stats` reply — replacing the 4×N independent requests the client
 * would otherwise fan out.
 *
 * Time filtering: `startTime`/`endTime` (ms epoch, both optional) restrict the
 * counts by `updated_at` (intents/discussions/schedules) or `last_modified`
 * (sessions). The two `running` counts are a live "now" notion (runtime registry
 * / execution logs) and deliberately ignore the range.
 *
 * No db is required to answer: when `c3.db` is unavailable every store count
 * returns 0/empty, and the session-`running` tally still reflects the in-memory
 * runtime registry — so the reply degrades gracefully rather than erroring.
 */
import type { TimeRangeProjectStats } from '@ccc/shared/protocol'
import type { Handler } from '../../transport/handler-registry.js'
import { listWorkspaces } from '../../state.js'
import { runningCountForWorkspace } from '../../runs.js'
import { countByStatusInRange as countIntentsByStatus } from '../intents/store.js'
import { countByStatusInRange as countDiscussionsByStatus } from '../discussions/store.js'
import { countSchedulesInRange, countRunningSchedules } from '../schedules/store.js'
import { countRealInRange } from '../works/work-session-store.js'

/** Build one project's rollup from the store/runtime counts. */
function projectStats(
  workspacePath: string,
  projectName: string,
  startTime?: number,
  endTime?: number,
): TimeRangeProjectStats {
  const intents = countIntentsByStatus(workspacePath, startTime, endTime)
  const discussions = countDiscussionsByStatus(workspacePath, startTime, endTime)
  const schedules = countSchedulesInRange(workspacePath, startTime, endTime)
  return {
    workspacePath,
    projectName,
    workSessions: {
      total: countRealInRange(workspacePath, startTime, endTime),
      running: runningCountForWorkspace(workspacePath),
    },
    intents: {
      in_progress: intents.in_progress ?? 0,
      todo: intents.todo ?? 0,
      done: intents.done ?? 0,
    },
    discussions: {
      in_progress: discussions.in_progress ?? 0,
      completed: discussions.completed ?? 0,
    },
    schedules: {
      total: schedules.total,
      active: schedules.active,
      running: countRunningSchedules(workspacePath),
    },
  }
}

export const getTimeRangeStatsHandler: Handler<'get_timerange_stats'> = (_ctx, conn, msg) => {
  const stats = listWorkspaces().map((ws) =>
    projectStats(ws.path, ws.name, msg.startTime, msg.endTime),
  )
  conn.send({ type: 'timerange_stats', stats })
}
