import { afterEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_SNAPSHOT_STALE_MS,
  activityAppliedAt,
  markActivityApplied,
  resetActivityAppliedForTests,
  shouldRequestActivitySnapshot,
} from './activity-refresh'

afterEach(() => {
  resetActivityAppliedForTests()
})

describe('shouldRequestActivitySnapshot', () => {
  const fresh = {
    connected: true,
    revision: 3,
    lastAppliedAt: 1_000,
    now: 1_000 + 5_000,
  }

  it('does not request when the socket is down', () => {
    expect(shouldRequestActivitySnapshot({ ...fresh, connected: false, revision: 0 })).toBe(false)
  })

  it('requests when no snapshot has landed', () => {
    expect(shouldRequestActivitySnapshot({ ...fresh, revision: 0 })).toBe(true)
  })

  it('does not request while a fresh snapshot is in hand', () => {
    expect(shouldRequestActivitySnapshot(fresh)).toBe(false)
  })

  it('requests when the last applied frame is older than the stale window', () => {
    expect(
      shouldRequestActivitySnapshot({
        ...fresh,
        now: 1_000 + ACTIVITY_SNAPSHOT_STALE_MS,
      }),
    ).toBe(true)
  })
})

describe('markActivityApplied', () => {
  it('records the last applied timestamp', () => {
    markActivityApplied(42)
    expect(activityAppliedAt()).toBe(42)
  })
})
