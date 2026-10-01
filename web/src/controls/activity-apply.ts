/**
 * Apply activity snapshot / delta onto the client map, then project into the
 * badge refs the chrome already reads.
 */
import {
  emptyWorkspaceActivitySummary,
  sessionPageCountsFromSummary,
  type SessionOwnerKind,
  type WorkspaceActivitySummary,
} from '@ccc/shared/protocol'
import type { SessionPageKind } from './state/types'

export type ActivityStore = {
  revision: number
  workspaces: Record<string, WorkspaceActivitySummary>
}

export type ActivityApplyStatus = 'applied' | 'stale' | 'gap'

export function applyActivitySnapshot(msg: {
  revision: number
  workspaces: Record<string, WorkspaceActivitySummary>
}): ActivityStore {
  return { revision: msg.revision, workspaces: { ...msg.workspaces } }
}

export function applyActivityDelta(
  current: ActivityStore,
  msg: {
    revision: number
    changedWorkspaces: Record<string, WorkspaceActivitySummary>
    removedWorkspaces?: string[]
  },
): { status: 'applied'; store: ActivityStore } | { status: 'stale' } | { status: 'gap' } {
  if (msg.revision <= current.revision) return { status: 'stale' }
  if (current.revision > 0 && msg.revision !== current.revision + 1) return { status: 'gap' }
  if (current.revision === 0) return { status: 'gap' }
  const workspaces = { ...current.workspaces, ...msg.changedWorkspaces }
  for (const name of msg.removedWorkspaces ?? []) delete workspaces[name]
  return { status: 'applied', store: { revision: msg.revision, workspaces } }
}

export function projectActivityBadges(
  store: ActivityStore,
  currentWorkspace: string | null,
  showToolSessions: boolean,
): {
  sessionCounts: Record<SessionPageKind, number>
  ownerRunningCounts: Record<SessionOwnerKind, number>
  workspaceRunningSessionCounts: Record<string, number>
  workcenterTodoCounts: Record<string, number>
  deliveriesNeedsAction: Record<string, number>
} {
  const workspaceRunningSessionCounts: Record<string, number> = {}
  const workcenterTodoCounts: Record<string, number> = {}
  const deliveriesNeedsAction: Record<string, number> = {}
  for (const [name, summary] of Object.entries(store.workspaces)) {
    workspaceRunningSessionCounts[name] = summary.runningSessions
    workcenterTodoCounts[name] = summary.attention.pendingUserTasks
    deliveriesNeedsAction[name] = summary.attention.actionableDeliveries
  }
  const mapped = sessionPageCountsFromSummary(
    (currentWorkspace ? store.workspaces[currentWorkspace] : undefined) ??
      emptyWorkspaceActivitySummary(),
    showToolSessions,
  )
  return {
    sessionCounts: mapped.counts,
    ownerRunningCounts: mapped.ownerCounts,
    workspaceRunningSessionCounts,
    workcenterTodoCounts,
    deliveriesNeedsAction,
  }
}
