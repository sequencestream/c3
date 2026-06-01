/*
 * req-list-view.ts — 需求列表面板的纯展示逻辑。
 *
 * 面板有展开/收缩两态:收缩态收窄面板宽度并隐藏次要字段(模块名、操作按钮),
 * 展开态恢复完整宽度并显示全部字段。此处只承载与折叠态相关的纯函数,
 * 便于在 Node 环境下单测(项目的 web 测试不含 DOM)。
 */

import type { Requirement, RequirementRunStatus, RequirementStatus } from '@ccc/shared/protocol'

/** 状态中文标签。状态徽标(.req-status)直接用状态值作为 CSS 类映射语义色。 */
export const STATUS_LABELS: Record<RequirementStatus, string> = {
  draft: 'Draft',
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function statusLabel(s: RequirementStatus): string {
  return STATUS_LABELS[s] ?? s
}

/**
 * 派生运行态中文标签。仅 `in_progress` 状态的需求有非 `idle` 的运行态,
 * `idle` 不显示独立标签(由 `.req-status` 的「开发中」标签覆盖)。
 * - `running` → 绿色脉冲,表示 dev session 进程存活。
 * - `dangling` → 橙色警告,表示进程已死但需求尚未完成。
 * - `idle` → 空字符串,不渲染(默认态,包括已完成/未开始的需求)。
 */
export const RUN_STATUS_LABELS: Record<RequirementRunStatus, string> = {
  running: 'Running',
  dangling: 'Interrupted',
  idle: '',
}

export function reqRunStatusLabel(s: RequirementRunStatus): string {
  return RUN_STATUS_LABELS[s] ?? ''
}

/** 非 idle 的运行态才需要显示指示器。 */
export function showRunStatus(s: RequirementRunStatus): boolean {
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
        title: 'Expand the requirement list (show module names and action buttons)',
      }
    : {
        icon: '⇤',
        text: 'Collapse',
        title:
          'Collapse the requirement list (hide module names and action buttons to free up chat space)',
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

/** 已完成/已取消需求排序所需的最小字段集(便于在测试中轻量构造)。 */
export type CompletionOrderInput = Pick<Requirement, 'completedAt' | 'updatedAt' | 'priority'>

/**
 * 终止态需求的比较器:完成/取消时间倒序为主键,优先级 P0→P3 为次键。
 * 时刻取 `completedAt`;`cancelled` 项无 `completedAt` 时回退到 `updatedAt`。
 * `priority` 为 `P0..P3`,字符串升序即优先级从高到低,直接 localeCompare 即可。
 */
export function compareByCompletion(a: CompletionOrderInput, b: CompletionOrderInput): number {
  const ta = a.completedAt ?? a.updatedAt
  const tb = b.completedAt ?? b.updatedAt
  if (ta !== tb) return tb - ta
  return a.priority.localeCompare(b.priority)
}

/** 时刻格式化选项。`short` → MM/DD,`full` → YYYY-MM-DD HH:mm(默认)。 */
export interface FormatDateOpts {
  style?: 'short' | 'full'
}

/**
 * 将毫秒时间戳格式化为可读日期字符串。
 *
 * - `short`: `MM/DD` 风格，月日补零两位，与现有行内日期前缀一致。
 * - `full` (默认): `YYYY-MM-DD HH:mm` 完整格式，用于元信息区。
 */
export function formatDate(ms: number, opts?: FormatDateOpts): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (opts?.style === 'short') {
    return `${mo}/${dd}`
  }
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${dd} ${h}:${mi}`
}

/** 单项依赖的描述信息。 */
export interface DepInfo {
  id: string
  title: string
  done: boolean
}

/**
 * 将需求的依赖 ID 列表解析为带标题与完成状态的 DepInfo 数组。
 * 利用 `reqList` 查询依赖的标题与状态。
 *
 * @returns 依赖数组；无依赖时返回空数组。
 */
export function formatDependsOn(r: Requirement, reqList: Requirement[]): DepInfo[] {
  if (!r.dependsOn.length) return []
  const byId = new Map(reqList.map((x) => [x.id, x]))
  return r.dependsOn.map((id) => {
    const dep = byId.get(id)
    return { id, title: dep?.title ?? id, done: dep?.status === 'done' }
  })
}
