<script setup lang="ts">
/*
 * Intents.vue — 需求页容器。
 *
 * 桌面两栏布局:左侧合并列(分段控件切换需求列表/意图会话列表) + 右侧聊天列。
 * 移动端退化为二级 drill-down 栈:合并列→聊天逐级滑入/返回。
 * 需求 comm session 即被查看的会话,故复用与会话页相同的聊天列(标题栏为需求变体,
 * 无权限模式下拉)。状态/连接由 App.vue 持有,经 props 注入,动作经 emit 上抛。
 * composer ref 经 defineExpose 转发。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import IntentMergedList from './components/IntentMergedList/IntentMergedList.vue'
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
  PromptImage,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { DepType } from '@ccc/shared/protocol'

const props = defineProps<{
  // left: intent list
  project: string
  intents: Intent[]
  automation: AutomationStatus | null
  intentActionErrorSeq?: number
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
  // intent list events
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
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  // intent session events
  'select-intent-session': [sessionId: string]
  'new-intent-session': []
  'rename-intent-session': [sessionId: string, title: string]
  'delete-intent-session': [sessionId: string]
  'set-session-agent': [agentId: string]
  // chat events
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
  // mobile drill-down
  'mobile-back': [targetKey: string]
}>()

const { t } = useTypedI18n()

// ---- Mobile drill-down state ----
// 桌面两栏(合并列+聊天),移动端两级 drill-down。
const mergedListRef = ref<InstanceType<typeof IntentMergedList> | null>(null)
const mergedActiveTab = computed(() => mergedListRef.value?.activeTab ?? 'intents')

const mobilePanes = computed(
  () =>
    [
      {
        key: 'intents',
        title:
          mergedActiveTab.value === 'sessions'
            ? t('intent.sessionList.title.label')
            : t('intent.list.title.label'),
      },
      { key: 'chat', title: t('intent.chat.title.label') },
    ] as const,
)

type MobilePaneKey = (typeof mobilePanes.value)[number]['key']

const mobileActiveKey = ref<MobilePaneKey>('intents')
const mobileActiveToken = computed(
  () => props.selectedIntentSessionId ?? props.project ?? 'intents',
)

function handleSelectIntentSession(sessionId: string): void {
  mobileActiveKey.value = 'chat'
  emit('select-intent-session', sessionId)
}

function handleMobileBack(targetKey: string): void {
  mobileActiveKey.value = targetKey as MobilePaneKey
  emit('mobile-back', targetKey)
}

// ---- Composer ref for prefill forwarding ----
const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => composer.value?.prefill(text, images),
})
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Intents"
    @back="handleMobileBack"
  >
    <template #intents>
      <IntentMergedList
        ref="mergedListRef"
        :project="project"
        :intents="intents"
        :automation="automation"
        :intent-action-error-seq="intentActionErrorSeq"
        :intent-sessions="intentSessions"
        :selected-intent-session-id="selectedIntentSessionId"
        :intent-session-run-states="intentSessionRunStates"
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
        @update-deps="(id, deps) => emit('update-deps', id, deps)"
        @select-intent-session="handleSelectIntentSession"
        @new-intent-session="emit('new-intent-session')"
        @rename-intent-session="
          (id: string, title: string) => emit('rename-intent-session', id, title)
        "
        @delete-intent-session="(id: string) => emit('delete-intent-session', id)"
      />
    </template>

    <template #chat>
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
          @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
          @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
          @list-commands="emit('list-commands')"
        />
      </div>
    </template>
  </MobileStack>
</template>
