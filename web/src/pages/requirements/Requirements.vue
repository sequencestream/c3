<script setup lang="ts">
/*
 * Requirements.vue — 需求页容器。
 *
 * 纯容器:左侧需求列表 + 右侧聊天列(需求 comm session 即被查看的会话,故复用与
 * 会话页相同的聊天列;标题栏为需求变体,无权限模式下拉)。状态/连接由 App.vue 持有,
 * 经 props 注入,动作经 emit 上抛。composer ref 经 defineExpose 转发。
 */
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import RequirementList from './components/RequirementList/RequirementList.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import TaskPanel from '../../components/TaskPanel/TaskPanel.vue'
import SessionStatusBar from '../../components/SessionStatusBar/SessionStatusBar.vue'
import PendingQueue from '../../components/PendingQueue/PendingQueue.vue'
import MessageInput from '../../components/MessageInput/MessageInput.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type {
  AutomationStatus,
  Requirement,
  RequirementStatus,
  SlashCommandInfo,
} from '@ccc/shared/protocol'

defineProps<{
  // left: requirement list
  project: string
  requirements: Requirement[]
  automation: AutomationStatus | null
  // right: chat column (shared with sessions page)
  activeTitle: string
  hasActiveSession: boolean
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  running: boolean
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  /** Display name of the agent the viewed session is currently running. */
  currentAgentName?: string
  /** Agent run is backing off before a single auto-resume (SessionStatus `reconnecting`). */
  reconnecting?: boolean
  /** Auto-resume refused by the side-effect gate; awaiting a manual continue (AS-R19). */
  sideEffectPending?: boolean
  queue: PendingItem[]
  availableCommands: SlashCommandInfo[]
  voiceLang: string
}>()

const emit = defineEmits<{
  filter: [status: RequirementStatus | null]
  refine: [requirementId: string]
  'start-dev': [requirementId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [requirementId: string, status: RequirementStatus]
  'set-automate': [requirementId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-requirement': []
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
  refresh: []
  'edit-queued': [item: PendingItem]
  'delete-queued': [id: number]
  submit: [text: string]
  enqueue: [text: string]
  stop: []
  continue: []
  'list-commands': []
}>()

const { t } = useTypedI18n()

const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string) => composer.value?.prefill(text),
})
</script>

<template>
  <RequirementList
    :project="project"
    :requirements="requirements"
    :automation="automation"
    @filter="(status: RequirementStatus | null) => emit('filter', status)"
    @refine="(id: string) => emit('refine', id)"
    @start-dev="(id: string, hasDeps: boolean) => emit('start-dev', id, hasDeps)"
    @open-dev="(sessionId: string) => emit('open-dev', sessionId)"
    @set-status="(id: string, status: RequirementStatus) => emit('set-status', id, status)"
    @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
    @start-automation="emit('start-automation')"
    @stop-automation="emit('stop-automation')"
    @new-requirement="emit('new-requirement')"
  />

  <div class="content">
    <SessionTitleBar
      :active-title="activeTitle || t('requirement.chat.title.label')"
      :show-mode="false"
    />
    <ChatMessages
      :messages="messages"
      :has-active-session="hasActiveSession"
      :actionable-permission-id="actionablePermissionId"
      @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
      @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
    />
    <TaskPanel :model="taskModel" />
    <SessionStatusBar
      :has-active-session="hasActiveSession"
      :running="running"
      :team-active="teamActive"
      :connection="connection"
      :activity="activity"
      :current-agent-name="currentAgentName"
      :reconnecting="reconnecting"
      :side-effect-pending="sideEffectPending"
      @refresh="emit('refresh')"
      @stop="emit('stop')"
      @continue="emit('continue')"
    />
    <PendingQueue
      :items="queue"
      @edit="(item: PendingItem) => emit('edit-queued', item)"
      @delete="(id: number) => emit('delete-queued', id)"
    />
    <MessageInput
      ref="composer"
      :running="running"
      :team-active="teamActive"
      :has-active-session="hasActiveSession"
      :available-commands="availableCommands"
      :voice-lang="voiceLang"
      @submit="(text: string) => emit('submit', text)"
      @enqueue="(text: string) => emit('enqueue', text)"
      @list-commands="emit('list-commands')"
    />
  </div>
</template>
