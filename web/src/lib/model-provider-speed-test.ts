/**
 * 模型提供方测速在前端的共享视图状态与展示口径。
 *
 * 测速本身是服务端持有的执行:关掉对话框、切走页面、断线重连都不会停掉它,浏览器这一侧
 * 只是一个观察窗口。所以这里的状态全是「此刻看到了什么」,既不进 SystemSettings 草稿、
 * 也不落本地存储——它随连接作废,重新进入时靠向服务端问一次 active 复原。
 *
 * 展示口径只有一条规矩:**算出来的数不在这里重算**。服务端已按文档公式算好汇总,前端
 * 只负责舍入与「不可用」的呈现。null 一律显示本地化的「不可用」,绝不显示 0 或空白——
 * 把「没有成功样本」画成 0,读起来就成了「这个端点一个 token 都没产出」。
 */
import type {
  SpeedTestActiveRun,
  SpeedTestErrorCode,
  SpeedTestHistoryPage,
  SpeedTestHistoryProvider,
  SpeedTestRunDetail,
} from '@ccc/shared/protocol'

/** 一次测速对话框/报告面板的全部可见状态。 */
export interface SpeedTestUiState {
  /** 测速对话框归属的 provider;null=未打开。 */
  dialogProviderId: string | null
  /**
   * 报告面板是否打开。
   *
   * 与 `reportProviderId` 分开是因为「历史报告」总入口可以先打开、再挑提供方:
   * 把二者压成一个字段,就没法表达「面板开着但还没选中任何一条」。
   */
  reportOpen: boolean
  /** 报告面板当前查看的 provider;null=已打开但尚未选中。 */
  reportProviderId: string | null
  /**
   * 服务端此刻持有的那一轮(含进度);null=当前 provider 没有被持有的轮次。
   *
   * 「持有」不等于「正在跑」:`save_failed` 的轮次采样已经结束、只是没提交,服务端仍
   * 攥着它等 `retry_save`。它照样走这个字段,所以对话框不需要另记一份「未保存」状态
   * ——那一份会随对话框关闭、页面刷新一起消失,而重开对话框时会重新问一次 active。
   */
  active: SpeedTestActiveRun | null
  /** 刚刚收束并落库的结果,供对话框就地展示。 */
  lastResult: SpeedTestRunDetail | null
  /** 最近一次被服务端拒绝的原因;每次新动作前清空。 */
  error: SpeedTestErrorCode | null
  /** 报告列表当前页(累加加载更多后的全量)。 */
  history: SpeedTestHistoryPage | null
  /** 报告里展开的那一次的完整明细。 */
  detail: SpeedTestRunDetail | null
  /** 「历史报告」入口的 provider 候选,含已删除条目。 */
  historyProviders: SpeedTestHistoryProvider[] | null
  /** 有请求在途(拉列表/明细),用于按钮防抖与空态区分。 */
  loading: boolean
}

/** 初始状态:什么都没打开、什么都没查。 */
export function emptySpeedTestState(): SpeedTestUiState {
  return {
    dialogProviderId: null,
    reportOpen: false,
    reportProviderId: null,
    active: null,
    lastResult: null,
    error: null,
    history: null,
    detail: null,
    historyProviders: null,
    loading: false,
  }
}

/**
 * 服务端还攥着、只等一次重试提交的那一轮;null=没有待保存的结果。
 *
 * 判据取 `active` 快照自己的 state,而不是另存一份「收到过 save_failed」的标记:那一帧
 * 可能发给了一个已经关掉的对话框,或发在刷新之前。重开对话框会重新问一次 active,而
 * 服务端对未提交轮次的回答就是这个 state——恢复路径因此不依赖「当时在看」。
 */
export function pendingSaveRun(state: SpeedTestUiState): SpeedTestActiveRun | null {
  return state.active?.state === 'save_failed' ? state.active : null
}

/**
 * 毫秒指标的展示值:保留一位小数。`null` 返回 `null`,由调用方换成本地化的
 * 「不可用」——这里不产出任何可能被误读成「测到了 0」的字符串。
 */
export function formatMs(value: number | null): string | null {
  return value === null ? null : value.toFixed(1)
}

/** 速率(tokens/sec、requests/sec)的展示值:保留两位小数。 */
export function formatRate(value: number | null): string | null {
  return value === null ? null : value.toFixed(2)
}

/** 成功率的展示值:百分比、保留一位小数。 */
export function formatRate01(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(1)}%`
}

/**
 * 面板上抛给 App 的一次测速意图。
 *
 * 只用一条通道而不是十个 emit:这些动作全都属于同一件事,拆成十个事件只会让
 * SettingsPanel 变成一层纯转发的样板。判别联合保证每个分支只带自己需要的字段,
 * 不会退化成「什么都可选」的大对象。
 */
export type SpeedTestIntent =
  /** 打开某 provider 的测速对话框(随后由 App 问一次 active)。 */
  | { kind: 'open'; providerId: string }
  /** 关闭对话框。不停止服务端的执行。 */
  | { kind: 'close' }
  | {
      kind: 'start'
      providerId: string
      protocolType: 'openai' | 'anthropic'
      model: string
      requestCount: number
    }
  | { kind: 'interrupt'; runId: string }
  /** 收束了但没存下时,重试提交同一批样本(不重新调用上游)。 */
  | { kind: 'retrySave'; runId: string }
  | { kind: 'openReport'; providerId: string }
  | { kind: 'closeReport' }
  | { kind: 'selectRun'; runId: string }
  | { kind: 'loadMore'; providerId: string; offset: number }
  /** 拉「历史报告」总入口的候选(含已删除的 provider)。 */
  | { kind: 'listProviders' }
