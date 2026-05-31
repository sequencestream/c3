/*
 * req-list-view.ts — 需求列表面板的纯展示逻辑。
 *
 * 面板有展开/收缩两态:收缩态收窄面板宽度并隐藏次要字段(模块名、操作按钮),
 * 展开态恢复完整宽度并显示全部字段。此处只承载与折叠态相关的纯函数,
 * 便于在 Node 环境下单测(项目的 web 测试不含 DOM)。
 */

import type { Requirement, RequirementStatus } from '@ccc/shared/protocol'

/** 状态中文标签。状态徽标(.req-status)直接用状态值作为 CSS 类映射语义色。 */
export const STATUS_LABELS: Record<RequirementStatus, string> = {
  draft: '草稿',
  todo: '未开始',
  in_progress: '开发中',
  done: '已完成',
  cancelled: '已取消',
}

export function statusLabel(s: RequirementStatus): string {
  return STATUS_LABELS[s] ?? s
}

/** 标题栏切换按钮的文案与 title,反映「点击后将切换到的」目标态。 */
export interface ToggleLabel {
  icon: string
  text: string
  title: string
}

export function panelToggleLabel(collapsed: boolean): ToggleLabel {
  return collapsed
    ? { icon: '⇥', text: '展开', title: '展开需求列表(显示模块名与操作按钮)' }
    : { icon: '⇤', text: '收起', title: '收起需求列表(隐藏模块名与操作按钮,腾出聊天空间)' }
}

/** 行内次要字段在当前折叠态下是否渲染。收缩态隐藏模块名与操作区。 */
export interface RowVisibility {
  showModule: boolean
  showActions: boolean
}

export function rowVisibility(collapsed: boolean): RowVisibility {
  return { showModule: !collapsed, showActions: !collapsed }
}

/** 已完成需求排序所需的最小字段集(便于在测试中轻量构造)。 */
export type CompletionOrderInput = Pick<Requirement, 'completedAt' | 'createdAt' | 'priority'>

/**
 * 已完成需求的比较器:完成时间倒序为主键,优先级 P0→P3 为次键。
 * 完成时刻取 `completedAt`,缺失(历史数据)时回退到 `createdAt`。
 * `priority` 为 `P0..P3`,字符串升序即优先级从高到低,直接 localeCompare 即可。
 */
export function compareByCompletion(a: CompletionOrderInput, b: CompletionOrderInput): number {
  const ta = a.completedAt ?? a.createdAt
  const tb = b.completedAt ?? b.createdAt
  if (ta !== tb) return tb - ta
  return a.priority.localeCompare(b.priority)
}
