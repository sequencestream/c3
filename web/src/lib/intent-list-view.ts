/*
 * intent-list-view.ts — 需求列表面板的纯展示逻辑。
 *
 * 面板有展开/收缩两态:收缩态收窄面板宽度并隐藏次要字段(模块名、操作按钮),
 * 展开态恢复完整宽度并显示全部字段。此处只承载与折叠态相关的纯函数,
 * 便于在 Node 环境下单测(项目的 web 测试不含 DOM)。
 */

import type { DepType, Intent, IntentRunStatus, IntentStatus } from '@ccc/shared/protocol'
import { DATE_FORMATS, type DateStyleName } from './datetime-formats'

/** 状态中文标签。状态徽标(.req-status)直接用状态值作为 CSS 类映射语义色。 */
export const STATUS_LABELS: Record<IntentStatus, string> = {
  draft: 'Draft',
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  failed: 'Failed',
}

export function statusLabel(s: IntentStatus): string {
  return STATUS_LABELS[s] ?? s
}

/**
 * 派生运行态中文标签。仅 `in_progress` 状态的需求有非 `idle` 的运行态,
 * `idle` 不显示独立标签(由 `.req-status` 的「开发中」标签覆盖)。
 * - `running` → 绿色脉冲,表示 dev session 进程存活。
 * - `dangling` → 橙色警告,表示进程已死但需求尚未完成。
 * - `idle` → 空字符串,不渲染(默认态,包括已完成/未开始的需求)。
 */
export const RUN_STATUS_LABELS: Record<IntentRunStatus, string> = {
  running: 'Running',
  dangling: 'Interrupted',
  idle: '',
}

export function reqRunStatusLabel(s: IntentRunStatus): string {
  return RUN_STATUS_LABELS[s] ?? ''
}

/** 非 idle 的运行态才需要显示指示器。 */
export function showRunStatus(s: IntentRunStatus): boolean {
  return s === 'running' || s === 'dangling'
}

/** 标题栏切换按钮的文案与 title,反映「点击后将切换到的」目标态。 */
export interface ToggleLabel {
  icon: string
  text: string
  title: string
}

export function panelToggleLabel(collapsed: boolean): ToggleLabel {
  return collapsed
    ? {
        icon: '⇥',
        text: 'Expand',
        title: 'Expand the intent list (show module names and action buttons)',
      }
    : {
        icon: '⇤',
        text: 'Collapse',
        title:
          'Collapse the intent list (hide module names and action buttons to free up chat space)',
      }
}

/** 行内次要字段在当前折叠态下是否渲染。收缩态隐藏模块名与操作区。 */
export interface RowVisibility {
  showModule: boolean
  showActions: boolean
}

export function rowVisibility(collapsed: boolean): RowVisibility {
  return { showModule: !collapsed, showActions: !collapsed }
}

/**
 * 行内操作标识。展开态内联按钮与折叠态 kebab 下拉菜单共用此集合,
 * 由 {@link visibleIntentActions} 统一裁决可见性,杜绝两态分叉。
 * 顺序即渲染顺序,与 IntentList 模板内联按钮排布一致。
 */
export const INTENT_ROW_ACTIONS = [
  'refine',
  'startDev',
  'openSession',
  'markDone',
  'cancel',
  'createPr',
  'prLink',
  'automate',
] as const

export type IntentRowAction = (typeof INTENT_ROW_ACTIONS)[number]

/** 裁决行内操作可见性所需的最小字段集(便于测试轻量构造)。 */
export type IntentActionInput = Pick<Intent, 'status' | 'lastDevSessionId' | 'prId'>

/**
 * 单个意图行在当前状态下应显示哪些行内操作,按渲染顺序返回。
 * 条件沿用 IntentList 模板既有的 per-status 渲染规则:
 * - `refine`/`startDev` ← `todo`;`openSession` ← 有 `lastDevSessionId`;
 * - `markDone`/`cancel` ← 非终止态(非 done/cancelled);
 * - `createPr` ← `done` 且无 `prId`;`prLink` ← 有 `prId`;`automate` ← 恒显示。
 */
export function visibleIntentActions(r: IntentActionInput): IntentRowAction[] {
  const terminal = r.status === 'done' || r.status === 'cancelled'
  const out: IntentRowAction[] = []
  if (r.status === 'todo') out.push('refine', 'startDev')
  if (r.lastDevSessionId) out.push('openSession')
  if (!terminal) out.push('markDone', 'cancel')
  if (r.status === 'done' && !r.prId) out.push('createPr')
  if (r.prId) out.push('prLink')
  out.push('automate')
  return out
}

/** 已完成/已取消需求排序所需的最小字段集(便于在测试中轻量构造)。 */
export type CompletionOrderInput = Pick<Intent, 'completedAt' | 'updatedAt' | 'priority'>

/**
 * 终止态需求的比较器:完成/取消时间倒序为主键,优先级 P0→P3 为次键。
 * 时刻取 `completedAt`;`cancelled` 项无 `completedAt` 时回退到 `updatedAt`。
 * `priority` 为 `P0..P3`,字符串升序即优先级从高到低;`locale` 透传给 `localeCompare`,
 * 使次键排序随 UI 语言走(P0..P3 与 locale 无关,但保持本地化签名一致)。
 */
export function compareByCompletion(
  a: CompletionOrderInput,
  b: CompletionOrderInput,
  locale: string,
): number {
  const ta = a.completedAt ?? a.updatedAt
  const tb = b.completedAt ?? b.updatedAt
  if (ta !== tb) return tb - ta
  return a.priority.localeCompare(b.priority, locale)
}

/**
 * 「全部」视图下终止态项(done/cancelled)分批加载的每页条数。
 * 活跃项(draft/todo/in_progress)不分页、始终全显;此常量只约束终止态切片。
 */
export const TERMINAL_PAGE_SIZE = 10

/** 终止态切片结果:当前可见片段与是否还有未加载项。 */
export interface TerminatedSlice<T> {
  visible: T[]
  hasMore: boolean
}

/**
 * 取终止态列表的前 `visibleCount` 条用于渲染,并判断是否还有更多。
 * 纯函数:`visibleCount` 超过长度时 `slice` 自然截断,`hasMore` 随之为 `false`;
 * `visibleCount <= 0` 时返回空片段。供「加载更多 ↓」/「已加载完」UI 决策。
 */
export function sliceTerminated<T>(terminated: T[], visibleCount: number): TerminatedSlice<T> {
  const count = Math.max(0, visibleCount)
  return { visible: terminated.slice(0, count), hasMore: count < terminated.length }
}

/** 时刻格式化选项。`short` → MM/DD,`full` → YYYY-MM-DD HH:mm(默认)。 */
export interface FormatDateOpts {
  style?: 'short' | 'full'
}

/**
 * 将毫秒时间戳按 `locale` 本地化为可读日期字符串(经 `Intl.DateTimeFormat`)。
 * 预设取自 {@link DATE_FORMATS}(与 vue-i18n `datetimeFormats` 同源):
 *
 * - `short`: 月/日两位,排布随 locale(en `05/31`、ja `05/31`、ko `05. 31.`)。
 * - `full` (默认): 年月日 时:分(24h),排布随 locale。
 *
 * 纯函数,Node 单测环境亦可调用(Intl 内建)。
 */
export function formatDate(ms: number, locale: string, opts?: FormatDateOpts): string {
  const style: DateStyleName = opts?.style === 'short' ? 'short' : 'full'
  return new Intl.DateTimeFormat(locale, DATE_FORMATS[style]).format(ms)
}

/** 单项依赖的描述信息。 */
export interface DepInfo {
  id: string
  title: string
  done: boolean
  /** The dependency type; falls back to 'blocks' when absent. */
  depType: DepType
}

/**
 * 将需求的依赖 ID 列表解析为带标题、完成状态与 dep_type 的 DepInfo 数组。
 * 利用 `reqList` 查询依赖的标题与状态，`r.dependsOnTypes` 查询依赖类型。
 *
 * @returns 依赖数组；无依赖时返回空数组。
 */
export function formatDependsOn(r: Intent, reqList: Intent[]): DepInfo[] {
  if (!r.dependsOn.length) return []
  const byId = new Map(reqList.map((x) => [x.id, x]))
  const types = r.dependsOnTypes ?? {}
  return r.dependsOn.map((id) => {
    const dep = byId.get(id)
    return {
      id,
      title: dep?.title ?? id,
      done: dep?.status === 'done',
      depType: types[id] ?? 'blocks',
    }
  })
}
