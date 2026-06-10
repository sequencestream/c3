<script setup lang="ts">
/*
 * Intents.vue — 需求页容器。
 *
 * 三栏布局:左侧需求列表 + 中栏意图会话列表 + 右侧聊天列。
 * 需求 comm session 即被查看的会话,故复用与会话页相同的聊天列(标题栏为需求变体,
 * 无权限模式下拉)。状态/连接由 App.vue 持有,经 props 注入,动作经 emit 上抛。
 * composer ref 经 defineExpose 转发。
 */
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import IntentList from './components/IntentList/IntentList.vue'
import IntentSessionList from './components/IntentSessionList/IntentSessionList.vue'
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
  Intent,
  IntentSessionInfo,
  IntentStatus,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'

defineProps<{
  // left: intent list
  project: string
  intents: Intent[]
  automation: AutomationStatus | null
  // middle: intent session list
  intentSessions: IntentSessionInfo[]
  selectedIntentSessionId: string | null
  intentSessionRunStates: Record<string, 'running'>
  // right: chat column (shared with sessions page)
  activeTitle: string
  /** The session's resolved agent vendor; present after agent binding. */
  vendor?: VendorId | null
  /** Same-vendor agent switcher data; present after agent binding. */
  agentSwitch?: SessionAgentSwitch | null
  hasActiveSession: boolean
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  /** Whether the active vendor exposes `taskStore`; gates the TaskPanel. Default open. */
  hasTaskStore?: boolean
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
  filter: [status: IntentStatus | null]
  refine: [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-intent': []
  'create-pr': [intentId: string]
  'select-intent-session': [sessionId: string]
  'new-intent-session': []
  'rename-intent-session': [sessionId: string, title: string]
  'delete-intent-session': [sessionId: string]
  'set-session-agent': [agentId: string]
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
  <IntentList
    :project="project"
    :intents="intents"
    :automation="automation"
    @filter="(status: IntentStatus | null) => emit('filter', status)"
    @refine="(id: string) => emit('refine', id)"
    @start-dev="(id: string, hasDeps: boolean) => emit('start-dev', id, hasDeps)"
    @open-dev="(sessionId: string) => emit('open-dev', sessionId)"
    @set-status="(id: string, status: IntentStatus) => emit('set-status', id, status)"
    @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
    @start-automation="emit('start-automation')"
    @stop-automation="emit('stop-automation')"
    @new-intent="emit('new-intent')"
    @create-pr="(id: string) => emit('create-pr', id)"
  />

  <IntentSessionList
    :sessions="intentSessions"
    :selected-id="selectedIntentSessionId"
    :run-states="intentSessionRunStates"
    @select="(id: string) => emit('select-intent-session', id)"
    @new="emit('new-intent-session')"
    @rename="(id: string, title: string) => emit('rename-intent-session', id, title)"
    @delete="(id: string) => emit('delete-intent-session', id)"
  />

  <div class="content">
    <SessionTitleBar
      :active-title="activeTitle || t('intent.chat.title.label')"
      :vendor="vendor ?? null"
      :agent-switch="agentSwitch ?? null"
      :show-mode="false"
      @set-session-agent="(agentId: string) => emit('set-session-agent', agentId)"
    />
    <ChatMessages
      :messages="messages"
      :has-active-session="hasActiveSession"
      :actionable-permission-id="actionablePermissionId"
      @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
      @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
    />
    <TaskPanel :model="taskModel" :has-task-store="hasTaskStore" />
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
