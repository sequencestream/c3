import { describe, expect, it } from 'vitest'
import {
  DEV_LAUNCH_MIN_DWELL_MS,
  DEV_LAUNCH_SAFETY_TIMEOUT_MS,
  beginDevLaunch,
  isMinimumDwellComplete,
  isSafetyTimeoutDue,
  isTerminalPhase,
  reduceDevLaunch,
  stepStatusesForPhase,
  type DevLaunchModel,
} from './dev-launch-view'

describe('beginDevLaunch — immediate visibility', () => {
  it('creates an immediately visible model with its dwell origin at click time', () => {
    expect(beginDevLaunch('A', 1_000)).toMatchObject({
      intentId: 'A',
      phase: 'fetching-remote-main',
      startedAt: 1_000,
      visibleAt: 1_000,
      visible: true,
    })
  })
})

describe('stepStatusesForPhase — stage advances steps', () => {
  it('fetching-remote-main activates step 1, rest pending', () => {
    expect(stepStatusesForPhase('fetching-remote-main')).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
    ])
  })

  it('preparing-worktree completes step 1 and activates step 2', () => {
    expect(stepStatusesForPhase('preparing-worktree')).toEqual([
      'done',
      'active',
      'pending',
      'pending',
    ])
  })

  it('launching completes steps 1-2 and activates step 3', () => {
    expect(stepStatusesForPhase('launching')).toEqual(['done', 'done', 'active', 'pending'])
  })

  it('ready marks every step done', () => {
    expect(stepStatusesForPhase('ready')).toEqual(['done', 'done', 'done', 'done'])
  })

  it('reduceDevLaunch advances the phase on a matching stage', () => {
    const m = beginDevLaunch('A', 0)
    const next = reduceDevLaunch(m, { kind: 'stage', intentId: 'A', stage: 'launching', now: 1 })
    expect(next.model?.phase).toBe('launching')
    expect(stepStatusesForPhase(next.model!.phase)).toEqual(['done', 'done', 'active', 'pending'])
  })

  it('ignores a stage for a different intent', () => {
    const m = beginDevLaunch('A', 0)
    const next = reduceDevLaunch(m, { kind: 'stage', intentId: 'B', stage: 'launching', now: 1 })
    expect(next.model?.phase).toBe('fetching-remote-main')
    expect(next.closedReason).toBeUndefined()
  })
})

describe('reduceDevLaunch — minimum dwell terminal convergence', () => {
  const inFlight = (): DevLaunchModel => ({
    intentId: 'A',
    phase: 'launching',
    startedAt: 0,
    visibleAt: 0,
    visible: true,
  })

  it('defers ready inside the dwell window and closes silently at its end', () => {
    const early = reduceDevLaunch(inFlight(), { kind: 'ready', intentId: 'A', now: 1 })
    expect(early.model).toMatchObject({
      phase: 'ready',
      pendingCloseReason: 'ready',
      visible: true,
    })
    expect(early.closedReason).toBeUndefined()

    const laterProgress = reduceDevLaunch(early.model, {
      kind: 'stage',
      intentId: 'A',
      stage: 'launching',
      now: 2,
    })
    expect(laterProgress.model?.phase).toBe('ready')

    const beforeDwell = reduceDevLaunch(early.model, {
      kind: 'dwell-complete',
      now: DEV_LAUNCH_MIN_DWELL_MS - 1,
    })
    expect(beforeDwell.model).not.toBeNull()

    const closed = reduceDevLaunch(early.model, {
      kind: 'dwell-complete',
      now: DEV_LAUNCH_MIN_DWELL_MS,
    })
    expect(closed).toEqual({ model: null, closedReason: 'ready' })
  })

  it('defers failed inside the dwell window and closes with failure at its end', () => {
    const early = reduceDevLaunch(inFlight(), {
      kind: 'stage',
      intentId: 'A',
      stage: 'failed',
      now: 1,
    })
    expect(early.model).toMatchObject({
      phase: 'failed',
      pendingCloseReason: 'failed',
      visible: true,
    })
    expect(early.closedReason).toBeUndefined()

    const closed = reduceDevLaunch(early.model, {
      kind: 'dwell-complete',
      now: DEV_LAUNCH_MIN_DWELL_MS,
    })
    expect(closed).toEqual({ model: null, closedReason: 'failed' })
  })

  it('closes immediately when ready arrives after the dwell window', () => {
    const r = reduceDevLaunch(inFlight(), {
      kind: 'ready',
      intentId: 'A',
      now: DEV_LAUNCH_MIN_DWELL_MS,
    })
    expect(r).toEqual({ model: null, closedReason: 'ready' })
  })

  it('closes immediately when failed arrives after the dwell window', () => {
    const r = reduceDevLaunch(inFlight(), {
      kind: 'stage',
      intentId: 'A',
      stage: 'failed',
      now: DEV_LAUNCH_MIN_DWELL_MS,
    })
    expect(r).toEqual({ model: null, closedReason: 'failed' })
  })

  it('ready for a different intent does not close', () => {
    const r = reduceDevLaunch(inFlight(), { kind: 'ready', intentId: 'other', now: 1 })
    expect(r.model).not.toBeNull()
    expect(r.closedReason).toBeUndefined()
  })

  it('recognizes minimum dwell completion at the boundary', () => {
    expect(isMinimumDwellComplete(DEV_LAUNCH_MIN_DWELL_MS - 1)).toBe(false)
    expect(isMinimumDwellComplete(DEV_LAUNCH_MIN_DWELL_MS)).toBe(true)
  })

  it('isTerminalPhase recognizes ready / failed only', () => {
    expect(isTerminalPhase('ready')).toBe(true)
    expect(isTerminalPhase('failed')).toBe(true)
    expect(isTerminalPhase('fetching-remote-main')).toBe(false)
    expect(isTerminalPhase('preparing-worktree')).toBe(false)
    expect(isTerminalPhase('launching')).toBe(false)
  })
})

describe('reduceDevLaunch — safety timeout', () => {
  it('isSafetyTimeoutDue at the ceiling', () => {
    expect(isSafetyTimeoutDue(DEV_LAUNCH_SAFETY_TIMEOUT_MS - 1)).toBe(false)
    expect(isSafetyTimeoutDue(DEV_LAUNCH_SAFETY_TIMEOUT_MS)).toBe(true)
  })

  it('timeout before the ceiling keeps the overlay', () => {
    const m = beginDevLaunch('A', 0)
    const r = reduceDevLaunch(m, { kind: 'timeout', now: DEV_LAUNCH_SAFETY_TIMEOUT_MS - 1 })
    expect(r.model).not.toBeNull()
    expect(r.closedReason).toBeUndefined()
  })

  it('timeout at the ceiling closes immediately', () => {
    const m = beginDevLaunch('A', 0)
    const r = reduceDevLaunch(m, { kind: 'timeout', now: DEV_LAUNCH_SAFETY_TIMEOUT_MS })
    expect(r).toEqual({ model: null, closedReason: 'timeout' })
  })
})

describe('reduceDevLaunch — no model is a no-op', () => {
  it('returns null transition for any event when closed', () => {
    expect(reduceDevLaunch(null, { kind: 'ready', intentId: 'A', now: 0 })).toEqual({ model: null })
    expect(reduceDevLaunch(null, { kind: 'timeout', now: 0 })).toEqual({ model: null })
  })
})
