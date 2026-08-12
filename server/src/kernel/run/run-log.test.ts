import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatDuration,
  formatRunFailed,
  formatRunSettled,
  formatRunStarted,
  logRunFailure,
  logRunSettled,
  logRunStarted,
  noteRunStart,
  rebindRunStart,
  resetRunLogForTests,
  runErrDetail,
  runErrMsg,
  takeRunDuration,
  type RunLogIdentity,
} from './run-log.js'

const ID: RunLogIdentity = {
  sessionId: 'sess-1',
  workspacePath: '/w/proj',
  sessionKind: 'work',
  runKind: 'interactive',
}

afterEach(() => {
  resetRunLogForTests()
  vi.restoreAllMocks()
})

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(800)).toBe('0.8s')
    expect(formatDuration(12_400)).toBe('12.4s')
  })

  it('renders minute-scale durations as m+s', () => {
    expect(formatDuration(192_400)).toBe('3m12.4s')
  })

  it('renders a negative or non-finite input as unknown rather than throwing', () => {
    expect(formatDuration(-1)).toBe('?')
    expect(formatDuration(Number.NaN)).toBe('?')
  })
})

describe('run log lines', () => {
  it('starts with the run identity fields', () => {
    expect(formatRunStarted(ID)).toBe(
      '[run] started session=sess-1 kind=work/interactive workspace=/w/proj',
    )
  })

  it('appends agent/vendor only when known', () => {
    expect(formatRunStarted({ ...ID, agentId: 'a1', vendor: 'codex' })).toBe(
      '[run] started session=sess-1 kind=work/interactive workspace=/w/proj agent=a1 vendor=codex',
    )
  })

  it('carries reason and duration on the settle line', () => {
    expect(formatRunSettled(ID, 'complete', 12_400)).toBe(
      '[run] settled reason=complete duration=12.4s session=sess-1 kind=work/interactive workspace=/w/proj',
    )
  })

  it('omits duration when no start was recorded', () => {
    expect(formatRunSettled(ID, 'aborted', null)).toBe(
      '[run] settled reason=aborted session=sess-1 kind=work/interactive workspace=/w/proj',
    )
  })

  it('names the failing stage and the error message', () => {
    expect(formatRunFailed(ID, 'driver', new Error('boom'))).toBe(
      '[run] failed stage=driver session=sess-1 kind=work/interactive workspace=/w/proj: boom',
    )
  })
})

describe('error rendering', () => {
  it('reads the message off an Error and stringifies anything else', () => {
    expect(runErrMsg(new Error('boom'))).toBe('boom')
    expect(runErrMsg('plain')).toBe('plain')
    expect(runErrMsg(42)).toBe('42')
  })

  it('prefers the stack as the detail, falling back to the message', () => {
    const err = new Error('boom')
    expect(runErrDetail(err)).toBe(err.stack)
    expect(runErrDetail('plain')).toBe('plain')
  })
})

describe('duration bookkeeping', () => {
  it('measures from the recorded start and consumes the entry', () => {
    noteRunStart('sess-1', 1_000)
    expect(takeRunDuration('sess-1', 3_500)).toBe(2_500)
    expect(takeRunDuration('sess-1', 4_000)).toBeNull()
  })

  it('follows a pending→real rebind so the settle line keeps its duration', () => {
    noteRunStart('pending:x', 1_000)
    rebindRunStart('pending:x', 'real-1')
    expect(takeRunDuration('real-1', 2_000)).toBe(1_000)
  })

  it('ignores a rebind for an unknown id', () => {
    rebindRunStart('nope', 'real-2')
    expect(takeRunDuration('real-2')).toBeNull()
  })

  it('never reports a negative duration when the clock goes backwards', () => {
    noteRunStart('sess-1', 5_000)
    expect(takeRunDuration('sess-1', 4_000)).toBe(0)
  })
})

describe('log level by terminal reason', () => {
  it('routes complete to log, error to error, and anything else to warn', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    logRunStarted(ID, 1_000)
    expect(log).toHaveBeenCalledWith(formatRunStarted(ID))

    logRunSettled(ID, 'complete', 2_000)
    expect(log).toHaveBeenLastCalledWith(formatRunSettled(ID, 'complete', 1_000))

    logRunStarted(ID, 1_000)
    logRunSettled(ID, 'error', 2_000)
    expect(error).toHaveBeenCalledWith(formatRunSettled(ID, 'error', 1_000))

    logRunStarted(ID, 1_000)
    logRunSettled(ID, 'aborted', 2_000)
    expect(warn).toHaveBeenCalledWith(formatRunSettled(ID, 'aborted', 1_000))
  })

  it('prints the message line and the stack on a failure', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('boom')
    logRunFailure(ID, 'launch', err)
    expect(error).toHaveBeenNthCalledWith(1, formatRunFailed(ID, 'launch', err))
    expect(error).toHaveBeenNthCalledWith(2, err.stack)
  })

  it('does not repeat the message when the error carries no stack', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logRunFailure(ID, 'launch', 'plain failure')
    expect(error).toHaveBeenCalledTimes(1)
  })
})
