<script setup lang="ts">
/*
 * Sessions.vue — 会话(console)页容器。
 *
 * 纯容器:左侧会话列表 + 右侧聊天列(标题栏 + 消息 + 任务面板 + 状态栏 + 待发队列 +
 * 输入框)。所有状态/连接由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 * composer ref 经 defineExpose 转发,供 App.vue 的待发队列「编辑」回填草稿。
 */
import { ref } from 'vue'
import SessionList from './components/SessionList/SessionList.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ResumeOnlyBanner from '../../components/ResumeOnlyBanner/ResumeOnlyBanner.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import TaskPanel from '../../components/TaskPanel/TaskPanel.vue'
import SessionStatusBar from '../../components/SessionStatusBar/SessionStatusBar.vue'
import PendingQueue from '../../components/PendingQueue/PendingQueue.vue'
import MessageInput from '../../components/MessageInput/MessageInput.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type {
  OpencodeServerStatus,
  PermissionMode,
  SessionAgentSwitch,
  SessionCapabilities,
  SessionInfo,
  SessionStatus,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'

defineProps<{
  // left: session list
  currentWorkspace: string | null
  sessions: SessionInfo[]
  sessionStatus: Record<string, SessionStatus>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
  /** The active session's resolved agent vendor, for the title vendor dot. */
  activeVendor?: VendorId | null
  /** Same-vendor agent switcher data for the active session (ADR-0015); null ⇒ no switcher. */
  activeAgentSwitch?: SessionAgentSwitch | null
  /** Per-vendor session-lifecycle capability ledger (ADR-0011), gating row actions. */
  vendorSessionCaps?: Partial<Record<VendorId, SessionCapabilities>>
  /** Live OpenCode server reachability (2026-06-07-003), drives the list offline warning. */
  opencodeStatus?: OpencodeServerStatus
  // right: chat column
  hasActiveSession: boolean
  mode: PermissionMode
  modeOptions: { value: PermissionMode; label: string }[]
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
  'create-session': [path: string]
  'refresh-sessions': []
  'select-session': [path: string, sessionId: string]
  'resume-session': [path: string, sessionId: string, vendor: VendorId]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
  'set-mode': [mode: PermissionMode]
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

// Forward the composer's prefill so App.vue's queue-edit can fold text back in.
const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string) => composer.value?.prefill(text),
})
</script>

<template>
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
    @select-session="(path: string, sessionId: string) => emit('select-session', path, sessionId)"
    @resume-session="
      (path: string, sessionId: string, vendor: VendorId) =>
        emit('resume-session', path, sessionId, vendor)
    "
    @delete-session="(path: string, sessionId: string) => emit('delete-session', path, sessionId)"
    @rename-session="
      (path: string, sessionId: string, title: string) =>
        emit('rename-session', path, sessionId, title)
    "
  />

  <div class="content">
    <SessionTitleBar
      v-if="hasActiveSession"
      :active-title="activeTitle"
      :vendor="activeVendor"
      :agent-switch="activeAgentSwitch"
      :mode="mode"
      :mode-options="modeOptions"
      @set-mode="(m: PermissionMode) => emit('set-mode', m)"
      @set-session-agent="(id: string) => emit('set-session-agent', id)"
    />
    <!--
      read='none' vendor（Codex）的 resume-only 横幅：空 baseline 时它就是用户看到的
      唯一引导。按能力态门控（vendorSessionCaps[vendor].read），零 vendor 身份硬判定。
    -->
    <ResumeOnlyBanner
      v-if="hasActiveSession && activeVendor"
      :vendor="activeVendor"
      :read="vendorSessionCaps?.[activeVendor]?.read"
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
