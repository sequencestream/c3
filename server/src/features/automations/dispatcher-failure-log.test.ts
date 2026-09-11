/**
 * 自动化失败明细进运行日志 —— 覆盖「不抛异常、只把原因写进执行日志」的失败路径。
 *
 * 这类失败是 automation 的常态:dispatcher 把原因写进执行日志的 `failed` 记录后
 * 正常返回,`dispatchAndTrack` 的 `.catch()` 永远不触发。因此本测试用**真实的**
 * dispatcher 跑出每条失败分支,并接上**真实的** run-log 格式化与生命周期日志订阅,
 * 断言运行日志里有且仅有一条带该原因的 `[run] failed`,且排在这次 run 的
 * `[run] settled reason=error` 之前。
 *
 * 只有 dispatcher 触达的厂商 SDK 被 mock(不起网络/子进程);command 分支刻意跑
 * 真实的 `sh -c`,非零退出与超时才是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Identity workspace resolution: fixtures use the path itself as the id.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))

const queryImpl = vi.hoisted(() => ({ fn: (_opts: unknown): AsyncIterable<unknown> => emptyGen() }))
async function* emptyGen(): AsyncGenerator<unknown> {
  /* replaced per-test */
}
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (o: unknown) => queryImpl.fn(o) }))

vi.mock('../../kernel/config/index.js', () => ({
  getTimezone: () => 'UTC',
  loadSettings: () => ({ agents: [{ id: 'agent-1', enabled: true, vendor: 'claude' }] }),
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ model: 'test-model', envOverrides: {} }),
  isModelProviderPausedError: () => false,
  setAgentEnabled: () => true,
  bindClaudeRelay: () => null,
  unbindRelay: () => {},
  freezeSessionAgent: () => undefined,
}))
vi.mock('../../kernel/infra/child-env.js', () => ({
  buildChildEnv: () => ({}),
  findClaudeExecutable: () => undefined,
}))
vi.mock('./store.js', () => ({
  getWorkspaceMcpConfig: () => ({ mcpServers: {} }),
  isAgentQuotaRecoveryConfig: () => false,
  isAgentQuotaRecoveryAutomation: () => false,
}))
vi.mock('../sessions/session-metadata-store.js', () => ({
  upsertAutomationExecutionRow: () => undefined,
}))

import type { Automation } from '@ccc/shared/protocol'
import { EventBus, type EventBusEvents } from '../../kernel/events/event-bus.js'
import { resetRunLogForTests } from '../../kernel/run/run-log.js'
import { registerRunLifecycleLogging } from '../../wiring/run-lifecycle-logging.js'
import { dispatchAndTrack, setEventBus, setExecutionStore } from './engine.js'

const LOG_ID = 'exec-log-1'
let ws: string
let lines: string[]

/** 一个最小的内存执行日志仓储:只要记下 patch,不需要真库。 */
function memStore(patches: Record<string, unknown>[]): Parameters<typeof setExecutionStore>[0] {
  return {
    getDueAutomations: () => [],
    getEventAutomations: () => [],
    // null ⇒ 跳过重新排程(本测试只关心失败日志)。
    getAutomation: () => null,
    updateNextRunAt: () => {},
    updateAutomation: () => {},
    deleteAutomation: () => {},
    appendExecutionLog: () => ({ id: LOG_ID }),
    updateExecutionLog: (_id, patch) => patches.push(patch),
  }
}

function automationOf(over: Partial<Automation>): Automation {
  return {
    id: 'auto-1',
    type: 'llm',
    status: 'active',
    workspaceName: ws,
    vendor: 'claude',
    mode: 'default',
    config: {},
    ...over,
  } as unknown as Automation
}

/** 跑一次执行,返回捕获到的执行日志 patch(运行日志行落在 `lines`)。 */
async function run(automation: Automation): Promise<Record<string, unknown>[]> {
  const patches: Record<string, unknown>[] = []
  const bus = new EventBus<EventBusEvents>()
  // 真实订阅先注册,因此 settled 日志先于下面的 resolve 打出。
  registerRunLifecycleLogging(bus)
  setEventBus(bus)
  setExecutionStore(memStore(patches))
  const settled = new Promise<void>((resolve) => bus.subscribe('run:settled', () => resolve()))
  dispatchAndTrack(automation)
  await settled
  return patches
}

const failedLines = (): string[] => lines.filter((l) => l.startsWith('[run] failed'))
const settledLines = (): string[] => lines.filter((l) => l.startsWith('[run] settled'))

/** 失败明细必须唯一、带上该原因与本次 run 的身份,并排在结算行之前。 */
function expectFailureDetail(error: string): void {
  expect(failedLines()).toEqual([
    `[run] failed stage=automation:auto-1 session=${LOG_ID} kind=automation/headless workspace=${ws}: ${error}`,
  ])
  expect(settledLines()).toHaveLength(1)
  expect(settledLines()[0]).toContain('[run] settled reason=error')
  expect(lines.indexOf(failedLines()[0])).toBeLessThan(lines.indexOf(settledLines()[0]))
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'c3-auto-faillog-'))
  lines = []
  resetRunLogForTests()
  const capture = (...args: unknown[]): void => void lines.push(format(...args))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
})

afterEach(() => {
  vi.restoreAllMocks()
  setEventBus(new EventBus<EventBusEvents>())
  rmSync(ws, { recursive: true, force: true })
})

describe('automation run failure detail — command', () => {
  it('logs the detail for a non-zero exit after retries are exhausted', async () => {
    const patches = await run(automationOf({ type: 'command', config: { command: 'exit 3' } }))

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'exit_code_3' })
    expectFailureDetail('exit_code_3')
  })

  it('logs the detail for a wall-clock timeout', async () => {
    const patches = await run(
      automationOf({ type: 'command', config: { command: 'sleep 5' }, maxWallClockMs: 50 }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'timeout' })
    expectFailureDetail('timeout')
  })

  it('logs nothing extra when the command succeeds', async () => {
    const patches = await run(automationOf({ type: 'command', config: { command: 'exit 0' } }))

    expect(patches.at(-1)).toMatchObject({ status: 'success' })
    expect(failedLines()).toEqual([])
    expect(settledLines()[0]).toContain('reason=complete')
  })

  it('logs one detail only for the terminal failure, not for each retry', async () => {
    const patches = await run(
      automationOf({ type: 'command', config: { command: 'exit 4', maxRetries: 2 } }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'exit_code_4' })
    expectFailureDetail('exit_code_4')
  })

  it('logs no terminal detail when a retry finally succeeds', async () => {
    const marker = join(ws, 'attempted')
    const patches = await run(
      automationOf({
        type: 'command',
        // 第一次尝试失败,第二次看到标记文件后成功。
        config: { command: `[ -f ${marker} ] || { touch ${marker}; exit 1; }`, maxRetries: 1 },
      }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'success' })
    expect(failedLines()).toEqual([])
  })
})

describe('automation run failure detail — llm', () => {
  it('logs the detail for an empty prompt', async () => {
    const patches = await run(automationOf({ agentId: 'agent-1', config: { prompt: '  ' } }))

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'empty_prompt' })
    expectFailureDetail('empty_prompt')
  })

  it('logs the detail when no agent is bound', async () => {
    const patches = await run(automationOf({ agentId: null, config: { prompt: 'do a thing' } }))

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'automation_agent_required' })
    expectFailureDetail('automation_agent_required')
  })

  it('logs the detail for a wall-clock timeout', async () => {
    queryImpl.fn = () =>
      (async function* () {
        // 让挂钟超时先于第一条消息到达,执行随后以 aborted 收尾。
        await new Promise((r) => setTimeout(r, 30))
        yield { type: 'system' }
      })()

    const patches = await run(
      automationOf({ agentId: 'agent-1', config: { prompt: 'do a thing' }, maxWallClockMs: 1 }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'wall_clock_timeout' })
    expectFailureDetail('wall_clock_timeout')
  })

  it('logs the detail for a schema validation failure', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'not json' }] } }
        yield { type: 'result' }
      })()

    const patches = await run(
      automationOf({
        agentId: 'agent-1',
        config: {
          prompt: 'do a thing',
          outputSchema: { type: 'object', required: ['verdict'] },
        },
      }),
    )

    expect(patches.at(-1)).toMatchObject({
      status: 'failed',
      error: 'schema_validation_failed: invalid JSON for object schema',
    })
    expectFailureDetail('schema_validation_failed: invalid JSON for object schema')
  })

  it('logs the detail for an SDK error caught by the dispatcher', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system' }
        throw new Error('sdk stream exploded')
      })()

    const patches = await run(
      automationOf({ agentId: 'agent-1', config: { prompt: 'do a thing' } }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'failed', error: 'sdk stream exploded' })
    expectFailureDetail('sdk stream exploded')
  })

  it('logs nothing extra on a clean run', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
        yield { type: 'result' }
      })()

    const patches = await run(
      automationOf({ agentId: 'agent-1', config: { prompt: 'do a thing' } }),
    )

    expect(patches.at(-1)).toMatchObject({ status: 'success' })
    expect(failedLines()).toEqual([])
    expect(settledLines()[0]).toContain('reason=complete')
  })
})
