import { describe, expect, it } from 'vitest'
import { emptyWorkspaceActivitySummary, type WorkspaceActivitySummary } from '@ccc/shared/protocol'
import { applyActivityDelta, applyActivitySnapshot, projectActivityBadges } from './activity-apply'

function summary(running: number): WorkspaceActivitySummary {
  return {
    ...emptyWorkspaceActivitySummary(),
    runningSessions: running,
    runningSessionsByKind: running > 0 ? { work: running } : {},
  }
}

describe('applyActivitySnapshot', () => {
  it('replaces the whole map', () => {
    const store = applyActivitySnapshot({
      revision: 4,
      workspaces: { 'ws-a': summary(2), 'ws-b': summary(0) },
    })
    expect(store.revision).toBe(4)
    expect(store.workspaces['ws-a']?.runningSessions).toBe(2)
    expect(store.workspaces['ws-b']?.runningSessions).toBe(0)
  })
})

describe('applyActivityDelta', () => {
  it('applies a consecutive revision', () => {
    const current = applyActivitySnapshot({
      revision: 1,
      workspaces: { 'ws-a': summary(1) },
    })
    const result = applyActivityDelta(current, {
      revision: 2,
      changedWorkspaces: { 'ws-b': summary(3) },
    })
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.store.revision).toBe(2)
    expect(result.store.workspaces['ws-a']?.runningSessions).toBe(1)
    expect(result.store.workspaces['ws-b']?.runningSessions).toBe(3)
  })

  it('treats a jump from an existing revision as a gap', () => {
    const current = applyActivitySnapshot({ revision: 1, workspaces: {} })
    expect(applyActivityDelta(current, { revision: 3, changedWorkspaces: {} }).status).toBe('gap')
  })

  it('treats a delta before any snapshot as a gap', () => {
    expect(
      applyActivityDelta(
        { revision: 0, workspaces: {} },
        { revision: 1, changedWorkspaces: { 'ws-a': summary(1) } },
      ).status,
    ).toBe('gap')
  })

  it('ignores a stale or duplicate revision', () => {
    const current = applyActivitySnapshot({ revision: 5, workspaces: {} })
    expect(applyActivityDelta(current, { revision: 5, changedWorkspaces: {} }).status).toBe('stale')
    expect(applyActivityDelta(current, { revision: 4, changedWorkspaces: {} }).status).toBe('stale')
  })

  it('drops removed workspaces', () => {
    const current = applyActivitySnapshot({
      revision: 2,
      workspaces: { 'ws-a': summary(1), 'ws-b': summary(2) },
    })
    const result = applyActivityDelta(current, {
      revision: 3,
      changedWorkspaces: {},
      removedWorkspaces: ['ws-a'],
    })
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.store.workspaces).not.toHaveProperty('ws-a')
    expect(result.store.workspaces['ws-b']?.runningSessions).toBe(2)
  })
})

describe('projectActivityBadges', () => {
  it('maps every workspace onto rail, todo, and delivery counts', () => {
    const a: WorkspaceActivitySummary = {
      runningSessions: 2,
      runningSessionsByKind: { work: 1, intent: 1 },
      activeOwners: { intents: 1, discussions: 0, automations: 0 },
      attention: { awaitingPermission: 0, pendingUserTasks: 4, actionableDeliveries: 3 },
    }
    const projected = projectActivityBadges(
      { revision: 1, workspaces: { 'ws-a': a, 'ws-b': summary(5) } },
      'ws-a',
      false,
    )
    expect(projected.workspaceRunningSessionCounts).toEqual({ 'ws-a': 2, 'ws-b': 5 })
    expect(projected.workcenterTodoCounts['ws-a']).toBe(4)
    expect(projected.deliveriesNeedsAction['ws-a']).toBe(3)
    expect(projected.ownerRunningCounts.intent).toBe(1)
    expect(projected.sessionCounts.work).toBe(1)
    expect(projected.sessionCounts.intent).toBe(1)
  })
})
