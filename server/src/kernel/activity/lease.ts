import type { ActivityState } from './types.js'

/** Running-turn lease. Sweep renews it; expiry turns the fact stale, not idle. */
export const RUNNING_LEASE_MS = 5 * 60_000

/**
 * Short grace while a turn is reconnecting. Longer than the bounded socket
 * backoff so a brief disconnect does not drop the running badge.
 */
export const RECONNECTING_LEASE_MS = 30_000

export interface LeaseOptions {
  reconnecting?: boolean
}

/**
 * Lease duration for a state. `awaiting_user`, `parked`, and `paused` are
 * unbounded: they do not expire on the ordinary running lease. `stale` and
 * `idle` have no lease to renew.
 */
export function leaseDurationMs(state: ActivityState, opts: LeaseOptions = {}): number | undefined {
  if (state === 'awaiting_user' || state === 'parked' || state === 'paused') return undefined
  if (state === 'stale' || state === 'idle') return undefined
  if (opts.reconnecting) return RECONNECTING_LEASE_MS
  return RUNNING_LEASE_MS
}

export function nextLeaseUntil(
  now: number,
  state: ActivityState,
  opts: LeaseOptions = {},
): number | undefined {
  const duration = leaseDurationMs(state, opts)
  return duration === undefined ? undefined : now + duration
}

export function isLeaseDue(now: number, leaseUntil: number | undefined): boolean {
  if (leaseUntil === undefined) return true
  return now >= leaseUntil
}

/**
 * Force-abort is a separate policy from showing stale. Lease expiry only
 * removes the member from running badges; this returns whether that stale
 * fact should also abort the underlying run. The default is never: a long
 * silent tool must not be killed for lack of text.
 */
export function shouldAbortOnStale(): boolean {
  return false
}
