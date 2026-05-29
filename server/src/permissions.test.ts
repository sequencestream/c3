import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  waitForDecision,
  resolveDecision,
  pendingCount,
  PERMISSION_TIMEOUT_MS,
} from './permissions.js'

describe('permission registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the decision delivered via resolveDecision', async () => {
    const p = waitForDecision('req-1')
    expect(pendingCount()).toBe(1)

    const matched = resolveDecision('req-1', 'allow')
    expect(matched).toBe(true)

    await expect(p).resolves.toBe('allow')
    expect(pendingCount()).toBe(0)
  })

  it('passes through a deny decision', async () => {
    const p = waitForDecision('req-deny')
    resolveDecision('req-deny', 'deny')
    await expect(p).resolves.toBe('deny')
  })

  it('auto-denies after the timeout elapses', async () => {
    const p = waitForDecision('req-timeout', 1000)
    expect(pendingCount()).toBe(1)

    vi.advanceTimersByTime(1000)

    await expect(p).resolves.toBe('deny')
    expect(pendingCount()).toBe(0)
  })

  it('does not time out before the deadline', async () => {
    const p = waitForDecision('req-early', 1000)
    vi.advanceTimersByTime(999)
    resolveDecision('req-early', 'allow')
    await expect(p).resolves.toBe('allow')
  })

  it('clears the timeout once resolved (no late auto-deny)', async () => {
    const settled = vi.fn()
    const p = waitForDecision('req-clear', 1000).then(settled)

    resolveDecision('req-clear', 'allow')
    await p
    expect(settled).toHaveBeenCalledWith('allow')

    // Advancing past the original deadline must not re-settle the promise.
    vi.advanceTimersByTime(5000)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('returns false for unknown or already-resolved request ids', () => {
    expect(resolveDecision('never-registered', 'allow')).toBe(false)

    waitForDecision('req-once')
    expect(resolveDecision('req-once', 'allow')).toBe(true)
    // Second resolve finds nothing pending.
    expect(resolveDecision('req-once', 'deny')).toBe(false)
  })

  it('defaults to the 60s production timeout', async () => {
    const p = waitForDecision('req-default')
    vi.advanceTimersByTime(PERMISSION_TIMEOUT_MS - 1)
    expect(pendingCount()).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe('deny')
  })
})
