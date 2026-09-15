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
import type { LocaleKey } from '@/i18n'
import type {
  SpeedTestActiveRun,
  SpeedTestComparisonEntry,
  SpeedTestErrorCode,
  SpeedTestHistoryPage,
  SpeedTestHistoryProvider,
  SpeedTestRun,
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
  /**
   * 横向对比视图是否打开。
   *
   * 与单提供方报告并列而不是塞进它里面:报告的口径是「这一条的历史」,对比的口径是
   * 「几条之间选谁」,两者共用一个面板只会让面板同时说两件互相矛盾的话。
   */
  compareOpen: boolean
  /** 对比视图的取数(每个有记录的 provider 一条,各带最近若干轮);null=尚未取。 */
  compare: SpeedTestComparisonEntry[] | null
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
    compareOpen: false,
    compare: null,
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
 * 服务端每个拒绝原因对应哪条文案,单一来源。
 *
 * 对话框与对比视图都会渲染这些码,各写一份 switch 迟早会出现同一句拒绝在两处说法不同
 * ——读起来就像两件不同的事。表是 `Record<SpeedTestErrorCode, LocaleKey>`,协议新增一个
 * 码而这里没跟上会在 vue-tsc 阶段直接编译失败,不会静默漏掉一句。
 */
export const SPEED_TEST_ERROR_KEYS: Record<SpeedTestErrorCode, LocaleKey> = {
  invalid_count: 'settings.providers.speedTest.error.invalidCount',
  provider_unknown: 'settings.providers.speedTest.error.providerUnknown',
  protocol_unavailable: 'settings.providers.speedTest.error.protocolUnavailable',
  invalid_url: 'settings.providers.speedTest.error.invalidUrl',
  models_empty: 'settings.providers.speedTest.error.modelsEmpty',
  model_unavailable: 'settings.providers.speedTest.error.modelUnavailable',
  busy: 'settings.providers.speedTest.error.busy',
  not_found: 'settings.providers.speedTest.error.notFound',
  db_unavailable: 'settings.providers.speedTest.error.dbUnavailable',
  save_failed: 'settings.providers.speedTest.error.saveFailed',
}

// ---- 跨提供方横向对比 ----

/** 对比行:一个 provider 加上它参与对比的那一轮。 */
export interface SpeedTestComparisonRow {
  providerId: string
  displayName: string
  /** 该 provider 是否仍在配置里;false 时调用方标注「已删除」。 */
  present: boolean
  /** 记录总数,可能多于 `choices`(视图只带最近若干轮)。 */
  runCount: number
  /** 本行可切换的轮次,最近一次在前。 */
  choices: SpeedTestRun[]
  /** 本行实际参与对比的那一轮。 */
  run: SpeedTestRun
}

/** 对比视图的排序方向。 */
export type SpeedTestCompareDirection = 'asc' | 'desc'

/**
 * 排序用的 TTFT P50。
 *
 * 只认有限数:`summary` 经网络而来,是按声明而非校验得来的类型;一个整体失败的轮次
 * 样本数为 0、P50 本就是 null,而畸形值若当成 0 参与比较,会把它排到最快那端——
 * 「没测到」于是被排成「最快」,正是这个视图最不该犯的错。读不出来的值一律按
 * 「不可用」处理,排序时恒排在最后。
 */
function ttftP50Of(run: SpeedTestRun): number | null {
  const value = run.summary?.ttft?.p50Ms
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 展示名的兜底比较:码点序,不依赖宿主 locale,同一份数据在哪台机器上都排一样。 */
function byNameThenId(a: SpeedTestComparisonRow, b: SpeedTestComparisonRow): number {
  if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1
  return 0
}

/**
 * 把服务端的对比取数摊成表格行:挑出每一行参与对比的那一轮,并按 TTFT P50 排序。
 *
 * 两条规则值得单独说清:
 *  - **选取**。`selection[providerId]` 命中该 provider 的备选就用它,否则回退到备选里的
 *    第一条(即最近一次)。落空是正常路径而不是异常:选择是面板本地的,重开面板、换一台
 *    浏览器、或某条记录被清掉之后,记着的 runId 都可能已经不在备选里——此时该做的是回到
 *    「最近一次」,而不是让整张表消失。
 *  - **排序**。TTFT P50 升序或降序,P50 不可用的行**恒排在最后**:方向反转的是「谁更快」,
 *    不是「谁没测到」;把不可用行跟着翻到最前面,读起来就成了「它最慢」或「它最快」,
 *    两个都是没测到的事实说不出来的话。同值时按展示名、再按 providerId 定序,排序结果
 *    因此与输入顺序、与浏览器无关。
 *
 * 只做选取与排序,不重算任何指标:汇总是服务端按公式算好的,这里只读。
 */
export function buildComparisonRows(
  entries: readonly SpeedTestComparisonEntry[],
  selection: Readonly<Record<string, string>> = {},
  direction: SpeedTestCompareDirection = 'asc',
): SpeedTestComparisonRow[] {
  const rows: SpeedTestComparisonRow[] = []
  for (const entry of entries) {
    const choices = entry.runs ?? []
    if (choices.length === 0) continue
    const wanted = selection[entry.providerId]
    const run = (wanted ? choices.find((r) => r.runId === wanted) : undefined) ?? choices[0]!
    rows.push({
      providerId: entry.providerId,
      displayName: entry.displayName,
      present: entry.present,
      runCount: entry.runCount,
      choices: [...choices],
      run,
    })
  }

  return rows.sort((a, b) => {
    const left = ttftP50Of(a.run)
    const right = ttftP50Of(b.run)
    // 不可用恒在最后,与方向无关;两边都不可用时交给兜底比较键。
    if (left === null || right === null) {
      if (left === null && right === null) return byNameThenId(a, b)
      return left === null ? 1 : -1
    }
    if (left !== right) return direction === 'asc' ? left - right : right - left
    return byNameThenId(a, b)
  })
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
  /** 打开跨提供方对比视图(随后由 App 拉一次 compare)。 */
  | { kind: 'openCompare' }
  | { kind: 'closeCompare' }
