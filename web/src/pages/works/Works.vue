<script setup lang="ts">
/*
 * Works.vue — 工作(console)页容器。
 *
 * 纯容器:左侧会话列表 + 右侧聊天列(标题栏 + 消息 + 任务面板 + 状态栏 + 待发队列 +
 * 输入框)。所有状态/连接由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 * composer ref 经 defineExpose 转发,供 App.vue 的待发队列「编辑」回填草稿。
 */
import { computed, ref, watch } from 'vue'
import SessionList from './components/SessionList/SessionList.vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
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
  CodexPolicy,
  ModeToken,
  OpencodeServerStatus,
  SessionAgentSwitch,
  SessionCapabilities,
  SessionInfo,
  SessionStatus,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'

const props = defineProps<{
  // left: session list
  currentWorkspace: string | null
  sessions: SessionInfo[]
  sessionStatus: Record<string, SessionStatus>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
  /** The active session's resolved agent vendor, for the title vendor dot. */
  vendor?: VendorId | null
  /** Same-vendor agent switcher data for the active session (ADR-0015); null ⇒ no switcher. */
  agentSwitch?: SessionAgentSwitch | null
  /** Per-vendor session-lifecycle capability ledger (ADR-0011), gating row actions. */
  vendorSessionCaps?: Partial<Record<VendorId, SessionCapabilities>>
  /** Live OpenCode server reachability (2026-06-07-003), drives the list offline warning. */
  opencodeStatus?: OpencodeServerStatus
  // right: chat column
  hasActiveSession: boolean
  mode: ModeToken
  /** Codex dual-policy config (2026-06-08); null for non-codex sessions. */
  codexPolicy: CodexPolicy | null
  modeOptions: { value: ModeToken; label: string }[]
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
  'create-session': [path: string]
  'refresh-sessions': []
  'select-session': [path: string, sessionId: string]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
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
  'mobile-back': [targetKey: string]
}>()

const mobilePanes = [
  { key: 'sessions', title: 'Sessions' },
  { key: 'chat', title: 'Chat' },
] as const

type MobilePaneKey = (typeof mobilePanes)[number]['key']

const mobileActiveKey = ref<MobilePaneKey>('sessions')
const mobileActiveToken = computed(
  () => props.activeSession ?? props.currentWorkspace ?? 'sessions',
)

watch(
  () => props.activeSession,
  (activeSession) => {
    if (!activeSession) mobileActiveKey.value = 'sessions'
  },
)

function selectSession(path: string, sessionId: string): void {
  mobileActiveKey.value = 'chat'
  emit('select-session', path, sessionId)
}

function handleMobileBack(targetKey: string): void {
  if (targetKey === 'sessions') mobileActiveKey.value = 'sessions'
  emit('mobile-back', targetKey)
}

// Forward the composer's prefill so App.vue's queue-edit can fold text back in.
const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string) => composer.value?.prefill(text),
})
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Sessions"
    @back="handleMobileBack"
  >
    <template #sessions>
      <SessionList
        :current-workspace="currentWorkspace"
        :sessions="sessions"
        :session-status="sessionStatus"
        :active-workspace="activeWorkspace"
        :active-session="activeSession"
        :active-title="activeTitle"
        :vendor-session-caps="vendorSessionCaps"
        :opencode-status="opencodeStatus"
        @create-session="(path: string) => emit('create-session', path)"
        @refresh-sessions="emit('refresh-sessions')"
        @select-session="selectSession"
        @delete-session="
          (path: string, sessionId: string) => emit('delete-session', path, sessionId)
        "
        @rename-session="
          (path: string, sessionId: string, title: string) =>
            emit('rename-session', path, sessionId, title)
        "
      />
    </template>

    <template #chat>
      <div class="content">
        <SessionTitleBar
          v-if="hasActiveSession"
          :active-title="activeTitle"
          :vendor="vendor"
          :agent-switch="agentSwitch"
          :mode="mode"
          :codex-policy="codexPolicy"
          :mode-options="modeOptions"
          @set-mode="(m: ModeToken) => emit('set-mode', m)"
          @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
          @set-session-agent="(id: string) => emit('set-session-agent', id)"
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
  </MobileStack>
</template>
