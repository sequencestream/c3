import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type EventBusEvents } from '../events/event-bus.js'
import { beginInternalRun, setRunLifecycleBus } from './internal-run.js'
import { resetRunLogForTests } from './run-log.js'

let bus: EventBus<EventBusEvents>
let started: EventBusEvents['run:started'][]
let settled: EventBusEvents['run:settled'][]

beforeEach(() => {
  bus = new EventBus()
  started = []
  settled = []
  bus.subscribe('run:started', (e) => {
    started.push(e)
  })
  bus.subscribe('run:settled', (e) => {
    settled.push(e)
  })
  setRunLifecycleBus(bus)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setRunLifecycleBus(null)
  resetRunLogForTests()
  vi.restoreAllMocks()
})

const input = { sessionKind: 'tool' as const, workspacePath: '/w/proj', agentId: 'a1' }

describe('beginInternalRun', () => {
  it('publishes started on entry and settled on the terminal call', () => {
    const run = beginInternalRun(input)
    expect(started).toEqual([
      { sessionId: run.runId, workspacePath: '/w/proj', sessionKind: 'tool', runKind: 'internal' },
    ])

    run.settle('complete')
    expect(settled).toEqual([
      {
        sessionId: run.runId,
        workspacePath: '/w/proj',
        reason: 'complete',
        sessionKind: 'tool',
        runKind: 'internal',
      },
    ])
  })

  it('settles exactly once however many terminal calls arrive', () => {
    const run = beginInternalRun(input)
    run.settle('complete')
    run.settle('error')
    run.fail('advisor', new Error('late'))
    expect(settled).toHaveLength(1)
    expect(settled[0].reason).toBe('complete')
  })

  it('settles a failure as error and logs the message plus stack', () => {
    const run = beginInternalRun(input)
    run.fail('advisor', new Error('boom'))
    expect(settled[0].reason).toBe('error')
    // 异常消息行 + stack + 那条 `settled reason=error` 退出行。
    expect(console.error).toHaveBeenCalledTimes(3)
    expect(console.error).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[run] failed stage=advisor'),
    )
    expect(console.error).toHaveBeenLastCalledWith(
      expect.stringContaining('[run] settled reason=error'),
    )
  })

  it('keeps the event id stable across a bind so started and settled pair up', () => {
    const run = beginInternalRun(input)
    run.bind('real-session')
    run.settle('complete')
    expect(settled[0].sessionId).toBe(run.runId)
    expect(settled[0].sessionId).toBe(started[0].sessionId)
    // The bound real id reaches the LOG line, which is where it is useful.
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('session=real-session'))
  })

  it('logs but publishes nothing when the run has no workspace', () => {
    const run = beginInternalRun({ ...input, workspacePath: '' })
    run.settle('complete')
    expect(started).toEqual([])
    expect(settled).toEqual([])
    expect(console.log).toHaveBeenCalled()
  })

  it('logs without throwing when no bus is wired', () => {
    setRunLifecycleBus(null)
    const run = beginInternalRun(input)
    expect(() => run.settle('complete')).not.toThrow()
  })

  it('gives each run its own id', () => {
    const a = beginInternalRun(input)
    const b = beginInternalRun(input)
    expect(a.runId).not.toBe(b.runId)
  })
})
