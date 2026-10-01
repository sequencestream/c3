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
  badgeProjection,
  mapSessionStatusToActivityState,
  resolveActivityWorkspaceName,
} from '../../kernel/activity/index.js'
import { listAllNonIdleRuntimes, reconcileLiveness } from '../../runs.js'
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

function factFromPrior(
  sessionId: string,
  workspaceName: string,
  sessionKind: ActivityFact['sessionKind'],
  state: ActivityFact['state'],
  owner: ActivityOwner | undefined,
  now: number,
  prior: ActivityFact | undefined,
): ActivityFact {
  return {
    activityId: prior?.activityId ?? sessionId,
    generation: prior?.generation ?? randomUUID(),
    sequence: prior?.sequence ?? 1,
    sessionId,
    workspaceName,
    sessionKind,
    owner,
    state,
    updatedAt: now,
    leaseUntil: prior?.leaseUntil,
  }
}

export function rebuildActivityRegistry(now: number = Date.now()): ActivityFact[] {
  const previous = new Map(activityRegistry.snapshot().map((fact) => [fact.sessionId, fact]))
  const facts: ActivityFact[] = []
  const seen = new Set<string>()

  for (const rt of listAllNonIdleRuntimes()) {
    const state = mapSessionStatusToActivityState(rt.status)
    if (state === 'idle') continue
    seen.add(rt.sessionId)
    facts.push(
      factFromPrior(
        rt.sessionId,
        pathToName(rt.workspacePath) ?? resolveActivityWorkspaceName(rt.workspacePath),
        rt.sessionKind,
        state,
        ownerForRebuild(rt.sessionId, rt.workspacePath),
        now,
        previous.get(rt.sessionId),
      ),
    )
  }

  for (const workspace of listWorkspaces()) {
    for (const sessionId of runningAutomationSessionIdsForWorkspace(workspace.path)) {
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      facts.push(
        factFromPrior(
          sessionId,
          workspace.name,
          'automation',
          'running',
          ownerForRebuild(sessionId, workspace.path),
          now,
          previous.get(sessionId),
        ),
      )
    }
  }

  activityRegistry.replaceAll(facts)
  return activityRegistry.snapshot()
}

export interface ActivityReconcileResult {
  reapedSessionIds: string[]
  projectionChanged: boolean
}

/**
 * Low-frequency recovery: reap hung runs, then rebuild the registry from the
 * remaining fact sources. Projection listeners fire only when a workspace
 * summary actually changes.
 */
export function reconcileActivityProjection(now: number, staleMs: number): ActivityReconcileResult {
  const revisionBefore = badgeProjection.getRevision()
  const reapedSessionIds = reconcileLiveness(now, staleMs)
  rebuildActivityRegistry(now)
  const revisionAfter = badgeProjection.getRevision()
  if (revisionAfter !== revisionBefore) {
    console.log(
      '[c3:activity] reconcile revision=%d→%d reaped=%d',
      revisionBefore,
      revisionAfter,
      reapedSessionIds.length,
    )
  }
  return {
    reapedSessionIds,
    projectionChanged: revisionAfter !== revisionBefore,
  }
}
