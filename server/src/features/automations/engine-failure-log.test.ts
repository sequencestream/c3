/**
 * `dispatchAndTrack` 补打失败明细的**触发条件** —— 按执行日志 patch 的形状逐项验证。
 *
 * 这里把 dispatcher 换成一个可编排的假执行,好处是能直接喂出真实分支难以同时凑出的
 * patch 形状(`cancelled` 带 error、`failed` 缺 error、只绑 sessionId 等),确认明细
 * 只在「`failed` + 非空 error」时打出一条。真实失败分支的覆盖在
 * `dispatcher-failure-log.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'node:util'

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))

vi.mock('../../kernel/config/index.js', () => ({
  getTimezone: () => 'UTC',
  getAutomationEnabled: () => true,
}))

vi.mock('./store.js', () => ({
  isAgentQuotaRecoveryAutomation: () => false,
}))

// 可编排的执行:每个用例决定写出哪些 patch、是否抛出。
const dispatch = vi.hoisted(() => ({
  run: null as
    null | ((logId: string, updateLog: (id: string, p: Record<string, unknown>) => void) => void),
}))
vi.mock('./dispatcher.js', () => ({
  execute: vi.fn(
    async (
      _automation: unknown,
      logId: string,
      updateLog: (id: string, p: Record<string, unknown>) => void,
    ) => {
      dispatch.run?.(logId, updateLog)
    },
  ),
}))

import type { Automation } from '@ccc/shared/protocol'
import { EventBus, type EventBusEvents } from '../../kernel/events/event-bus.js'
import { resetRunLogForTests } from '../../kernel/run/run-log.js'
import { registerRunLifecycleLogging } from '../../wiring/run-lifecycle-logging.js'
import { dispatchAndTrack, setEventBus, setExecutionStore } from './engine.js'

const LOG_ID = 'exec-log-1'
const WS = '/abs/workspace-a'
let lines: string[]

const automation = {
  id: 'auto-1',
  type: 'llm',
  status: 'active',
  workspaceName: WS,
  vendor: 'claude',
  agentId: 'agent-1',
  mode: 'default',
  config: { prompt: 'do a thing' },
} as unknown as Automation

/** 按给定的编排跑一次执行,返回这次 run 的结算 reason。 */
async function run(
  script: (logId: string, updateLog: (id: string, p: Record<string, unknown>) => void) => void,
): Promise<string> {
  dispatch.run = script
  const bus = new EventBus<EventBusEvents>()
  registerRunLifecycleLogging(bus)
  setEventBus(bus)
  setExecutionStore({
    getDueAutomations: () => [],
    getEventAutomations: () => [],
    getAutomation: () => null,
    updateNextRunAt: () => {},
    updateAutomation: () => {},
    deleteAutomation: () => {},
    appendExecutionLog: () => ({ id: LOG_ID }),
    updateExecutionLog: () => {},
  })
  let reason = ''
  const settled = new Promise<void>((resolve) =>
    bus.subscribe('run:settled', (e) => {
      reason = e.reason
      resolve()
    }),
  )
  dispatchAndTrack(automation)
  await settled
  return reason
}

const failedLines = (): string[] => lines.filter((l) => l.startsWith('[run] failed'))

beforeEach(() => {
  lines = []
  resetRunLogForTests()
  const capture = (...args: unknown[]): void => void lines.push(format(...args))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
})

afterEach(() => {
  vi.restoreAllMocks()
  dispatch.run = null
  setEventBus(new EventBus<EventBusEvents>())
})

describe('dispatchAndTrack — when a failure detail is logged', () => {
  it('logs one detail with the run identity for failed + error', async () => {
    const reason = await run((logId, updateLog) => {
      updateLog(logId, { status: 'failed', error: 'automation_vendor_unsupported' })
    })

    expect(reason).toBe('error')
    expect(failedLines()).toEqual([
      `[run] failed stage=automation:auto-1 session=${LOG_ID} kind=automation/headless workspace=${WS}: automation_vendor_unsupported`,
    ])
  })

  it('logs no detail for cancelled, even when it carries an error', async () => {
    const reason = await run((logId, updateLog) => {
      updateLog(logId, { status: 'cancelled', error: 'stopped_by_user' })
    })

    // 取消仍按非成功结算,只是不算错误 —— 不打明细。
    expect(reason).toBe('error')
    expect(failedLines()).toEqual([])
  })

  it('logs no detail for failed without an error, and still settles as error', async () => {
    const reason = await run((logId, updateLog) => {
      updateLog(logId, { status: 'failed', output: 'partial' })
    })

    expect(reason).toBe('error')
    expect(failedLines()).toEqual([])
  })

  it('logs no detail when the error is an empty string', async () => {
    await run((logId, updateLog) => updateLog(logId, { status: 'failed', error: '' }))

    expect(failedLines()).toEqual([])
  })

  it('logs no detail for non-terminal patches (session binding, output, error alone)', async () => {
    const reason = await run((logId, updateLog) => {
      updateLog(logId, { sessionId: 'sess-live' })
      updateLog(logId, { output: 'partial' })
      updateLog(logId, { error: 'transient hiccup' })
      updateLog(logId, { status: 'success', finishedAt: Date.now() })
    })

    expect(reason).toBe('complete')
    expect(failedLines()).toEqual([])
  })

  it('logs the thrown error once, with its stack, and does not double-log', async () => {
    const reason = await run(() => {
      throw new Error('boom')
    })

    expect(reason).toBe('error')
    expect(failedLines()).toEqual([
      `[run] failed stage=automation:auto-1 session=${LOG_ID} kind=automation/headless workspace=${WS}: boom`,
    ])
    // 异常分支保留现场:明细行之后紧跟 stack。
    const stack = lines[lines.indexOf(failedLines()[0]) + 1]
    expect(stack).toContain('Error: boom')
    expect(stack).toContain('    at ')
  })
})
