/**
 * Filter a projection snapshot or delta down to the workspaces a connection
 * may see. Authorization is applied here so the wire never carries names the
 * client is not allowed to know.
 */
import type { WorkspaceActivitySummary } from '@ccc/shared/protocol'
import { BadgeProjection } from './badge-projection.js'
import type { BadgeProjectionDelta } from './types.js'

export function activitySnapshotForVisible(
  projection: BadgeProjection,
  visibleNames: readonly string[],
): { revision: number; workspaces: Record<string, WorkspaceActivitySummary> } {
  const workspaces: Record<string, WorkspaceActivitySummary> = {}
  for (const name of visibleNames) {
    workspaces[name] = projection.summaryFor(name)
  }
  return { revision: projection.getRevision(), workspaces }
}

export function activityDeltaForVisible(
  delta: BadgeProjectionDelta,
  visibleNames: ReadonlySet<string>,
  previouslySent: ReadonlySet<string>,
): {
  changedWorkspaces: Record<string, WorkspaceActivitySummary>
  removedWorkspaces: string[]
} {
  const changedWorkspaces: Record<string, WorkspaceActivitySummary> = {}
  for (const [name, summary] of Object.entries(delta.changedWorkspaces)) {
    if (visibleNames.has(name)) changedWorkspaces[name] = summary
  }
  const removed = new Set<string>()
  for (const name of delta.removedWorkspaces) {
    if (previouslySent.has(name)) removed.add(name)
  }
  for (const name of previouslySent) {
    if (!visibleNames.has(name)) removed.add(name)
  }
  for (const name of removed) delete changedWorkspaces[name]
  return { changedWorkspaces, removedWorkspaces: [...removed] }
}
