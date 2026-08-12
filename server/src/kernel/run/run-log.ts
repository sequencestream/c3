/**
 * Run 生命周期日志 —— 「一个 run 从启动到退出」在终端 / `c3.log` 里的唯一格式化处。
 *
 * c3 的 run 由多个发布者驱动(交互式 launcher、driver 路径、automation 引擎、
 * discussion 编排、一次性内部调用),此前它们只在总线上发事件、没有任何可读日志:
 * 一个 run 什么时候起来、跑了多久、以什么原因退出,在日志里完全看不到。本模块把
 * 这三件事收敛成一组纯函数 + 一个进程内的起始时刻登记表:
 *
 *  - `formatRunStarted` / `formatRunSettled` / `formatRunFailed` 是纯格式化,
 *    单测直接断言文本,调用点不各自拼字符串;
 *  - `noteRunStart` / `rebindRunStart` / `takeRunDuration` 维护 sessionId → 起始
 *    时刻,让退出行能带上真实耗时。pending→real 绑定会把登记表的键一起改写,
 *    否则 run 以 pending id 起、以真实 id 落,耗时就丢了;
 *  - `logRunStarted` / `logRunSettled` / `logRunFailure` 是调用点真正用的三个入口。
 *
 * 行首的 `YYYY-MM-DD HH:mm:ss ` 时间戳由进程级的日志 tee 统一补齐,本模块不重复
 * 打印时间 —— 否则一行会出现两个时间。
 *
 * 登记表是尽力而为的:它有上限,溢出时丢弃最早的条目(只会让耗时缺失,退出行照常
 * 打印),进程重启后为空。日志永远不能因为记账失败而影响 run 本身。
 */

/** run 的身份信息 —— 每条 run 日志都以这几个字段定位到唯一一次执行。 */
export interface RunLogIdentity {
  /** 当前的 run id(可能仍是 pending id,绑定后为真实会话 id)。 */
  sessionId: string
  workspacePath: string
  /** 业务场景分类,如 `work` / `intent` / `discussion` / `automation` / `tool`。 */
  sessionKind: string
  /** 执行形态分类,如 `interactive` / `background` / `internal`。 */
  runKind: string
  /** 本次执行绑定的 agent(已知时打印,便于把失败落到具体 agent 上)。 */
  agentId?: string | null
  vendor?: string | null
}

/** 起始时刻登记表的容量上限 —— 超出后丢弃最早的条目,只影响耗时不影响日志。 */
const MAX_TRACKED_RUNS = 1000

/** sessionId → 起始时刻(ms)。插入序即 Map 的迭代序,溢出时从头淘汰。 */
const startedAt = new Map<string, number>()

/** 把 `err` 归一成一行可读消息。 */
export function runErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** 有 stack 时返回 stack,否则返回消息 —— 异常退出日志打印的正文。 */
export function runErrDetail(err: unknown): string {
  if (err instanceof Error && err.stack) return err.stack
  return runErrMsg(err)
}

/** 把毫秒渲染成人读的耗时(`0.8s` / `12.4s` / `3m12.4s`)。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}m${seconds.toFixed(1)}s`
}

/** 登记一次 run 的起始时刻(重复登记以最新一次为准)。 */
export function noteRunStart(sessionId: string, now: number = Date.now()): void {
  if (startedAt.size >= MAX_TRACKED_RUNS && !startedAt.has(sessionId)) {
    const oldest = startedAt.keys().next()
    if (!oldest.done) startedAt.delete(oldest.value)
  }
  startedAt.set(sessionId, now)
}

/**
 * pending→real 绑定:把起始时刻迁到真实 id 上。绑定前后是同一次执行,不迁移的话
 * 退出行(以真实 id 落)就查不到起点,耗时会缺失。
 */
export function rebindRunStart(prevId: string, realId: string): void {
  if (prevId === realId) return
  const at = startedAt.get(prevId)
  if (at === undefined) return
  startedAt.delete(prevId)
  startedAt.set(realId, at)
}

/** 取出并清除一次 run 的耗时(ms);没有登记过则返回 `null`。 */
export function takeRunDuration(sessionId: string, now: number = Date.now()): number | null {
  const at = startedAt.get(sessionId)
  if (at === undefined) return null
  startedAt.delete(sessionId)
  return Math.max(0, now - at)
}

/** 测试钩子:清空登记表。 */
export function resetRunLogForTests(): void {
  startedAt.clear()
}

/** 身份信息的公共片段 —— 启动/退出/异常三种行共用同一套字段顺序。 */
function identityFields(id: RunLogIdentity): string {
  const parts = [
    `session=${id.sessionId}`,
    `kind=${id.sessionKind}/${id.runKind}`,
    `workspace=${id.workspacePath}`,
  ]
  if (id.agentId) parts.push(`agent=${id.agentId}`)
  if (id.vendor) parts.push(`vendor=${id.vendor}`)
  return parts.join(' ')
}

/** 启动行。 */
export function formatRunStarted(id: RunLogIdentity): string {
  return `[run] started ${identityFields(id)}`
}

/** 退出行 —— `reason` 为终态原因,`durationMs` 为空表示没有登记到起点。 */
export function formatRunSettled(
  id: RunLogIdentity,
  reason: string,
  durationMs: number | null,
): string {
  const duration = durationMs === null ? '' : ` duration=${formatDuration(durationMs)}`
  return `[run] settled reason=${reason}${duration} ${identityFields(id)}`
}

/**
 * 异常退出行 —— 与 `formatRunSettled` 分开:退出行讲「结束了、什么原因」,这一行
 * 讲「错在哪」,并单独带上 stack。`stage` 说明异常发生的阶段(如 `launch`、
 * `driver`、`chain-exhausted`)。
 */
export function formatRunFailed(id: RunLogIdentity, stage: string, err: unknown): string {
  return `[run] failed stage=${stage} ${identityFields(id)}: ${runErrMsg(err)}`
}

/** 打印启动行,并登记起始时刻。 */
export function logRunStarted(id: RunLogIdentity, now: number = Date.now()): void {
  noteRunStart(id.sessionId, now)
  console.log(formatRunStarted(id))
}

/**
 * 打印退出行。正常完成走 `console.log`;`error` 走 `console.error`,`aborted`
 * 走 `console.warn` —— 非正常退出在终端里要能一眼挑出来。
 */
export function logRunSettled(id: RunLogIdentity, reason: string, now: number = Date.now()): void {
  const line = formatRunSettled(id, reason, takeRunDuration(id.sessionId, now))
  if (reason === 'error') console.error(line)
  else if (reason === 'complete') console.log(line)
  else console.warn(line)
}

/** 打印异常退出日志(消息行 + stack)。 */
export function logRunFailure(id: RunLogIdentity, stage: string, err: unknown): void {
  console.error(formatRunFailed(id, stage, err))
  const detail = runErrDetail(err)
  // stack 已包含消息本身,消息与 stack 相同(无 stack 的非 Error)时不重复打印。
  if (detail !== runErrMsg(err)) console.error(detail)
}
