/**
 * WorkCenter cross-project aggregation (feature handlers, ADR-0009).
 *
 * Two surfaces:
 *  - `get_timerange_stats` → `timerange_stats`: the legacy per-project rollup with
 *    an optional time range (kept for compatibility; see {@link getTimeRangeStatsHandler}).
 *  - `get_workspace_dashboard` → `workspace_dashboard`: the Workcenter Dashboard
 *    snapshot — one live, time-range-independent {@link WorkspaceDashboardRow} per
 *    registered workspace in a single round-trip. Its `sessions.total` counts every
 *    `SessionKind` (not just work), and a db/aggregation failure yields a structured
 *    error rather than a misleading all-zero row.
 *  - `set_workspaces_automation_enabled` → `workspaces_automation_result`: an
 *    admin-only bulk write of the workspace automation master gate, settling each
 *    workspace independently and replying with per-item outcomes plus a fresh snapshot.
 */
import type {
  TimeRangeProjectStats,
  WorkspaceDashboardRow,
  WorkspaceAutomationGateResult,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { Handler } from '../../transport/handler-registry.js'
import { listWorkspaces, pathToId, resolveWorkspaceRoot } from '../../state.js'
import { runningCountForWorkspace, runningRuntimeSessionIdsForWorkspace } from '../../runs.js'
import { countByStatusInRange as countIntentsByStatus } from '../intents/store.js'
import { countByStatusInRange as countDiscussionsByStatus } from '../discussions/store.js'
import {
  countAutomationsInRange,
  countRunningAutomations,
  runningAutomationSessionIdsForWorkspace,
} from '../automations/store.js'
import { countRealInRange, countBoundSessions } from '../sessions/session-metadata-store.js'
import { getDb } from '../../kernel/infra/db.js'
import {
  getAutomationEnabled,
  loadWorkspaceSetting,
  saveWorkspaceSetting,
} from '../../kernel/config/index.js'
import { requireAdmin } from '../auth/authz.js'

/** Build one project's rollup from the store/runtime counts. */
function projectStats(
  workspacePath: string,
  projectName: string,
  startTime?: number,
  endTime?: number,
): TimeRangeProjectStats {
  const intents = countIntentsByStatus(workspacePath, startTime, endTime)
  const discussions = countDiscussionsByStatus(workspacePath, startTime, endTime)
  const automations = countAutomationsInRange(workspacePath, startTime, endTime)
  return {
    workspaceId: pathToId(workspacePath)!,
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
    automations: {
      total: automations.total,
      active: automations.active,
      running: countRunningAutomations(workspacePath),
    },
  }
}

export const getTimeRangeStatsHandler: Handler<'get_timerange_stats'> = (_ctx, conn, msg) => {
  const stats = listWorkspaces().map((ws) =>
    projectStats(resolveWorkspaceRoot(ws.id)!, ws.name, msg.startTime, msg.endTime),
  )
  conn.send({ type: 'timerange_stats', stats })
}

// ---- Workspace Dashboard snapshot ----

/** Total rows behind a `GROUP BY status` count map — the status-agnostic total. */
function sumCounts(byStatus: Record<string, number>): number {
  let total = 0
  for (const n of Object.values(byStatus)) total += n
  return total
}

/**
 * The live count of a workspace's running sessions: the union (de-duplicated by
 * session id) of non-idle runtimes and automation sessions with a running
 * execution log. A session backed by BOTH surfaces counts once.
 */
function runningSessionCount(workspacePath: string): number {
  const ids = new Set(runningRuntimeSessionIdsForWorkspace(workspacePath))
  for (const id of runningAutomationSessionIdsForWorkspace(workspacePath)) ids.add(id)
  return ids.size
}

/** Aggregate one workspace's Dashboard row. Throws if its path cannot be resolved. */
function dashboardRow(ws: WorkspaceInfo): WorkspaceDashboardRow {
  const path = resolveWorkspaceRoot(ws.id)
  if (!path) throw new Error(`workspace path unresolved for ${ws.id}`)
  return {
    workspaceId: ws.id,
    name: ws.name,
    path: ws.path,
    sessions: {
      running: runningSessionCount(path),
      total: countBoundSessions(path),
    },
    intents: { total: sumCounts(countIntentsByStatus(path)) },
    discussions: { total: sumCounts(countDiscussionsByStatus(path)) },
    automations: { total: countAutomationsInRange(path).total },
    automationEnabled: getAutomationEnabled(path),
  }
}

/**
 * Build the full Dashboard snapshot. Throws when the db is unavailable or any
 * single workspace fails to aggregate — the caller turns that into a structured
 * `dashboard.loadFailed` reply rather than a run of misleading all-zero rows.
 */
function buildDashboard(): WorkspaceDashboardRow[] {
  if (!getDb()) throw new Error('db unavailable')
  return listWorkspaces().map(dashboardRow)
}

export const getWorkspaceDashboardHandler: Handler<'get_workspace_dashboard'> = (_ctx, conn) => {
  try {
    conn.send({ type: 'workspace_dashboard', rows: buildDashboard() })
  } catch (err) {
    console.error('[c3:workcenter] dashboard aggregation failed:', err)
    conn.send({ type: 'workspace_dashboard', rows: [], error: { code: 'dashboard.loadFailed' } })
  }
}

export const setWorkspacesAutomationEnabledHandler: Handler<'set_workspaces_automation_enabled'> = (
  _ctx,
  conn,
  msg,
) => {
  // Single admin gate for the whole batch, BEFORE any write: a non-admin never
  // mutates any workspace (requireAdmin sends the `auth.adminOnly` error frame).
  if (!requireAdmin(conn)) return
  // De-dupe ids; an empty list is a no-op (never "all workspaces").
  const ids = [...new Set(msg.workspaceIds)]
  const results: WorkspaceAutomationGateResult[] = []
  for (const id of ids) {
    const path = resolveWorkspaceRoot(id)
    if (!path) {
      results.push({ workspaceId: id, ok: false, error: { code: 'dashboard.workspaceMissing' } })
      continue
    }
    try {
      // Read the LATEST full setting at execution time and replace only the gate,
      // so no other workspace-setting field (agents, discussion, MCP, …) is clobbered.
      const current = loadWorkspaceSetting(path)
      saveWorkspaceSetting(path, { ...current, automationEnabled: msg.enabled })
      results.push({ workspaceId: id, ok: true })
    } catch (err) {
      console.error(`[c3:workcenter] automation gate save failed for ${id}:`, err)
      results.push({ workspaceId: id, ok: false, error: { code: 'dashboard.gateSaveFailed' } })
    }
  }
  // Calibrate the client with the post-operation snapshot; if that fails the
  // settled per-item results still stand and the client re-requests a snapshot.
  let dashboard: WorkspaceDashboardRow[] = []
  let dashboardError: UiError | undefined
  try {
    dashboard = buildDashboard()
  } catch (err) {
    console.error('[c3:workcenter] post-gate dashboard snapshot failed:', err)
    dashboardError = { code: 'dashboard.loadFailed' }
  }
  conn.send({
    type: 'workspaces_automation_result',
    results,
    dashboard,
    ...(dashboardError ? { dashboardError } : {}),
  })
}
