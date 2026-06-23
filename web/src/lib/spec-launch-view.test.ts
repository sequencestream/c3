import { describe, expect, it } from 'vitest'
import {
  beginSpecLaunch,
  reduceSpecLaunch,
  SPEC_LAUNCH_MIN_DWELL_MS,
  SPEC_LAUNCH_SAFETY_TIMEOUT_MS,
} from './spec-launch-view'

describe('spec launch view', () => {
  it('starts visible at dependency checking and advances through server stages', () => {
    const start = beginSpecLaunch('i', 0)
    expect(start.phase).toBe('checking-dependencies')
    expect(
      reduceSpecLaunch(start, { kind: 'stage', intentId: 'i', stage: 'pulling-code', now: 1 }).model
        ?.phase,
    ).toBe('pulling-code')
  })
  it('honours minimum dwell and safety timeout', () => {
    const start = beginSpecLaunch('i', 0)
    const pending = reduceSpecLaunch(start, { kind: 'ready', intentId: 'i', now: 1 }).model
    expect(pending).not.toBeNull()
    expect(
      reduceSpecLaunch(pending, { kind: 'dwell-complete', now: SPEC_LAUNCH_MIN_DWELL_MS })
        .closedReason,
    ).toBe('ready')
    expect(
      reduceSpecLaunch(start, { kind: 'timeout', now: SPEC_LAUNCH_SAFETY_TIMEOUT_MS }).closedReason,
    ).toBe('timeout')
  })
})
