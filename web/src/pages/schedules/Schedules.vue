<script setup lang="ts">
/*
 * Schedules.vue — 定时任务页容器。
 *
 * 两栏布局:左栏 ScheduleList(纯选择列表)+ 右栏 ScheduleDetailPanel(常驻标题栏 +
 * 「详情/历史」Tab,历史经弹框选执行)+ 创建/编辑表单弹窗。所有数据(列表/日志/
 * transcript)与弹窗开关状态由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 */
import { computed } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import ScheduleList from './components/ScheduleList/ScheduleList.vue'
import ScheduleDetailPanel from './components/ScheduleDetailPanel/ScheduleDetailPanel.vue'
import ScheduleForm from './components/ScheduleForm/ScheduleForm.vue'
import type {
  CreateScheduleInput,
  AgentConfig,
  Schedule,
  ScheduleExecutionLog,
  ToolManifestEntry,
  TranscriptItem,
  UpdateScheduleInput,
  VendorHostStatus,
} from '@ccc/shared/protocol'

const props = defineProps<{
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
  /** 当前选中的执行 ID(历史 Tab 选中态) */
  executionId: string | null
  /** 当前选中的执行对象 */
  execution: ScheduleExecutionLog | null
  /** Tool manifest for schedule form (cached per vendor). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  /** Per-vendor host-CLI presence (for greying absent vendors). */
  hostStatus: VendorHostStatus[]
  agents: AgentConfig[]
}>()

const emit = defineEmits<{
  select: [id: string]
  'open-form': [target: Schedule | null]
  'new-from-template': [templateId: string]
  'delete-schedule': [id: string]
  'toggle-enabled': [id: string, enabled: boolean]
  'run-now': [id: string]
  'load-session': [executionId: string]
  'select-execution': [id: string]
  'close-form': []
  create: [input: CreateScheduleInput]
  update: [id: string, input: UpdateScheduleInput]
  'load-tool-manifest': [vendor: string]
  'mobile-back': [targetKey: string]
}>()

const mobilePanes = [
  { key: 'schedules', title: 'Schedules' },
  { key: 'detail', title: 'Detail' },
] as const

const mobileActiveKey = computed(() => (props.activeId ? 'detail' : 'schedules'))
const mobileActiveToken = computed(() => props.activeId ?? 'schedules')
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Back"
    @back="(targetKey: string) => emit('mobile-back', targetKey)"
  >
    <template #schedules>
      <ScheduleList
        :schedules="schedules"
        :active-id="activeId"
        @select="(id: string) => emit('select', id)"
        @new-schedule="emit('open-form', null)"
        @new-from-template="(templateId: string) => emit('new-from-template', templateId)"
      />
    </template>

    <template #detail>
      <ScheduleDetailPanel
        :schedule="schedule"
        :tool-manifest="toolManifest"
        :agents="agents"
        :logs="logs"
        :execution-id="executionId"
        :execution="execution"
        :transcripts="transcripts"
        @delete-schedule="(id: string) => emit('delete-schedule', id)"
        @toggle-enabled="(id: string, enabled: boolean) => emit('toggle-enabled', id, enabled)"
        @run-now="(id: string) => emit('run-now', id)"
        @select-execution="(id: string) => emit('select-execution', id)"
        @load-session="(executionId: string) => emit('load-session', executionId)"
      />
    </template>
  </MobileStack>

  <ScheduleForm
    :open="formOpen"
    :schedule="formTarget"
    :workspace-path="workspacePath"
    :timezone="timezone"
    :tool-manifest="toolManifest"
    :tool-manifest-loading="toolManifestLoading"
    :tool-manifest-error="toolManifestError"
    :host-status="hostStatus"
    :agents="agents"
    @close="emit('close-form')"
    @create="(input: CreateScheduleInput) => emit('create', input)"
    @update="(id: string, input: UpdateScheduleInput) => emit('update', id, input)"
    @load-tool-manifest="(vendor: string) => emit('load-tool-manifest', vendor)"
  />
</template>
