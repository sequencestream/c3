/**
 * The single workspace-scoped query of currently active sessions.
 *
 * Activity is the union of non-idle Session Runtimes and automation sessions
 * that have a running execution log, de-duplicated by session id. Session-page
 * totals, workspace-rail counts, and the Workcenter Dashboard all read this
 * set so those surfaces cannot disagree. Kind is preserved so callers can still
 * bucket by SessionKind; a session present on both surfaces keeps the runtime's
 * kind and is counted once.
 */
import type { SessionKind } from '@ccc/shared/protocol'
import { listRunningRuntimesForWorkspace } from '../../runs.js'
import { runningAutomationSessionIdsForWorkspace } from '../automations/store.js'

export type ActiveSessionSource = 'runtime' | 'automation_log'

export interface ActiveWorkspaceSession {
  sessionId: string
  sessionKind: SessionKind
  source: ActiveSessionSource
}

export function listActiveSessionsForWorkspace(workspacePath: string): ActiveWorkspaceSession[] {
  const byId = new Map<string, ActiveWorkspaceSession>()
  for (const rt of listRunningRuntimesForWorkspace(workspacePath)) {
    byId.set(rt.sessionId, {
      sessionId: rt.sessionId,
      sessionKind: rt.sessionKind,
      source: 'runtime',
    })
  }
  for (const sessionId of runningAutomationSessionIdsForWorkspace(workspacePath)) {
    if (byId.has(sessionId)) continue
    byId.set(sessionId, {
      sessionId,
      sessionKind: 'automation',
      source: 'automation_log',
    })
  }
  return [...byId.values()]
}

export function countActiveSessionsForWorkspace(workspacePath: string): number {
  return listActiveSessionsForWorkspace(workspacePath).length
}
