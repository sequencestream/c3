<script setup lang="ts">
/*
 * Schedules.vue — 定时任务页容器。
 *
 * 三栏布局:左栏 ScheduleList + 中栏执行历史列表 + 右栏 Tab 化执行详情 +
 * 创建/编辑表单弹窗。所有数据(列表/日志/transcript)与弹窗开关状态由 App.vue
 * 持有,经 props 注入;用户动作经 emit 上抛。
 */
import ScheduleList from './components/ScheduleList/ScheduleList.vue'
import ExecutionHistoryList from './components/ExecutionHistoryList/ExecutionHistoryList.vue'
import ScheduleDetail from './components/ScheduleDetail/ScheduleDetail.vue'
import ExecutionDetail from './components/ExecutionDetail/ExecutionDetail.vue'
import ScheduleForm from './components/ScheduleForm/ScheduleForm.vue'
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleExecutionLog,
  ToolManifestEntry,
  TranscriptItem,
  UpdateScheduleInput,
  VendorHostStatus,
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
  /** 当前选中的执行 ID(第二级选中态) */
  executionId: string | null
  /** 当前选中的执行对象 */
  execution: ScheduleExecutionLog | null
  /** Tool manifest for schedule form (cached per vendor). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  /** Per-vendor host-CLI presence (for greying absent vendors). */
  hostStatus: VendorHostStatus[]
}>()

defineEmits<{
  select: [id: string]
  'open-form': [target: Schedule | null]
  'toggle-enabled': [id: string, enabled: boolean]
  'load-session': [executionId: string]
  'select-execution': [id: string]
  'close-form': []
  create: [input: CreateScheduleInput]
  update: [id: string, input: UpdateScheduleInput]
  'load-tool-manifest': [vendor: string]
}>()
</script>

<template>
  <ScheduleList
    :schedules="schedules"
    :active-id="activeId"
    :timezone="timezone"
    @select="(id: string) => $emit('select', id)"
    @new-schedule="$emit('open-form', null)"
    @edit-schedule="(s: Schedule) => $emit('open-form', s)"
    @toggle-enabled="(id: string, enabled: boolean) => $emit('toggle-enabled', id, enabled)"
  />

  <ExecutionHistoryList
    :schedule="schedule"
    :logs="logs"
    :active-execution-id="executionId"
    @select-execution="(id: string) => $emit('select-execution', id)"
  />

  <ScheduleDetail
    v-if="schedule && !execution"
    :schedule="schedule"
    :tool-manifest="toolManifest"
  />
  <ExecutionDetail
    v-else
    :execution="execution"
    :execution-type="schedule?.type ?? null"
    :transcripts="transcripts"
    @load-session="(executionId: string) => $emit('load-session', executionId)"
  />

  <ScheduleForm
    :open="formOpen"
    :schedule="formTarget"
    :workspace-path="workspacePath"
    :timezone="timezone"
    :tool-manifest="toolManifest"
    :tool-manifest-loading="toolManifestLoading"
    :tool-manifest-error="toolManifestError"
    :host-status="hostStatus"
    @close="$emit('close-form')"
    @create="(input: CreateScheduleInput) => $emit('create', input)"
    @update="(id: string, input: UpdateScheduleInput) => $emit('update', id, input)"
    @load-tool-manifest="(vendor: string) => $emit('load-tool-manifest', vendor)"
  />
</template>
