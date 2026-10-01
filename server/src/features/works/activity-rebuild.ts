/**
 * Rebuild the activity registry from Session Runtime and in-flight automation
 * execution sessions. The registry is not a second source of truth: this walk
 * is the recovery path when the process starts, the table is empty, or a
 * caller wants to prove the incremental writes still match the fact sources.
 */
import { randomUUID } from 'node:crypto'
import type { ActivityFact, ActivityOwner } from '../../kernel/activity/index.js'
import {
  activityRegistry,
  mapSessionStatusToActivityState,
  resolveActivityWorkspaceName,
} from '../../kernel/activity/index.js'
import { listAllNonIdleRuntimes } from '../../runs.js'
import { listWorkspaces, pathToName } from '../../state.js'
import {
  runningAutomationIdsForWorkspace,
  runningAutomationSessionIdsForWorkspace,
} from '../automations/store.js'
import { getBoundByVendorSessionId, getByC3Id } from '../sessions/session-metadata-store.js'

export function lookupActivityOwner(sessionId: string): ActivityOwner | undefined {
  const row = getBoundByVendorSessionId(sessionId) ?? getByC3Id(sessionId)
  if (!row?.ownerKind || !row.ownerId) return undefined
  // Automation owners come from displayable running executions, not from a
  // session merely being owned by an automation.
  if (row.ownerKind === 'automation') return undefined
  return { kind: row.ownerKind, id: row.ownerId }
}

function lookupDisplayableAutomationOwner(
  sessionId: string,
  workspacePath: string,
): ActivityOwner | undefined {
  const row = getBoundByVendorSessionId(sessionId) ?? getByC3Id(sessionId)
  if (row?.ownerKind !== 'automation' || !row.ownerId) return undefined
  if (!runningAutomationIdsForWorkspace(workspacePath).includes(row.ownerId)) return undefined
  return { kind: 'automation', id: row.ownerId }
}

function ownerForRebuild(sessionId: string, workspacePath: string): ActivityOwner | undefined {
  return (
    lookupActivityOwner(sessionId) ?? lookupDisplayableAutomationOwner(sessionId, workspacePath)
  )
}

export function rebuildActivityRegistry(now: number = Date.now()): ActivityFact[] {
  const facts: ActivityFact[] = []
  const seen = new Set<string>()

  for (const rt of listAllNonIdleRuntimes()) {
    const state = mapSessionStatusToActivityState(rt.status)
    if (state === 'idle') continue
    seen.add(rt.sessionId)
    facts.push({
      activityId: rt.sessionId,
      generation: randomUUID(),
      sequence: 1,
      sessionId: rt.sessionId,
      workspaceName: pathToName(rt.workspacePath) ?? resolveActivityWorkspaceName(rt.workspacePath),
      sessionKind: rt.sessionKind,
      owner: ownerForRebuild(rt.sessionId, rt.workspacePath),
      state,
      updatedAt: now,
    })
  }

  for (const workspace of listWorkspaces()) {
    for (const sessionId of runningAutomationSessionIdsForWorkspace(workspace.path)) {
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      facts.push({
        activityId: sessionId,
        generation: randomUUID(),
        sequence: 1,
        sessionId,
        workspaceName: workspace.name,
        sessionKind: 'automation',
        owner: ownerForRebuild(sessionId, workspace.path),
        state: 'running',
        updatedAt: now,
      })
    }
  }

  activityRegistry.replaceAll(facts)
  return activityRegistry.snapshot()
}
