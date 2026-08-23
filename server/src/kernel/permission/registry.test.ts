import { describe, it, expect, vi } from 'vitest'
import { waitForDecision, waitForAskAnswers, resolveDecision, pendingCount } from './registry.js'

describe('permission registry', () => {
  it('resolves with the decision delivered via resolveDecision', async () => {
    const p = waitForDecision('req-1')
    expect(pendingCount()).toBe(1)

    const matched = resolveDecision('req-1', 'allow')
    expect(matched).toEqual({ status: 'resolved' })

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

  it('carries the approving actor through to waitForDecision', async () => {
    const p = waitForDecision('req-actor')
    resolveDecision('req-actor', 'allow', undefined, 'alice')
    await expect(p).resolves.toEqual({ decision: 'allow', answers: undefined, actor: 'alice' })
  })

  it('passes a null actor through unchanged (unauthenticated / auth disabled)', async () => {
    const p = waitForDecision('req-null-actor')
    resolveDecision('req-null-actor', 'allow', undefined, null)
    await expect(p).resolves.toEqual({ decision: 'allow', answers: undefined, actor: null })
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

  it('a decision delivered before an abort wins; the later abort is a no-op', async () => {
    // The race the consensus-window fix guards: if the human answers (resolveDecision)
    // and the run is torn down a tick later, the human's answer must stand — the
    // abort must not flip it to deny or double-resolve.
    const ac = new AbortController()
    const p = waitForDecision('req-answered-then-abort', ac.signal)
    expect(resolveDecision('req-answered-then-abort', 'allow', { Q: 'A' })).toEqual({
      status: 'resolved',
    })
    // Abort arrives after the decision: nothing pending, so it cannot change it.
    ac.abort()
    await expect(p).resolves.toEqual({ decision: 'allow', answers: { Q: 'A' } })
    expect(pendingCount()).toBe(0)
  })

  it('an abort makes a later resolveDecision a no-op (no zombie / double-resolve)', async () => {
    const ac = new AbortController()
    const p = waitForDecision('req-abort-then-answer', ac.signal)
    ac.abort()
    await expect(p).resolves.toEqual({ decision: 'deny' })
    // The pending entry is gone, so a late human answer finds nothing to resolve.
    expect(resolveDecision('req-abort-then-answer', 'allow')).toEqual({ status: 'stale' })
    expect(pendingCount()).toBe(0)
  })

  it('reports stale for unknown or already-resolved request ids', () => {
    expect(resolveDecision('never-registered', 'allow')).toEqual({ status: 'stale' })

    waitForDecision('req-once')
    expect(resolveDecision('req-once', 'allow')).toEqual({ status: 'resolved' })
    // Second resolve finds nothing pending.
    expect(resolveDecision('req-once', 'deny')).toEqual({ status: 'stale' })
  })

  it('rejects an allow whose answers fail validation and stays pending', async () => {
    const p = waitForAskAnswers('req-ask', (a) =>
      a?.['Q'] ? { ok: true } : { ok: false, error: 'question not answered: "Q"' },
    )
    const rejected = resolveDecision('req-ask', 'allow', {})
    expect(rejected).toEqual({ status: 'rejected', rejected: 'question not answered: "Q"' })
    // The entry survives a rejection, so a corrected submission can still resolve.
    expect(pendingCount()).toBe(1)

    const settled = vi.fn()
    p.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    expect(resolveDecision('req-ask', 'allow', { Q: 'A' })).toEqual({ status: 'resolved' })
    await expect(p).resolves.toEqual({ decision: 'allow', answers: { Q: 'A' } })
    expect(pendingCount()).toBe(0)
  })

  it('resolves a deny without consulting the validator', async () => {
    const p = waitForAskAnswers('req-ask-deny', () => ({
      ok: false,
      error: 'should never run on a deny',
    }))
    expect(resolveDecision('req-ask-deny', 'deny')).toEqual({ status: 'resolved' })
    await expect(p).resolves.toEqual({ decision: 'deny', answers: undefined })
    expect(pendingCount()).toBe(0)
  })
})
