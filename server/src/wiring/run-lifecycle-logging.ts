/**
 * Wiring —— run 生命周期日志的常驻订阅。
 *
 * 每一个 run(交互式会话、intent / spec 会话、driver 路径、automation 执行、
 * discussion 编排、一次性内部调用)在启动与退出时都会往总线发 `run:started` /
 * `run:settled`。把「打日志」挂在总线上而不是散在各个发布点,好处是:
 *
 *  - 只此一处决定 run 日志长什么样,新增一个 run 发布者自动获得启动/退出日志;
 *  - 启动与退出必然成对(总线已保证 started→settled 不变式),日志里也成对;
 *  - 打日志是纯旁路 —— 订阅抛错被总线隔离,绝不会影响 run 本身。
 *
 * 退出行的耗时由 `run-log` 的登记表算出;`run:bound` 负责把 pending id 上的起点
 * 迁到真实会话 id 上,否则以 pending id 起、以真实 id 落的 run 就没有耗时。
 *
 * 异常的**细节**(stack)不在这里打:总线事件只带终态 `reason`,拿不到异常对象。
 * 抛异常的现场(launcher / driver)自己用 `logRunFailure` 打消息 + stack,这里
 * 只负责那条统一的 `settled reason=error` 退出行。
 */
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import { logRunSettled, logRunStarted, rebindRunStart } from '../kernel/run/run-log.js'

/** 注册 run 生命周期日志订阅(进程级常驻,不 dispose)。 */
export function registerRunLifecycleLogging(eventBus: EventBus<EventBusEvents>): void {
  eventBus.subscribe('run:started', (e) => {
    logRunStarted({
      sessionId: e.sessionId,
      workspacePath: e.workspacePath,
      sessionKind: e.sessionKind,
      runKind: e.runKind,
    })
  })

  eventBus.subscribe('run:bound', (e) => {
    rebindRunStart(e.prevId, e.realId)
  })

  eventBus.subscribe('run:settled', (e) => {
    logRunSettled(
      {
        sessionId: e.sessionId,
        workspacePath: e.workspacePath,
        sessionKind: e.sessionKind,
        runKind: e.runKind,
      },
      e.reason,
    )
  })
}
