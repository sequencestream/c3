<script setup lang="ts">
/*
 * TaskPanel.vue — ChatMessages 与 SessionStatusBar 之间的常驻实时任务面板。
 *
 * 只读可视化:展示当前 session 由 task 工具推断出的任务列表(in_progress 置顶高亮、
 * pending 居中、completed 垫底打勾置灰)。数据来自客户端推断模型 `TaskListModel`,
 * 排序 / 截断 / 显隐全交给纯 selector `taskPanelView`(见 lib/task-list.ts)。用户不
 * 在此编辑 task;聊天日志里 task 工具原有的 tool_use/tool_result 行另行保留为历史。
 */
import { computed } from 'vue'
import { taskPanelView, type TaskListModel } from '../lib/task-list'

const props = defineProps<{ model: TaskListModel }>()

const view = computed(() => taskPanelView(props.model))
</script>

<template>
  <div v-if="view.visible" class="task-panel" aria-label="当前任务">
    <div
      v-for="t in view.inProgress"
      :key="t.id"
      class="task-row task-active"
      :title="t.description"
    >
      <span class="task-mark">▶</span>
      <span class="task-subject">{{ t.subject }}</span>
    </div>
    <div v-for="t in view.pending" :key="t.id" class="task-row task-pending" :title="t.description">
      <span class="task-mark">○</span>
      <span class="task-subject">{{ t.subject }}</span>
    </div>
    <div v-for="t in view.completed" :key="t.id" class="task-row task-done" :title="t.description">
      <span class="task-mark">✓</span>
      <span class="task-subject">{{ t.subject }}</span>
    </div>
    <div v-if="view.hiddenCompleted > 0" class="task-more">+{{ view.hiddenCompleted }} 已完成</div>
  </div>
</template>
