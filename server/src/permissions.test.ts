import { describe, it, expect, vi } from 'vitest'
import { waitForDecision, resolveDecision, pendingCount } from './permissions.js'

describe('permission registry', () => {
  it('resolves with the decision delivered via resolveDecision', async () => {
    const p = waitForDecision('req-1')
    expect(pendingCount()).toBe(1)

    const matched = resolveDecision('req-1', 'allow')
    expect(matched).toBe(true)

    await expect(p).resolves.toEqual({ decision: 'allow', answers: undefined })
    expect(pendingCount()).toBe(0)
  })

  it('passes through a deny decision', async () => {
    const p = waitForDecision('req-deny')
    resolveDecision('req-deny', 'deny')
    await expect(p).resolves.toEqual({ decision: 'deny', answers: undefined })
  })

  it('carries AskUserQuestion answers on an allow', async () => {
    const p = waitForDecision('req-ans')
    resolveDecision('req-ans', 'allow', { 'Q?': 'A' })
    await expect(p).resolves.toEqual({ decision: 'allow', answers: { 'Q?': 'A' } })
  })

  it('blocks indefinitely until a decision arrives (no auto-deny)', async () => {
    const settled = vi.fn()
    const p = waitForDecision('req-block').then(settled)
    expect(pendingCount()).toBe(1)

    // Let microtasks flush — the promise must still be pending.
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    resolveDecision('req-block', 'allow')
    await p
    expect(settled).toHaveBeenCalledWith({ decision: 'allow', answers: undefined })
  })

  it('clears the pending entry and denies when the signal aborts', async () => {
    const ac = new AbortController()
    const p = waitForDecision('req-abort', ac.signal)
    expect(pendingCount()).toBe(1)

    ac.abort()
    await expect(p).resolves.toEqual({ decision: 'deny' })
    expect(pendingCount()).toBe(0)
  })

  it('denies immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const p = waitForDecision('req-pre-aborted', ac.signal)
    await expect(p).resolves.toEqual({ decision: 'deny' })
    expect(pendingCount()).toBe(0)
  })

  it('returns false for unknown or already-resolved request ids', () => {
    expect(resolveDecision('never-registered', 'allow')).toBe(false)

    waitForDecision('req-once')
    expect(resolveDecision('req-once', 'allow')).toBe(true)
    // Second resolve finds nothing pending.
    expect(resolveDecision('req-once', 'deny')).toBe(false)
  })
})
