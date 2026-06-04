<script setup lang="ts">
/*
 * Schedules.vue — 定时任务页容器。
 *
 * 纯容器:左侧列表 + 右侧详情 + 创建/编辑表单弹窗装配。所有数据(列表/详情/
 * 日志/transcript)与弹窗开关状态由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 */
import ScheduleList from './components/ScheduleList/ScheduleList.vue'
import ScheduleDetail from './components/ScheduleDetail/ScheduleDetail.vue'
import ScheduleForm from './components/ScheduleForm/ScheduleForm.vue'
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleExecutionLog,
  TranscriptItem,
  UpdateScheduleInput,
} from '@ccc/shared/protocol'

defineProps<{
  schedules: Schedule[]
  activeId: string | null
  schedule: Schedule | null
  logs: ScheduleExecutionLog[]
  transcripts: Record<string, TranscriptItem[]>
  formOpen: boolean
  formTarget: Schedule | null
  workspacePath: string
  /** System IANA time zone the cron next-run preview is computed in. */
  timezone: string
}>()

defineEmits<{
  select: [id: string]
  'open-form': [target: Schedule | null]
  'toggle-enabled': [id: string, enabled: boolean]
  'load-session': [executionId: string]
  'close-form': []
  create: [input: CreateScheduleInput]
  update: [id: string, input: UpdateScheduleInput]
}>()
</script>

<template>
  <ScheduleList
    :schedules="schedules"
    :active-id="activeId"
    :timezone="timezone"
    @select="(id: string) => $emit('select', id)"
    @new-schedule="$emit('open-form', null)"
    @toggle-enabled="(id: string, enabled: boolean) => $emit('toggle-enabled', id, enabled)"
  />

  <div class="content">
    <!-- Schedules tab: the right pane shows the selected schedule's execution
         logs. (Create/Edit entry points live in the left list.) -->
    <ScheduleDetail
      :schedule="schedule"
      :logs="logs"
      :transcripts="transcripts"
      @load-session="(executionId: string) => $emit('load-session', executionId)"
    />
  </div>

  <ScheduleForm
    :open="formOpen"
    :schedule="formTarget"
    :workspace-path="workspacePath"
    :timezone="timezone"
    @close="$emit('close-form')"
    @create="(input: CreateScheduleInput) => $emit('create', input)"
    @update="(id: string, input: UpdateScheduleInput) => $emit('update', id, input)"
  />
</template>
