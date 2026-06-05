/**
 * Unit tests for the pure `decideResume` run-continuation state machine
 * (server refactor 3/3). Covers every branch: step (succeed), fallback,
 * resume, exhausted, and stop (abort + refused socket disconnect).
 */
import { describe, it, expect } from 'vitest'
import { decideResume } from './decide-resume.js'
import type { SocketResumeContext } from './resume.js'

// A socket context that PASSES every auto-resume conjunct (so decideSocketResume
// returns auto-resume). Individual tests flip one field to force a refusal.
const resumableCtx: SocketResumeContext = {
  autoResumeEnabled: true,
  sideEffectPending: false,
  retryAlreadyUsed: false,
  isPendingSession: false,
  isTeam: false,
  aborted: false,
}

describe('decideResume — step (completion / abort)', () => {
  it('completed ⇒ succeed', () => {
    expect(decideResume({ attemptIndex: 0, chainLength: 1 }, { kind: 'completed' })).toEqual({
      type: 'succeed',
    })
  })

  it('aborted ⇒ stop with no turnEnd (finalizeRun settles it)', () => {
    expect(decideResume({ attemptIndex: 1, chainLength: 3 }, { kind: 'aborted' })).toEqual({
      type: 'stop',
    })
  })
})

describe('decideResume — fallback (degradation chain stepping)', () => {
  it('degradable with agents left ⇒ fallback to the next index', () => {
    expect(decideResume({ attemptIndex: 0, chainLength: 2 }, { kind: 'degradable' })).toEqual({
      type: 'fallback',
      nextIndex: 1,
    })
  })

  it('degradable mid-chain ⇒ fallback advances by one', () => {
    expect(decideResume({ attemptIndex: 1, chainLength: 4 }, { kind: 'degradable' })).toEqual({
      type: 'fallback',
      nextIndex: 2,
    })
  })

  it('degradable on the LAST agent ⇒ exhausted (no further fallback)', () => {
    expect(decideResume({ attemptIndex: 1, chainLength: 2 }, { kind: 'degradable' })).toEqual({
      type: 'exhausted',
    })
  })

  it('a single-agent chain that degrades is immediately exhausted', () => {
    expect(decideResume({ attemptIndex: 0, chainLength: 1 }, { kind: 'degradable' })).toEqual({
      type: 'exhausted',
    })
  })
})

describe('decideResume — resume (socket auto-resume)', () => {
  it('a recoverable socket disconnect ⇒ resume (same session, no chain advance)', () => {
    expect(
      decideResume(
        { attemptIndex: 0, chainLength: 2 },
        { kind: 'socket', error: 'socket connection was closed unexpectedly', ctx: resumableCtx },
      ),
    ).toEqual({ type: 'resume' })
  })

  it('resume is independent of chain position (mid-chain socket drop still resumes)', () => {
    expect(
      decideResume(
        { attemptIndex: 1, chainLength: 3 },
        { kind: 'socket', error: 'socket connection was closed unexpectedly', ctx: resumableCtx },
      ),
    ).toEqual({ type: 'resume' })
  })
})

describe('decideResume — stop (refused socket disconnect)', () => {
  it('a spent single retry ⇒ stop carrying the manual terminal turn_end', () => {
    const action = decideResume(
      { attemptIndex: 0, chainLength: 1 },
      {
        kind: 'socket',
        error: 'socket connection was closed unexpectedly',
        ctx: { ...resumableCtx, retryAlreadyUsed: true },
      },
    )
    expect(action.type).toBe('stop')
    if (action.type === 'stop') {
      expect(action.turnEnd).toMatchObject({
        type: 'turn_end',
        reason: 'error',
        original_error: 'socket connection was closed unexpectedly',
        reconnect_attempted: true,
        retry_count: 1,
      })
    }
  })

  it('an unclosed write-class tool (side-effect pending) ⇒ stop, gate verdict recorded', () => {
    const action = decideResume(
      { attemptIndex: 0, chainLength: 1 },
      {
        kind: 'socket',
        error: 'socket connection was closed unexpectedly',
        ctx: { ...resumableCtx, sideEffectPending: true },
      },
    )
    expect(action.type).toBe('stop')
    if (action.type === 'stop') {
      expect(action.turnEnd).toMatchObject({
        side_effect_pending: true,
        reconnect_attempted: false,
      })
    }
  })

  it('the auto-resume switch off ⇒ stop (manual continue)', () => {
    const action = decideResume(
      { attemptIndex: 0, chainLength: 1 },
      {
        kind: 'socket',
        error: 'socket connection was closed unexpectedly',
        ctx: { ...resumableCtx, autoResumeEnabled: false },
      },
    )
    expect(action.type).toBe('stop')
  })

  it('a still-pending (placeholder) session id ⇒ stop (nothing to resume)', () => {
    const action = decideResume(
      { attemptIndex: 0, chainLength: 1 },
      {
        kind: 'socket',
        error: 'socket connection was closed unexpectedly',
        ctx: { ...resumableCtx, isPendingSession: true },
      },
    )
    expect(action.type).toBe('stop')
  })
})
