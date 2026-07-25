<script setup lang="ts">
/*
 * IntentSessionPanel.vue — 三类会话 tab(intent / spec / work session)的内容面板。
 *
 * 沿用「单一活动会话」模型:仅在全局活动会话与期望 ID 对齐(chatReady)后渲染 ChatColumn,
 * 避免串台;期望 ID 为空的意图会话首轮渲染首条输入框(firstIntentTurn)。打开会话本身由容器
 * (Tab 状态机)统一补发,本面板不持有活动会话,只做渲染与事件透传。
 */
import { ref } from 'vue'
import type {
  CodexPolicy,
  ModeToken,
  PromptImage,
  SessionAgentSwitch,
  VendorId,
} from '@ccc/shared/protocol'
import type { PendingItem } from '../../../../lib/pending-queue'
import type { TaskListModel } from '../../../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../../../lib/chat-types'
import { useTypedI18n } from '@/i18n'
import ChatColumn from '../../../../components/ChatColumn/ChatColumn.vue'
import type { DetailTab } from './useIntentDetailTabs'

const { t } = useTypedI18n()

defineProps<{
  activeTab: DetailTab
  expectedSessionId: string | null
  chatReady: boolean
  firstIntentTurn: boolean
  intentTitle: string
  activeTitle: string
  modeLocked: boolean
  vendor?: VendorId | null
  agentSwitch?: SessionAgentSwitch | null
  hasActiveSession: boolean
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  hasTaskStore?: boolean
  running: boolean
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  currentAgentName?: string
  reconnecting?: boolean
  sideEffectPending?: boolean
  queue: PendingItem[]
  availableCommands: import('@ccc/shared/protocol').SlashCommandInfo[]
  voiceLang: string
  mode?: ModeToken
  codexPolicy?: CodexPolicy | null
  modeOptions?: { value: ModeToken; label: string }[]
}>()

const emit = defineEmits<{
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
  'set-session-agent': [agentId: string]
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
  refresh: []
  'edit-queued': [item: PendingItem]
  'delete-queued': [id: number]
  submit: [text: string, images: PromptImage[]]
  enqueue: [text: string, images: PromptImage[]]
  stop: []
  continue: []
  'list-commands': []
}>()

const chatColumn = ref<InstanceType<typeof ChatColumn> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => chatColumn.value?.prefill(text, images),
})
</script>

<template>
  <p
    v-if="!expectedSessionId && activeTab !== 'intentSession'"
    class="intent-detail-empty"
    :data-testid="
      activeTab === 'workSession'
        ? 'intent-detail-work-session-empty'
        : 'intent-detail-spec-session-empty'
    "
  >
    {{
      activeTab === 'workSession' ? t('intent.workSession.empty') : t('intent.specSession.empty')
    }}
  </p>
  <p v-else-if="!chatReady && !firstIntentTurn" class="intent-detail-empty">
    {{ t('intent.chat.loading') }}
  </p>
  <ChatColumn
    v-else
    ref="chatColumn"
    data-testid="intent-detail-chat"
    :active-title="firstIntentTurn ? intentTitle : activeTitle"
    :vendor="vendor"
    :agent-switch="agentSwitch"
    :show-mode="true"
    :mode="mode"
    :codex-policy="codexPolicy"
    :mode-options="modeOptions"
    :mode-disabled="modeLocked"
    :always-title="true"
    :has-active-session="firstIntentTurn ? true : hasActiveSession"
    :messages="firstIntentTurn ? [] : messages"
    :actionable-permission-id="actionablePermissionId"
    :task-model="taskModel"
    :has-task-store="hasTaskStore"
    :running="firstIntentTurn ? false : running"
    :team-active="firstIntentTurn ? false : teamActive"
    :connection="connection"
    :activity="activity"
    :current-agent-name="currentAgentName"
    :reconnecting="reconnecting"
    :side-effect-pending="sideEffectPending"
    :queue="firstIntentTurn ? [] : queue"
    :available-commands="availableCommands"
    :voice-lang="voiceLang"
    @set-mode="(m: ModeToken) => emit('set-mode', m)"
    @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
    @set-session-agent="(id: string) => emit('set-session-agent', id)"
    @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
    @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
    @refresh="emit('refresh')"
    @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
    @delete-queued="(id: number) => emit('delete-queued', id)"
    @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
    @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
    @stop="emit('stop')"
    @continue="emit('continue')"
    @list-commands="emit('list-commands')"
  />
</template>
