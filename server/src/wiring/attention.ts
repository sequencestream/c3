/**
 * Wire attention sources into the badge projection: wait-user todos, still-
 * answerable permissions, and delivery-domain actionable IDs.
 */
import { badgeProjection } from '../kernel/activity/index.js'
import {
  listPendingPermissions,
  setPendingPermissionsListener,
  type PendingPermissionEntry,
} from '../kernel/permission/index.js'
import { listWorkspaces } from '../state.js'
import { listTodoIdsByWorkspace } from '../features/user-involve/store.js'
import { syncDeliveryAttention } from '../features/deliveries/attention.js'

function permissionsByWorkspace(entries: readonly PendingPermissionEntry[]): Map<string, string[]> {
  const byWorkspace = new Map<string, string[]>()
  for (const entry of entries) {
    const ids = byWorkspace.get(entry.workspaceName)
    if (ids) ids.push(entry.requestId)
    else byWorkspace.set(entry.workspaceName, [entry.requestId])
  }
  return byWorkspace
}

function applyPermissionAttention(entries: readonly PendingPermissionEntry[]): void {
  badgeProjection.replaceAttentionKind('permission', permissionsByWorkspace(entries))
}

export function registerAttentionProjection(): void {
  setPendingPermissionsListener(applyPermissionAttention)
}

export function rebuildBadgeAttention(): void {
  badgeProjection.replaceAttentionKind('todo', listTodoIdsByWorkspace())
  applyPermissionAttention(listPendingPermissions())
  for (const workspace of listWorkspaces()) {
    syncDeliveryAttention(workspace.path)
  }
}
