/**
 * Workspace archiver for automations.
 *
 * When a workspace is removed from the registry, all its automations are paused
 * and any in-flight executions are cancelled. Automations remain visible in the
 * UI as `paused` so the user can reactivate them if the workspace is re-added.
 *
 * Usage:
 *   import { onWorkspaceRemoved } from './automations/archiver.js'
 *   onWorkspaceRemoved(absPath)
 */

import { pauseAllForWorkspace } from './store.js'
import { cancelAllForWorkspace } from './engine.js'

/**
 * Handle workspace removal: pause all automations and cancel in-flight executions.
 *
 * Called from the `remove_workspace` WS handler in server.ts.
 * The caller is responsible for broadcasting the updated automation list.
 */
export function onWorkspaceRemoved(workspacePath: string): void {
  console.log('[archiver] pausing automations for workspace: %s', workspacePath)

  try {
    // 1. Cancel any in-flight executions under this workspace
    cancelAllForWorkspace(workspacePath)
  } catch (err) {
    console.error('[archiver] failed to cancel in-flight executions:', err)
  }

  try {
    // 2. Pause all automations in this workspace
    pauseAllForWorkspace(workspacePath)
    console.log('[archiver] paused all automations for workspace: %s', workspacePath)
  } catch (err) {
    console.error('[archiver] failed to pause automations:', err)
  }
}
