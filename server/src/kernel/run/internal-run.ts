/**
 * 内部 run 的生命周期登记 —— 给「没有 SessionRuntime、也拿不到注入总线」的那类
 * run 用。
 *
 * c3 的大多数 run 由 launcher / driver / automation / discussion 编排驱动,它们各自
 * 持有 `EventBus` 句柄,自己发 `run:started` / `run:settled`。但还有一类 run 不走
 * 这些路径:一次性、无工具的 advisor 调用(共识投票、判定、编排者笔记),它们直接
 * 驱动厂商 SDK,既没有会话运行时,也没有被注入总线。此前它们在事件与日志里是完全
 * 不可见的 —— 起没起来、跑了多久、失败没失败都看不到。
 *
 * 本模块用与 automations / intents 生命周期相同的「模块级注入」写法持有总线句柄
 * (组合根启动时 `setRunLifecycleBus`),并给这类 run 一个最小句柄:
 *
 *   const run = beginInternalRun({ sessionKind: 'tool', workspacePath, agentId })
 *   try { …; run.settle('complete') } catch (e) { run.fail('advisor', e); throw }
 *
 * 语义要点:
 *  - **启动/退出成对**:`settle` 幂等,重复调用只生效一次,保证 started 必有 settled;
 *  - **id**:内部 run 起步时还没有厂商会话 id,先用一个进程内唯一的 `internal:` id
 *    发事件;拿到真实 id 后 `bind` 只更新日志身份,**不发 `run:bound`** —— 那个
 *    topic 的常驻订阅会去做会话模式持久化与 `session_started` 广播,而内部 run
 *    没有会话视图,不该触发这些副作用;
 *  - **尽力而为**:未注入总线(单测、CLI 子命令)时只打日志不发事件,绝不抛错。
 */
import type { EventBus, EventBusEvents } from '../events/event-bus.js'
import type { RunEndReason, RunKind, SessionKind } from '@ccc/shared/protocol'
import {
  logRunFailure,
  logRunSettled,
  logRunStarted,
  rebindRunStart,
  type RunLogIdentity,
} from './run-log.js'

/** 组合根注入的总线句柄;未注入时内部 run 只打日志。 */
let eventBus: EventBus<EventBusEvents> | null = null

/** 由组合根在建好总线后调用。 */
export function setRunLifecycleBus(bus: EventBus<EventBusEvents> | null): void {
  eventBus = bus
}

/** 内部 run 的合成 id 计数器 —— 只需进程内唯一。 */
let seq = 0

/** 生成一个进程内唯一的内部 run id。 */
function nextInternalRunId(sessionKind: SessionKind): string {
  seq += 1
  return `internal:${sessionKind}:${seq}`
}

/** 启动一个内部 run 需要的最小上下文。 */
export interface InternalRunInput {
  /** 业务场景分类;一次性 advisor 调用为 `tool`。 */
  sessionKind: SessionKind
  workspacePath: string
  /** 执行形态,默认 `internal`。 */
  runKind?: RunKind
  agentId?: string | null
  vendor?: string | null
}

/** 一次内部 run 的句柄。 */
export interface InternalRunHandle {
  /** 本次 run 在事件里的 id(合成 id,绑定后仍不变)。 */
  readonly runId: string
  /** 厂商报出真实会话 id 后调用,只更新后续日志的身份。 */
  bind(sessionId: string): void
  /** 终态。幂等 —— 只有第一次调用会打日志/发事件。 */
  settle(reason: RunEndReason): void
  /** 异常退出:打印消息 + stack,并以 `error` 终态结算(幂等)。 */
  fail(stage: string, err: unknown): void
}

/**
 * 登记一个内部 run:立刻打启动日志并发 `run:started`,返回结算句柄。调用方必须在
 * 所有退出路径上 `settle` 或 `fail`(放在 `finally` 里最稳妥)。
 */
export function beginInternalRun(input: InternalRunInput): InternalRunHandle {
  const runKind: RunKind = input.runKind ?? 'internal'
  const runId = nextInternalRunId(input.sessionKind)
  let identity: RunLogIdentity = {
    sessionId: runId,
    workspacePath: input.workspacePath,
    sessionKind: input.sessionKind,
    runKind,
    agentId: input.agentId ?? null,
    vendor: input.vendor ?? null,
  }
  let settled = false
  // 事件必须能定位到一个工作区(订阅侧按工作区路由),没有工作区的内部 run 只打
  // 日志、不发事件 —— 宁可少一条事件,也不发一条指向空路径的事件。
  const publishable = input.workspacePath !== ''

  logRunStarted(identity)
  if (publishable) {
    eventBus?.publish('run:started', {
      sessionId: runId,
      workspacePath: input.workspacePath,
      sessionKind: input.sessionKind,
      runKind,
    })
  }

  const settle = (reason: RunEndReason): void => {
    if (settled) return
    settled = true
    // 日志用当前身份(可能已绑定真实会话 id),事件用起步时的合成 id —— 事件的
    // started/settled 必须同一个 id 才配得上对。
    logRunSettled(identity, reason)
    if (publishable) {
      eventBus?.publish('run:settled', {
        sessionId: runId,
        workspacePath: input.workspacePath,
        reason,
        sessionKind: input.sessionKind,
        runKind,
      })
    }
  }

  return {
    runId,
    bind(sessionId: string): void {
      if (!sessionId || sessionId === identity.sessionId) return
      // 起始时刻登记在旧 id 上,一起迁过去,否则退出行就没有耗时。
      rebindRunStart(identity.sessionId, sessionId)
      identity = { ...identity, sessionId }
    },
    settle,
    fail(stage: string, err: unknown): void {
      if (!settled) logRunFailure(identity, stage, err)
      settle('error')
    },
  }
}
