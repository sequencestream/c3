import { describe, expect, it } from 'vitest'
import { ActivityRegistry } from './activity-registry.js'
import { BadgeProjection } from './badge-projection.js'
import { activityDeltaForVisible, activitySnapshotForVisible } from './visibility.js'
import type { ActivityStartInput } from './types.js'

function startInput(overrides: Partial<ActivityStartInput> = {}): ActivityStartInput {
  return {
    activityId: 's-1',
    sessionId: 's-1',
    workspaceName: 'alpha',
    sessionKind: 'work',
    generation: 'g-a',
    ...overrides,
  }
}

describe('activitySnapshotForVisible', () => {
  it('includes every visible workspace, including empty summaries', () => {
    const r = new ActivityRegistry({ now: () => 1, generation: () => 'g' })
    const p = new BadgeProjection()
    r.subscribe((m) => p.apply(m))
    r.start(startInput())
    const snap = activitySnapshotForVisible(p, ['alpha', 'beta'])
    expect(snap.revision).toBe(1)
    expect(snap.workspaces.alpha?.runningSessions).toBe(1)
    expect(snap.workspaces.beta?.runningSessions).toBe(0)
    expect(Object.keys(snap.workspaces)).toEqual(['alpha', 'beta'])
  })

  it('omits workspaces that are not in the visible list', () => {
    const r = new ActivityRegistry({ now: () => 1, generation: () => 'g' })
    const p = new BadgeProjection()
    r.subscribe((m) => p.apply(m))
    r.start(startInput())
    r.start(startInput({ activityId: 's-2', sessionId: 's-2', workspaceName: 'secret' }))
    const snap = activitySnapshotForVisible(p, ['alpha'])
    expect(snap.workspaces).not.toHaveProperty('secret')
    expect(Object.keys(snap.workspaces)).toEqual(['alpha'])
  })
})

describe('activityDeltaForVisible', () => {
  it('keeps only visible changed workspaces', () => {
    const filtered = activityDeltaForVisible(
      {
        revision: 2,
        changedWorkspaces: {
          alpha: {
            runningSessions: 1,
            runningSessionsByKind: { work: 1 },
            activeOwners: { intents: 0, discussions: 0, automations: 0 },
            attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
          },
          secret: {
            runningSessions: 3,
            runningSessionsByKind: { work: 3 },
            activeOwners: { intents: 0, discussions: 0, automations: 0 },
            attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
          },
        },
        removedWorkspaces: [],
      },
      new Set(['alpha']),
      new Set(['alpha']),
    )
    expect(Object.keys(filtered.changedWorkspaces)).toEqual(['alpha'])
    expect(filtered.removedWorkspaces).toEqual([])
  })

  it('removes a previously sent workspace that is no longer visible', () => {
    const filtered = activityDeltaForVisible(
      {
        revision: 3,
        changedWorkspaces: {},
        removedWorkspaces: [],
      },
      new Set(['alpha']),
      new Set(['alpha', 'secret']),
    )
    expect(filtered.removedWorkspaces).toEqual(['secret'])
  })

  it('includes a deleted workspace only when the connection had it', () => {
    const filtered = activityDeltaForVisible(
      {
        revision: 4,
        changedWorkspaces: {},
        removedWorkspaces: ['gone'],
      },
      new Set(['alpha']),
      new Set(['alpha']),
    )
    expect(filtered.removedWorkspaces).toEqual([])
    const hadIt = activityDeltaForVisible(
      {
        revision: 4,
        changedWorkspaces: {},
        removedWorkspaces: ['gone'],
      },
      new Set(['alpha']),
      new Set(['alpha', 'gone']),
    )
    expect(hadIt.removedWorkspaces).toEqual(['gone'])
  })
})
