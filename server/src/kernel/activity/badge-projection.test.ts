import { describe, expect, it } from 'vitest'
import { ActivityRegistry } from './activity-registry.js'
import { BadgeProjection } from './badge-projection.js'
import type { ActivityFact, ActivityStartInput, WorkspaceActivitySummary } from './types.js'

function registry(now = 1_000): { r: ActivityRegistry; p: BadgeProjection } {
  const r = new ActivityRegistry({
    now: () => now,
    generation: () => `g-${now}`,
  })
  const p = new BadgeProjection()
  r.subscribe((m) => p.apply(m))
  return { r, p }
}

function startInput(overrides: Partial<ActivityStartInput> = {}): ActivityStartInput {
  return {
    activityId: 's-1',
    sessionId: 's-1',
    workspaceName: 'proj',
    sessionKind: 'work',
    ...overrides,
  }
}

function fact(overrides: Partial<ActivityFact> = {}): ActivityFact {
  return {
    activityId: 's-1',
    generation: 'g',
    sequence: 1,
    sessionId: 's-1',
    workspaceName: 'proj',
    sessionKind: 'work',
    state: 'running',
    updatedAt: 1,
    ...overrides,
  }
}

function expectSameSummary(a: WorkspaceActivitySummary, b: WorkspaceActivitySummary): void {
  expect(a).toEqual(b)
}

describe('BadgeProjection', () => {
  it('indexes workspace, kind, and owner from a running start', () => {
    const { r, p } = registry()
    r.start(
      startInput({
        generation: 'g-a',
        owner: { kind: 'intent', id: 'i-1' },
      }),
    )
    expect(p.summaryFor('proj')).toMatchObject({
      runningSessions: 1,
      runningSessionsByKind: { work: 1 },
      activeOwners: { intents: 1, discussions: 0, automations: 0 },
    })
    expect(p.getRevision()).toBe(1)
  })

  it('does not bump revision when membership is unchanged', () => {
    const { r, p } = registry()
    r.start(startInput({ generation: 'g-a' }))
    expect(p.getRevision()).toBe(1)
    r.transition('s-1', 'awaiting_user')
    r.transition('s-1', 'parked')
    r.renew('s-1', 9_000)
    expect(p.getRevision()).toBe(1)
    expect(p.summaryFor('proj').runningSessions).toBe(1)
  })

  it('drops running membership on pause, stale, and settle', () => {
    const { r, p } = registry()
    r.start(startInput({ generation: 'g-a' }))
    r.transition('s-1', 'paused')
    expect(p.summaryFor('proj').runningSessions).toBe(0)
    expect(p.getRevision()).toBe(2)

    r.transition('s-1', 'running')
    r.expire('s-1')
    expect(p.summaryFor('proj').runningSessions).toBe(0)

    r.start(startInput({ generation: 'g-b' }))
    r.settle('s-1')
    expect(p.snapshot().workspaces).toEqual({})
  })

  it('counts one owner for two sessions and updates on owner change', () => {
    const { r, p } = registry()
    r.start(
      startInput({
        generation: 'g-a',
        owner: { kind: 'intent', id: 'i-1' },
      }),
    )
    r.start(
      startInput({
        activityId: 's-2',
        sessionId: 's-2',
        sessionKind: 'spec',
        generation: 'g-b',
        owner: { kind: 'intent', id: 'i-1' },
      }),
    )
    expect(p.summaryFor('proj')).toMatchObject({
      runningSessions: 2,
      runningSessionsByKind: { work: 1, spec: 1 },
      activeOwners: { intents: 1, discussions: 0, automations: 0 },
    })
    r.setOwner('s-2', { kind: 'intent', id: 'i-2' })
    expect(p.summaryFor('proj').activeOwners.intents).toBe(2)
    r.setOwner('s-2', undefined)
    expect(p.summaryFor('proj').activeOwners.intents).toBe(1)
  })

  it('bind migrates the session id without double-counting', () => {
    const { r, p } = registry()
    r.start(startInput({ activityId: 'pending:1', sessionId: 'pending:1', generation: 'g-a' }))
    r.bind('pending:1', 'real-1')
    expect(p.summaryFor('proj').runningSessions).toBe(1)
    expect(p.getRevision()).toBe(1)
  })

  it('clears every index when a workspace is removed', () => {
    const { r, p } = registry()
    r.start(startInput({ generation: 'g-a', owner: { kind: 'intent', id: 'i-1' } }))
    r.start(
      startInput({
        activityId: 's-2',
        sessionId: 's-2',
        workspaceName: 'other',
        generation: 'g-b',
      }),
    )
    r.removeByWorkspace('proj')
    expect(p.snapshot().workspaces).toEqual({
      other: expect.objectContaining({ runningSessions: 1 }),
    })
    expect(p.summaryFor('proj').runningSessions).toBe(0)
    expect(p.summaryFor('proj').activeOwners.intents).toBe(0)
  })

  it('rebuild from facts matches the incremental summary', () => {
    const { r, p } = registry()
    r.start(
      startInput({
        generation: 'g-a',
        owner: { kind: 'discussion', id: 'd-1' },
        sessionKind: 'discussion',
      }),
    )
    r.start(
      startInput({
        activityId: 's-2',
        sessionId: 's-2',
        sessionKind: 'tool',
        generation: 'g-b',
        owner: { kind: 'intent', id: 'i-1' },
      }),
    )
    r.transition('s-1', 'awaiting_user')
    const rebuilt = new BadgeProjection()
    rebuilt.rebuild(r.snapshot())
    expectSameSummary(p.summaryFor('proj'), rebuilt.summaryFor('proj'))
    expect(p.snapshot().workspaces).toEqual(rebuilt.snapshot().workspaces)
  })

  it('full rebuild and any legal incremental sequence yield the same summary', () => {
    const ops: Array<(r: ActivityRegistry) => void> = [
      (r) => r.start(startInput({ generation: 'g1', owner: { kind: 'intent', id: 'i-1' } })),
      (r) =>
        r.start(
          startInput({
            activityId: 's-2',
            sessionId: 's-2',
            sessionKind: 'intent',
            generation: 'g2',
            owner: { kind: 'intent', id: 'i-1' },
          }),
        ),
      (r) =>
        r.start(
          startInput({
            activityId: 's-3',
            sessionId: 's-3',
            workspaceName: 'other',
            sessionKind: 'automation',
            generation: 'g3',
            owner: { kind: 'automation', id: 'a-1' },
          }),
        ),
      (r) => r.transition('s-1', 'awaiting_user'),
      (r) => r.transition('s-2', 'paused'),
      (r) => r.setOwner('s-1', { kind: 'intent', id: 'i-2' }),
      (r) => r.bind('s-3', 'real-3'),
      (r) => r.expire('s-2'),
      (r) => r.settle('s-1'),
      (r) => r.removeByWorkspace('other'),
      (r) =>
        r.start(
          startInput({
            activityId: 's-4',
            sessionId: 's-4',
            sessionKind: 'spec_review',
            generation: 'g4',
            owner: { kind: 'intent', id: 'i-2' },
          }),
        ),
      (r) => r.transition('s-4', 'parked'),
      (r) => r.remove('s-2'),
    ]

    for (let n = 1; n <= ops.length; n++) {
      const incremental = registry()
      for (let i = 0; i < n; i++) ops[i]!(incremental.r)
      const rebuilt = new BadgeProjection()
      rebuilt.rebuild(incremental.r.snapshot())
      expect(incremental.p.snapshot().workspaces).toEqual(rebuilt.snapshot().workspaces)
    }
  })

  it('rebuild of identical facts does not bump revision', () => {
    const p = new BadgeProjection()
    p.rebuild([fact()])
    const rev = p.getRevision()
    p.rebuild([fact()])
    expect(p.getRevision()).toBe(rev)
  })
})
