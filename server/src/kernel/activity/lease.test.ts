import { describe, expect, it } from 'vitest'
import {
  isLeaseDue,
  leaseDurationMs,
  nextLeaseUntil,
  RECONNECTING_LEASE_MS,
  RUNNING_LEASE_MS,
  shouldAbortOnStale,
} from './lease.js'

describe('activity lease policy', () => {
  it('gives running a bounded lease and reconnecting a shorter one', () => {
    expect(leaseDurationMs('running')).toBe(RUNNING_LEASE_MS)
    expect(leaseDurationMs('running', { reconnecting: true })).toBe(RECONNECTING_LEASE_MS)
    expect(nextLeaseUntil(1_000, 'running')).toBe(1_000 + RUNNING_LEASE_MS)
    expect(nextLeaseUntil(1_000, 'running', { reconnecting: true })).toBe(
      1_000 + RECONNECTING_LEASE_MS,
    )
  })

  it('does not put a running lease on awaiting_user, parked, or paused', () => {
    expect(leaseDurationMs('awaiting_user')).toBeUndefined()
    expect(leaseDurationMs('parked')).toBeUndefined()
    expect(leaseDurationMs('paused')).toBeUndefined()
    expect(nextLeaseUntil(1_000, 'awaiting_user')).toBeUndefined()
  })

  it('treats a missing or reached leaseUntil as due', () => {
    expect(isLeaseDue(5_000, undefined)).toBe(true)
    expect(isLeaseDue(5_000, 5_000)).toBe(true)
    expect(isLeaseDue(5_000, 4_999)).toBe(true)
    expect(isLeaseDue(5_000, 5_001)).toBe(false)
  })

  it('does not abort a run just because it became stale', () => {
    expect(shouldAbortOnStale()).toBe(false)
  })
})
