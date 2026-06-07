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
import { taskPanelView, type TaskListModel } from '../../lib/task-list'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    model: TaskListModel
    /**
     * Whether the active vendor exposes the SDK task surface (`taskStore`). A vendor
     * without it never derives a task list, so the panel stays hidden. Defaults to
     * `true` so older sessions / unknown vendors degrade open, never wrongly suppressed.
     */
    hasTaskStore?: boolean
  }>(),
  { hasTaskStore: true },
)

const view = computed(() => taskPanelView(props.model))
</script>

<template>
  <div
    v-if="hasTaskStore && view.visible"
    class="task-panel"
    :aria-label="t('session.task.ariaLabel')"
  >
    <div
      v-for="task in view.inProgress"
      :key="task.id"
      class="task-row task-active"
      :title="task.description"
    >
      <span class="task-mark">▶</span>
      <span class="task-subject">{{ task.subject }}</span>
    </div>
    <div
      v-for="task in view.pending"
      :key="task.id"
      class="task-row task-pending"
      :title="task.description"
    >
      <span class="task-mark">○</span>
      <span class="task-subject">{{ task.subject }}</span>
    </div>
    <div
      v-for="task in view.completed"
      :key="task.id"
      class="task-row task-done"
      :title="task.description"
    >
      <span class="task-mark">✓</span>
      <span class="task-subject">{{ task.subject }}</span>
    </div>
    <div v-if="view.hiddenCompleted > 0" class="task-more" data-testid="task-more-completed">
      {{ t('session.task.moreCompleted', { count: view.hiddenCompleted }) }}
    </div>
  </div>
</template>
