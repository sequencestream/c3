import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type EventBusEvents } from '../kernel/events/event-bus.js'
import { resetRunLogForTests } from '../kernel/run/run-log.js'
import { registerRunLifecycleLogging } from './run-lifecycle-logging.js'

let bus: EventBus<EventBusEvents>

beforeEach(() => {
  bus = new EventBus()
  registerRunLifecycleLogging(bus)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  resetRunLogForTests()
  vi.restoreAllMocks()
})

const STARTED = {
  sessionId: 'pending:abc',
  workspacePath: '/w/proj',
  sessionKind: 'work',
  runKind: 'interactive',
} as const

describe('run 生命周期日志订阅', () => {
  it('任一发布者的 run:started 都会产生一条启动日志', () => {
    bus.publish('run:started', STARTED)
    expect(console.log).toHaveBeenCalledWith(
      '[run] started session=pending:abc kind=work/interactive workspace=/w/proj',
    )
  })

  it('退出日志带上耗时,并跨 pending→real 绑定保持连续', () => {
    bus.publish('run:started', STARTED)
    bus.publish('run:bound', { prevId: 'pending:abc', realId: 'real-1', workspacePath: '/w/proj' })
    bus.publish('run:settled', {
      sessionId: 'real-1',
      workspacePath: '/w/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\[run\] settled reason=complete duration=\d+\.\d+s session=real-1 /),
    )
  })

  it('异常终态走 error 通道,中止走 warn 通道', () => {
    bus.publish('run:settled', {
      sessionId: 's1',
      workspacePath: '/w/proj',
      reason: 'error',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('reason=error'))

    bus.publish('run:settled', {
      sessionId: 's2',
      workspacePath: '/w/proj',
      reason: 'aborted',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reason=aborted'))
  })
})
