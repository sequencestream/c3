/*
 * task-list.ts — dev session「当前 task 列表」的客户端入口。
 *
 * 纯推断模型(类型 / `applyTaskTool` / `isTaskTool` / `TASK_TOOL_NAMES` 等)已下沉至
 * `@ccc/shared/task-model`(server / web 单一 SoT,见 2026-06-07-009)。本文件 re-export 该模型,
 * 并保留**纯展示视图** `taskPanelView`(仅 web 使用,不进 wire)。
 *
 * 2026-06-07-009 起客户端转为消费服务端下发的 `task_*` wire 消息直接填充 `taskModel`,不再各自解析
 * `tool_result.content` 文本(派生统一在服务端 `emit()` 汇聚点)。
 */

export { TASK_TOOL_NAMES, isTaskTool, emptyTaskModel, applyTaskTool } from '@ccc/shared/task-model'
export type { TaskStatus, TaskItem, TaskListModel, TaskToolResult } from '@ccc/shared/task-model'

import type { TaskItem, TaskListModel } from '@ccc/shared/task-model'

/**
 * 实时任务面板的纯展示视图(不含 DOM)。把单一列表拆成三组并施加显隐 / 截断规则:
 * - 三组各按 `order` 升序;`inProgress` 置顶、`pending` 居中、`completed` 垫底(由调用方按此序渲染)。
 * - `completed` 只保留最近(`order` 最大)`recentCompleted` 笔(仍升序),其余计入 `hiddenCompleted`。
 * - `visible` 仅在存在任一 in_progress 或 pending 时为真;全部完成或空列表 → 隐藏整个面板。
 */
export interface TaskPanelView {
  visible: boolean
  inProgress: TaskItem[]
  pending: TaskItem[]
  /** 最近 `recentCompleted` 笔已完成,按 `order` 升序。 */
  completed: TaskItem[]
  /** 被截断、未展示的已完成数量(`< 0` 不会出现)。 */
  hiddenCompleted: number
}

export function taskPanelView(model: TaskListModel, recentCompleted = 2): TaskPanelView {
  const byOrder = [...model.tasks].sort((a, b) => a.order - b.order)
  const inProgress = byOrder.filter((t) => t.status === 'in_progress')
  const pending = byOrder.filter((t) => t.status === 'pending')
  const completedAll = byOrder.filter((t) => t.status === 'completed')
  // slice(-0) 会取整段,需显式守卫 recentCompleted <= 0 的情形。
  const completed = recentCompleted > 0 ? completedAll.slice(-recentCompleted) : []
  return {
    visible: inProgress.length > 0 || pending.length > 0,
    inProgress,
    pending,
    completed,
    hiddenCompleted: completedAll.length - completed.length,
  }
}
