/**
 * When the activity store needs a full snapshot instead of waiting for delta.
 * Periodic count/status requests are not a recovery path.
 */

export const ACTIVITY_SNAPSHOT_STALE_MS = 30_000
export const CONSOLE_SESSION_LIST_INTERVAL_MS = 10_000

export interface ActivitySnapshotRefreshInput {
  connected: boolean
  revision: number
  lastAppliedAt: number
  now: number
  staleMs?: number
}

let appliedAt = 0

export function markActivityApplied(now: number): void {
  appliedAt = now
}

export function activityAppliedAt(): number {
  return appliedAt
}

export function resetActivityAppliedForTests(): void {
  appliedAt = 0
}

/**
 * Ask for a snapshot only when the socket is up and the client has no usable
 * projection: never received one, or the last applied frame is too old.
 * Reconnect and revision-gap handlers request on their own.
 */
export function shouldRequestActivitySnapshot(input: ActivitySnapshotRefreshInput): boolean {
  if (!input.connected) return false
  if (input.revision <= 0) return true
  const staleMs = input.staleMs ?? ACTIVITY_SNAPSHOT_STALE_MS
  return input.now - input.lastAppliedAt >= staleMs
}
