import { describe, it, expect } from 'vitest'
import {
  DEV_LAUNCH_THRESHOLD_MS,
  DEV_LAUNCH_SAFETY_TIMEOUT_MS,
  beginDevLaunch,
  shouldRevealOverlay,
  isTerminalPhase,
  isSafetyTimeoutDue,
  stepStatusesForPhase,
  reduceDevLaunch,
  type DevLaunchModel,
} from './dev-launch-view'

// ① Threshold: a fast launch shows nothing; only a still-in-flight launch past
//    the threshold reveals the overlay.
describe('shouldRevealOverlay — 5s threshold', () => {
  it('stays hidden at or below the threshold', () => {
    expect(shouldRevealOverlay(0, true)).toBe(false)
    expect(shouldRevealOverlay(DEV_LAUNCH_THRESHOLD_MS - 1, true)).toBe(false)
  })

  it('reveals once the threshold elapses while in flight', () => {
    expect(shouldRevealOverlay(DEV_LAUNCH_THRESHOLD_MS, true)).toBe(true)
    expect(shouldRevealOverlay(DEV_LAUNCH_THRESHOLD_MS + 10_000, true)).toBe(true)
  })

  it('never reveals when no longer in flight', () => {
    expect(shouldRevealOverlay(DEV_LAUNCH_THRESHOLD_MS + 1, false)).toBe(false)
  })

  it('tick reveals a hidden model only past the threshold', () => {
    const m = beginDevLaunch('A', 1_000)
    expect(m.visible).toBe(false)
    const early = reduceDevLaunch(m, { kind: 'tick', now: 1_000 + DEV_LAUNCH_THRESHOLD_MS - 1 })
    expect(early.model?.visible).toBe(false)
    const due = reduceDevLaunch(m, { kind: 'tick', now: 1_000 + DEV_LAUNCH_THRESHOLD_MS })
    expect(due.model?.visible).toBe(true)
  })
})

// ② Stage → ordered steps: each stage advances the matching step and marks the
//    earlier ones done.
describe('stepStatusesForPhase — stage advances steps', () => {
  it('preparing-workspace activates step 1, rest pending', () => {
    expect(stepStatusesForPhase('preparing-workspace')).toEqual(['active', 'pending', 'pending'])
  })

  it('launching completes step 1 and activates step 2', () => {
    expect(stepStatusesForPhase('launching')).toEqual(['done', 'active', 'pending'])
  })

  it('ready marks every step done', () => {
    expect(stepStatusesForPhase('ready')).toEqual(['done', 'done', 'done'])
  })

  it('reduceDevLaunch advances the phase on a matching stage', () => {
    const m = beginDevLaunch('A', 0)
    const next = reduceDevLaunch(m, { kind: 'stage', intentId: 'A', stage: 'launching' })
    expect(next.model?.phase).toBe('launching')
    expect(stepStatusesForPhase(next.model!.phase)).toEqual(['done', 'active', 'pending'])
  })

  it('ignores a stage for a different intent', () => {
    const m = beginDevLaunch('A', 0)
    const next = reduceDevLaunch(m, { kind: 'stage', intentId: 'B', stage: 'launching' })
    expect(next.model?.phase).toBe('preparing-workspace')
    expect(next.closedReason).toBeUndefined()
  })
})

// ③ Terminal convergence: in_progress (ready) and a failed stage close the
//    overlay. (intent.* errors are closed directly by the message handler, which
//    already shows the specific error toast — not routed through the reducer.)
describe('reduceDevLaunch — terminal convergence', () => {
  const inFlight = (): DevLaunchModel => ({
    intentId: 'A',
    phase: 'launching',
    startedAt: 0,
    visible: true,
  })

  it('ready (intent flipped to in_progress) closes with no error reason', () => {
    const r = reduceDevLaunch(inFlight(), { kind: 'ready', intentId: 'A' })
    expect(r.model).toBeNull()
    expect(r.closedReason).toBe('ready')
  })

  it('failed stage closes with a failure reason', () => {
    const r = reduceDevLaunch(inFlight(), { kind: 'stage', intentId: 'A', stage: 'failed' })
    expect(r.model).toBeNull()
    expect(r.closedReason).toBe('failed')
  })

  it('ready for a different intent does not close', () => {
    const r = reduceDevLaunch(inFlight(), { kind: 'ready', intentId: 'other' })
    expect(r.model).not.toBeNull()
    expect(r.closedReason).toBeUndefined()
  })

  it('isTerminalPhase recognizes ready / failed only', () => {
    expect(isTerminalPhase('ready')).toBe(true)
    expect(isTerminalPhase('failed')).toBe(true)
    expect(isTerminalPhase('preparing-workspace')).toBe(false)
    expect(isTerminalPhase('launching')).toBe(false)
  })
})

// ④ Missing-signal safety: with no terminal signal, the safety timeout closes
//    the overlay with an error reason rather than trapping the user.
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

  it('timeout at the ceiling closes with a timeout reason', () => {
    const m = beginDevLaunch('A', 0)
    const r = reduceDevLaunch(m, { kind: 'timeout', now: DEV_LAUNCH_SAFETY_TIMEOUT_MS })
    expect(r.model).toBeNull()
    expect(r.closedReason).toBe('timeout')
  })
})

describe('reduceDevLaunch — no model is a no-op', () => {
  it('returns null transition for any event when closed', () => {
    expect(reduceDevLaunch(null, { kind: 'ready', intentId: 'A' })).toEqual({ model: null })
    expect(reduceDevLaunch(null, { kind: 'timeout', now: 0 })).toEqual({ model: null })
  })
})
