/**
 * Workspace registration, settings, MCP config and rollup wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type { UiError } from '../ui-codes.js'
import type {
  SysExtraMount,
  TimeRangeProjectStats,
  WorkspaceAutomationGateResult,
  WorkspaceDashboardRow,
  WorkspaceInfo,
  WorkspaceMcpConfig,
  WorkspaceSetting,
} from './workspace.js'

/** Register a project directory as a workspace. */
export type ClientAddWorkspace = { type: 'add_workspace'; workspaceName: string; path: string }

/**
 * Remove a workspace from the sidebar (does not delete its sessions on disk).
 * Carries the immutable workspace name — the client never supplies a path as identity.
 */
export type ClientRemoveWorkspace = { type: 'remove_workspace'; workspaceName: string }

/** Load a workspace's setting (reply: `workspace_setting`). */
export type ClientLoadWorkspaceSetting = { type: 'load_workspace_setting'; workspaceName: string }

/** Save a workspace's setting. */
export type ClientSaveWorkspaceSetting = {
  type: 'save_workspace_setting'
  workspaceName: string
  config: WorkspaceSetting
}

/** Get workspace-level MCP server configuration. */
export type ClientGetWorkspaceMcpConfig = {
  type: 'get_workspace_mcp_config'
  workspaceName: string
}

/** Save workspace-level MCP server configuration. */
export type ClientSaveWorkspaceMcpConfig = {
  type: 'save_workspace_mcp_config'
  workspaceName: string
  config: WorkspaceMcpConfig
}

/**
 * WorkCenter cross-project rollup: aggregate per-project counts (work sessions /
 * intents / discussions / automations) across **all** registered workspaces in one
 * round-trip. Replies with {@link timerange_stats}. `startTime`/`endTime`
 * (ms since epoch) are optional; absent ⇒ no time filter (count everything).
 * The range filters intents/discussions/automations by `updated_at` and sessions
 * by `last_modified`; the `running` counts are a live "now" notion and ignore it.
 */
export type ClientGetTimerangeStats = {
  type: 'get_timerange_stats'
  startTime?: number
  endTime?: number
}

/**
 * Workcenter Dashboard snapshot: one live, time-range-independent aggregation
 * per **all** registered workspaces in a single round-trip. Replies with
 * {@link workspace_dashboard}. Available to any authenticated connection.
 * Unlike `get_timerange_stats`, `sessions.total` counts every `SessionKind`
 * and no time filter applies. A domain db being unavailable or a single
 * workspace failing to aggregate yields a structured error, never a misleading
 * all-zero row.
 */
export type ClientGetWorkspaceDashboard = { type: 'get_workspace_dashboard' }

/**
 * Bulk-set the workspace-level automation master gate for a set of workspaces
 * to a single boolean. Admin-only (rejected wholesale before any write for a
 * non-admin connection). `workspaceNames` is de-duplicated server-side; an empty
 * list is a no-op (never interpreted as "all workspaces"). The batch is NOT
 * transactional — each workspace settles independently and the server reads the
 * latest full {@link WorkspaceSetting} per item, replacing only `automationEnabled`
 * so no other config field is clobbered. Replies with
 * {@link workspaces_automation_result}: a per-workspace outcome list plus the
 * post-operation Dashboard snapshot.
 */
export type ClientSetWorkspacesAutomationEnabled = {
  type: 'set_workspaces_automation_enabled'
  workspaceNames: string[]
  enabled: boolean
}

/** Full workspace list, sorted by recent access (desc). */
export type ServerWorkspaces = { type: 'workspaces'; workspaces: WorkspaceInfo[] }

/**
 * The normalized workspace setting (reply to `load_workspace_setting` or
 * `save_workspace_setting`). `detectedMainBranch` is the server-probed default
 * branch (origin/HEAD → current HEAD; undefined when unresolvable) the form
 * uses to pre-fill `defaultMainBranch` — present on the `load` reply only.
 *
 * `resolvedSpecRoot` is the FIXED, centralized SDD spec root for the workspace
 * (`~/.c3/specs/<project-path-segment>`), resolved server-side from the owning
 * workspace path. It is READ-ONLY display data: the form shows it but cannot
 * edit it, and `save_workspace_setting` never accepts a spec directory value.
 *
 * `sysExtraMounts` is the workspace-scoped built-in sandbox allow set (project
 * directory ro, specs root rw) from the single source `sysExtraMounts(workspace)`
 * — READ-ONLY display data shown alongside the editable `extraMounts`.
 */
export type ServerWorkspaceSetting = {
  type: 'workspace_setting'
  workspaceName: string
  config: WorkspaceSetting
  detectedMainBranch?: string
  resolvedSpecRoot?: string
  sysExtraMounts?: SysExtraMount[]
}

/** Workspace-level MCP server configuration (reply to `get_workspace_mcp_config`). */
export type ServerWorkspaceMcpConfig = {
  type: 'workspace_mcp_config'
  workspaceName: string
  config: WorkspaceMcpConfig
}

/** WorkCenter cross-project rollup (reply to `get_timerange_stats`). One entry per workspace. */
export type ServerTimerangeStats = { type: 'timerange_stats'; stats: TimeRangeProjectStats[] }

/**
 * Reply to {@link get_workspace_dashboard}. On success `rows` is the full
 * snapshot (one {@link WorkspaceDashboardRow} per registered workspace, in
 * `listWorkspaces()` order; empty registry ⇒ empty array) and `error` is
 * absent. On failure (a domain db unavailable / a single workspace aggregation
 * threw) `rows` is empty and `error` carries a structured {@link UiError} — the
 * client keeps its previous snapshot and shows a refresh-failed state rather
 * than deleting live rows.
 */
export type ServerWorkspaceDashboard = {
  type: 'workspace_dashboard'
  rows: WorkspaceDashboardRow[]
  error?: UiError
}

/**
 * Reply to {@link set_workspaces_automation_enabled}. `results` is the
 * per-workspace outcome list (settled independently, so a mix of success and
 * failure is expected); `dashboard` is the post-operation snapshot used to
 * calibrate the client, with `dashboardError` set when that snapshot itself
 * could not be built (the client still shows the settled per-item results and
 * re-requests a snapshot).
 */
export type ServerWorkspacesAutomationResult = {
  type: 'workspaces_automation_result'
  results: WorkspaceAutomationGateResult[]
  dashboard: WorkspaceDashboardRow[]
  dashboardError?: UiError
}
