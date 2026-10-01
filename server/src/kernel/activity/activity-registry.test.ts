import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityRegistry } from './activity-registry.js'
import { mapSessionStatusToActivityState } from './session-status.js'
import type { ActivityStartInput } from './types.js'

function registry(now = 1_000): { r: ActivityRegistry; tick: (ms?: number) => number } {
  let t = now
  const r = new ActivityRegistry({
    now: () => t,
    generation: () => `g-${t}`,
  })
  return {
    r,
    tick: (ms = 1): number => {
      t += ms
      return t
    },
  }
}

function startInput(overrides: Partial<ActivityStartInput> = {}): ActivityStartInput {
  return {
    activityId: 'pending:1',
    sessionId: 'pending:1',
    workspaceName: 'proj',
    sessionKind: 'work',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mapSessionStatusToActivityState', () => {
  it('maps runtime statuses onto the activity vocabulary', () => {
    expect(mapSessionStatusToActivityState('idle')).toBe('idle')
    expect(mapSessionStatusToActivityState('running')).toBe('running')
    expect(mapSessionStatusToActivityState('reconnecting')).toBe('running')
    expect(mapSessionStatusToActivityState('awaiting_permission')).toBe('awaiting_user')
    expect(mapSessionStatusToActivityState('team')).toBe('parked')
  })
})

describe('ActivityRegistry', () => {
  it('starts a running fact at sequence 1', () => {
    const { r } = registry()
    const result = r.start(startInput({ generation: 'gen-a' }))
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.fact).toMatchObject({
      activityId: 'pending:1',
      sessionId: 'pending:1',
      generation: 'gen-a',
      sequence: 1,
      state: 'running',
      workspaceName: 'proj',
      sessionKind: 'work',
    })
    expect(r.snapshot()).toHaveLength(1)
  })

  it('treats a second start of the same live activity as idempotent', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    const again = r.start(startInput({ generation: 'gen-a' }))
    expect(again.accepted).toBe(true)
    if (!again.accepted) return
    expect(again.fact.sequence).toBe(1)
    expect(r.snapshot()).toHaveLength(1)
  })

  it('fills a missing owner on an idempotent start', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    const withOwner = r.start(
      startInput({ generation: 'gen-a', owner: { kind: 'intent', id: 'i-1' } }),
    )
    expect(withOwner.accepted).toBe(true)
    if (!withOwner.accepted) return
    expect(withOwner.fact.owner).toEqual({ kind: 'intent', id: 'i-1' })
    expect(withOwner.fact.sequence).toBe(2)
  })

  it('rejects a start that carries a different generation while live', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    const late = r.start(startInput({ generation: 'gen-old' }))
    expect(late).toEqual({ accepted: false, reason: 'stale_generation' })
    expect(r.snapshot()).toHaveLength(1)
  })

  it('walks the status matrix without dropping the member', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    expect(r.transition('pending:1', 'awaiting_user').accepted).toBe(true)
    expect(r.getBySessionId('pending:1')?.state).toBe('awaiting_user')
    expect(r.transition('pending:1', 'running').accepted).toBe(true)
    expect(r.transition('pending:1', 'parked').accepted).toBe(true)
    expect(r.transition('pending:1', 'paused').accepted).toBe(true)
    expect(r.snapshotRunning()).toHaveLength(0)
    expect(r.snapshot()).toHaveLength(1)
    expect(r.transition('pending:1', 'running').accepted).toBe(true)
    expect(r.snapshotRunning()).toHaveLength(1)
  })

  it('rejects a transition with a smaller or equal sequence', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    r.transition('pending:1', 'awaiting_user')
    const late = r.transition('pending:1', 'running', { generation: 'gen-a', sequence: 1 })
    expect(late).toEqual({ accepted: false, reason: 'stale_sequence' })
    expect(r.getBySessionId('pending:1')?.state).toBe('awaiting_user')
  })

  it('rejects a transition from a previous generation', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    const late = r.transition('pending:1', 'parked', { generation: 'gen-old', sequence: 99 })
    expect(late).toEqual({ accepted: false, reason: 'stale_generation' })
    expect(r.getBySessionId('pending:1')?.state).toBe('running')
  })

  it('migrates pending to the real session id without duplicating', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    const bound = r.bind('pending:1', 'real-1')
    expect(bound.accepted).toBe(true)
    if (!bound.accepted) return
    expect(bound.fact.activityId).toBe('real-1')
    expect(bound.fact.sessionId).toBe('real-1')
    expect(bound.fact.sequence).toBe(2)
    expect(r.snapshot()).toHaveLength(1)
    expect(r.getBySessionId('pending:1')?.sessionId).toBe('real-1')
    expect(r.getBySessionId('real-1')?.sessionId).toBe('real-1')
    const again = r.bind('pending:1', 'real-1')
    expect(again.accepted).toBe(true)
    expect(r.snapshot()).toHaveLength(1)
  })

  it('drops the pending fact when the real id already has one', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    r.start(
      startInput({
        activityId: 'real-1',
        sessionId: 'real-1',
        generation: 'gen-b',
      }),
    )
    expect(r.snapshot()).toHaveLength(2)
    const bound = r.bind('pending:1', 'real-1')
    expect(bound.accepted).toBe(true)
    expect(r.snapshot()).toHaveLength(1)
    expect(r.getBySessionId('real-1')?.generation).toBe('gen-b')
    expect(r.getBySessionId('pending:1')?.sessionId).toBe('real-1')
  })

  it('settle removes the fact; a later settle is already settled', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    const settled = r.settle('pending:1')
    expect(settled.accepted).toBe(true)
    if (!settled.accepted) return
    expect(settled.fact.state).toBe('idle')
    expect(r.snapshot()).toHaveLength(0)
    expect(r.settle('pending:1')).toEqual({ accepted: false, reason: 'settled' })
  })

  it('settle wins over a later expire of the same generation', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    r.settle('pending:1', { generation: 'gen-a' })
    expect(r.expire('pending:1', { generation: 'gen-a', sequence: 99 })).toEqual({
      accepted: false,
      reason: 'unknown_activity',
    })
    expect(r.snapshot()).toHaveLength(0)
  })

  it('expire turns running into stale and drops it from the running snapshot', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    const expired = r.expire('pending:1')
    expect(expired.accepted).toBe(true)
    if (!expired.accepted) return
    expect(expired.fact.state).toBe('stale')
    expect(r.snapshotRunning()).toHaveLength(0)
    expect(r.snapshot()).toHaveLength(1)
  })

  it('does not expire awaiting_user or parked by ordinary lease', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    r.transition('pending:1', 'awaiting_user')
    expect(r.expire('pending:1').accepted).toBe(true)
    expect(r.getBySessionId('pending:1')?.state).toBe('awaiting_user')
    r.transition('pending:1', 'parked')
    expect(r.expire('pending:1').accepted).toBe(true)
    expect(r.getBySessionId('pending:1')?.state).toBe('parked')
  })

  it('rejects a late renew from an old generation', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    const late = r.renew('pending:1', 9_000, { generation: 'gen-old', sequence: 2 })
    expect(late).toEqual({ accepted: false, reason: 'stale_generation' })
    expect(r.getBySessionId('pending:1')?.leaseUntil).toBeUndefined()
  })

  it('renews lease on the current generation', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    const renewed = r.renew('pending:1', 5_000, { generation: 'gen-a' })
    expect(renewed.accepted).toBe(true)
    if (!renewed.accepted) return
    expect(renewed.fact.leaseUntil).toBe(5_000)
    expect(renewed.fact.lastRenewedAt).toBe(1_000)
    expect(renewed.fact.sequence).toBe(2)
  })

  it('records lastRenewedAt when start carries a lease', () => {
    const { r } = registry()
    const started = r.start(startInput({ generation: 'gen-a', leaseUntil: 9_000 }))
    expect(started.accepted).toBe(true)
    if (!started.accepted) return
    expect(started.fact.leaseUntil).toBe(9_000)
    expect(started.fact.lastRenewedAt).toBe(1_000)
  })

  it('restores a stale fact to running on a current-generation renew', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a', leaseUntil: 2_000 }))
    r.expire('pending:1')
    expect(r.getBySessionId('pending:1')?.state).toBe('stale')
    const restored = r.renew('pending:1', 8_000, { generation: 'gen-a' })
    expect(restored.accepted).toBe(true)
    if (!restored.accepted) return
    expect(restored.fact.state).toBe('running')
    expect(restored.fact.leaseUntil).toBe(8_000)
    expect(r.snapshotRunning()).toHaveLength(1)
  })

  it('expireDue stales running facts whose lease has been reached', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(
      startInput({ activityId: 'due', sessionId: 'due', generation: 'gen-a', leaseUntil: 1_000 }),
    )
    r.start(
      startInput({
        activityId: 'fresh',
        sessionId: 'fresh',
        generation: 'gen-b',
        leaseUntil: 2_000,
      }),
    )
    r.start(startInput({ activityId: 'wait', sessionId: 'wait', generation: 'gen-c' }))
    r.transition('wait', 'awaiting_user')
    expect(r.expireDue(1_000)).toEqual(['due'])
    expect(r.getBySessionId('due')?.state).toBe('stale')
    expect(r.getBySessionId('fresh')?.state).toBe('running')
    expect(r.getBySessionId('wait')?.state).toBe('awaiting_user')
    expect(
      r
        .snapshotRunning()
        .map((f) => f.sessionId)
        .sort(),
    ).toEqual(['fresh', 'wait'])
  })

  it('starts a new generation after stale rather than keeping the dead run', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    r.expire('pending:1')
    const next = r.start(startInput({ generation: 'gen-b' }))
    expect(next.accepted).toBe(true)
    if (!next.accepted) return
    expect(next.fact.generation).toBe('gen-b')
    expect(next.fact.sequence).toBe(1)
    expect(next.fact.state).toBe('running')
    expect(r.snapshot()).toHaveLength(1)
  })

  it('rejects a late start of the old generation after a new one replaced stale', () => {
    const { r } = registry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    r.start(startInput({ generation: 'gen-a' }))
    r.expire('pending:1')
    r.start(startInput({ generation: 'gen-b' }))
    expect(r.start(startInput({ generation: 'gen-a' }))).toEqual({
      accepted: false,
      reason: 'stale_generation',
    })
  })

  it('remove deletes the fact; snapshot is a clone', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a', owner: { kind: 'intent', id: 'i-1' } }))
    const snap = r.snapshot()
    snap[0]!.state = 'paused'
    snap[0]!.owner!.id = 'mutated'
    expect(r.getBySessionId('pending:1')?.state).toBe('running')
    expect(r.getBySessionId('pending:1')?.owner?.id).toBe('i-1')
    expect(r.remove('pending:1')).toBe(true)
    expect(r.remove('pending:1')).toBe(false)
    expect(r.snapshot()).toEqual([])
  })

  it('removeByWorkspace clears every member of that workspace', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    r.start(
      startInput({
        activityId: 's-2',
        sessionId: 's-2',
        workspaceName: 'other',
        generation: 'gen-b',
      }),
    )
    r.removeByWorkspace('proj')
    expect(r.snapshot().map((f) => f.sessionId)).toEqual(['s-2'])
  })

  it('replaceAll rebuilds from a fact list', () => {
    const { r } = registry()
    r.start(startInput({ generation: 'gen-a' }))
    r.replaceAll([
      {
        activityId: 'real-9',
        generation: 'g',
        sequence: 4,
        sessionId: 'real-9',
        workspaceName: 'proj',
        sessionKind: 'automation',
        state: 'running',
        updatedAt: 42,
      },
    ])
    expect(r.snapshot()).toEqual([
      {
        activityId: 'real-9',
        generation: 'g',
        sequence: 4,
        sessionId: 'real-9',
        workspaceName: 'proj',
        sessionKind: 'automation',
        state: 'running',
        updatedAt: 42,
      },
    ])
  })
})
