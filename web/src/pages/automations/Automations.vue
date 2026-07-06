<script setup lang="ts">
/*
 * Automations.vue — 自动化页容器。
 *
 * 两栏布局:左栏 AutomationList(纯选择列表)+ 右栏 AutomationDetailPanel(常驻标题栏 +
 * 「详情/历史」Tab,历史经弹框选执行)+ 创建/编辑表单弹窗。所有数据(列表/日志/
 * transcript)与弹窗开关状态由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 */
import { computed } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import AutomationList from './components/AutomationList/AutomationList.vue'
import AutomationDetailPanel from './components/AutomationDetailPanel/AutomationDetailPanel.vue'
import AutomationForm from './components/AutomationForm/AutomationForm.vue'
import type {
  CreateAutomationInput,
  AgentConfig,
  Automation,
  AutomationExecutionLog,
  ClientToServer,
  ToolManifestEntry,
  TranscriptItem,
  UpdateAutomationInput,
  VendorHostStatus,
} from '@ccc/shared/protocol'

/** The simulate-trigger payload (client message minus its `type` tag). */
type SimulateInput = Omit<Extract<ClientToServer, { type: 'simulate_automation_trigger' }>, 'type'>

const props = defineProps<{
  automations: Automation[]
  activeId: string | null
  automation: Automation | null
  logs: AutomationExecutionLog[]
  transcripts: Record<string, TranscriptItem[]>
  formOpen: boolean
  formTarget: Automation | null
  workspacePath: string
  /** System IANA time zone the cron next-run preview is computed in. */
  timezone: string
  /** 当前选中的执行 ID(历史 Tab 选中态) */
  executionId: string | null
  /** 当前选中的执行对象 */
  execution: AutomationExecutionLog | null
  /** Tool manifest for automation form (cached per vendor). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  /** Per-vendor host-CLI presence (for greying absent vendors). */
  hostStatus: VendorHostStatus[]
  agents: AgentConfig[]
  /** System-configured default agent for the new-automation form (AC-R25). */
  automationAgentId: string
  /** System default agent, the follow-chain fallback for `automationAgentId`. */
  defaultAgentId: string
  /** 最近一次模拟触发的结果(null=尚未运行)。 */
  simulationResult: {
    automationId: string
    matched: boolean
    breakdown: { name: string; passed: boolean }[]
  } | null
}>()

const emit = defineEmits<{
  select: [id: string]
  'open-form': [target: Automation | null]
  'new-from-template': [templateId: string]
  'delete-automation': [id: string]
  'toggle-enabled': [id: string, enabled: boolean]
  'run-now': [id: string]
  'load-session': [executionId: string]
  'select-execution': [id: string]
  'close-form': []
  create: [input: CreateAutomationInput]
  update: [id: string, input: UpdateAutomationInput]
  'load-tool-manifest': [vendor: string]
  'mobile-back': [targetKey: string]
  simulate: [input: SimulateInput]
}>()

const mobilePanes = [
  { key: 'automations', title: 'Automations' },
  { key: 'detail', title: 'Detail' },
] as const

const mobileActiveKey = computed(() => (props.activeId ? 'detail' : 'automations'))
const mobileActiveToken = computed(() => props.activeId ?? 'automations')
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Back"
    @back="(targetKey: string) => emit('mobile-back', targetKey)"
  >
    <template #automations>
      <AutomationList
        :automations="automations"
        :active-id="activeId"
        @select="(id: string) => emit('select', id)"
        @new-automation="emit('open-form', null)"
        @new-from-template="(templateId: string) => emit('new-from-template', templateId)"
      />
    </template>

    <template #detail>
      <AutomationDetailPanel
        :automation="automation"
        :tool-manifest="toolManifest"
        :agents="agents"
        :logs="logs"
        :execution-id="executionId"
        :execution="execution"
        :transcripts="transcripts"
        :simulation-result="simulationResult"
        @delete-automation="(id: string) => emit('delete-automation', id)"
        @edit-automation="(id: string) => emit('open-form', automation)"
        @toggle-enabled="(id: string, enabled: boolean) => emit('toggle-enabled', id, enabled)"
        @run-now="(id: string) => emit('run-now', id)"
        @select-execution="(id: string) => emit('select-execution', id)"
        @load-session="(executionId: string) => emit('load-session', executionId)"
        @simulate="(input: SimulateInput) => emit('simulate', input)"
      />
    </template>
  </MobileStack>

  <AutomationForm
    :open="formOpen"
    :automation="formTarget"
    :workspace-path="workspacePath"
    :timezone="timezone"
    :tool-manifest="toolManifest"
    :tool-manifest-loading="toolManifestLoading"
    :tool-manifest-error="toolManifestError"
    :host-status="hostStatus"
    :agents="agents"
    :automation-agent-id="automationAgentId"
    :default-agent-id="defaultAgentId"
    @close="emit('close-form')"
    @create="(input: CreateAutomationInput) => emit('create', input)"
    @update="(id: string, input: UpdateAutomationInput) => emit('update', id, input)"
    @load-tool-manifest="(vendor: string) => emit('load-tool-manifest', vendor)"
  />
</template>
