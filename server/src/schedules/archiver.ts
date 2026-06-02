/**
 * Workspace archiver for schedules.
 *
 * When a workspace is removed from the registry, all its schedules are paused
 * and any in-flight executions are cancelled. Schedules remain visible in the
 * UI as `paused` so the user can reactivate them if the workspace is re-added.
 *
 * Usage:
 *   import { onWorkspaceRemoved } from './schedules/archiver.js'
 *   onWorkspaceRemoved(absPath)
 */

import { pauseAllForWorkspace } from './store.js'
import { cancelAllForWorkspace } from './scheduler.js'

/**
 * Handle workspace removal: pause all schedules and cancel in-flight executions.
 *
 * Called from the `remove_workspace` WS handler in server.ts.
 * The caller is responsible for broadcasting the updated schedule list.
 */
export function onWorkspaceRemoved(workspacePath: string): void {
  console.log('[archiver] pausing schedules for workspace: %s', workspacePath)

  try {
    // 1. Cancel any in-flight executions under this workspace
    cancelAllForWorkspace(workspacePath)
  } catch (err) {
    console.error('[archiver] failed to cancel in-flight executions:', err)
  }

  try {
    // 2. Pause all schedules in this workspace
    pauseAllForWorkspace(workspacePath)
    console.log('[archiver] paused all schedules for workspace: %s', workspacePath)
  } catch (err) {
    console.error('[archiver] failed to pause schedules:', err)
  }
}
