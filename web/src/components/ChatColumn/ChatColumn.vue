<script setup lang="ts">
/*
 * ChatColumn.vue — 复用的聊天列(会话信息 + 消息 + 任务面板 + 状态栏 + 待发队列 + 输入框)。
 *
 * 从 Works.vue(console)与 Intents.vue(意图会话)抽出的同一段聊天界面,供三处复用:
 * 会话页右栏、意图页合并列的 sessions tab、以及意图详情的 `intent session` /
 * `spec session` 两 tab。所有状态/连接经 props 注入,用户动作经 emit 上抛;不持有
 * 任何会话状态——绑定哪个会话由上层(App.vue 控制层)的单一活动会话决定。
 *
 * 变体:`show-mode` 控制标题栏是否展示模式/codex 策略下拉(会话页 true、意图侧 false);
 * `always-title` 控制无活动会话时是否仍渲染标题栏(意图侧常驻标题、会话页隐藏)。
 * composer 的 prefill 经 defineExpose 透传,供上层待发队列「编辑」回填草稿。
 */
import { ref } from 'vue'
import SessionTitleBar from '../SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../ChatMessages/ChatMessages.vue'
import TaskPanel from '../TaskPanel/TaskPanel.vue'
import SessionStatusBar from '../SessionStatusBar/SessionStatusBar.vue'
import PendingQueue from '../PendingQueue/PendingQueue.vue'
import MessageInput from '../MessageInput/MessageInput.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type {
  CodexPolicy,
  ModeToken,
  PromptImage,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'

withDefaults(
  defineProps<{
    // title bar
    activeTitle: string
    vendor?: VendorId | null
    agentSwitch?: SessionAgentSwitch | null
    /** Show the mode / codex-policy controls in the title bar (console only). */
    showMode?: boolean
    mode?: ModeToken
    codexPolicy?: CodexPolicy | null
    modeOptions?: { value: ModeToken; label: string }[]
    /** Render the title bar even with no active session (intent side keeps it). */
    alwaysTitle?: boolean
    // chat body
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
  }>(),
  {
    showMode: false,
    alwaysTitle: false,
    vendor: null,
    agentSwitch: null,
    mode: undefined,
    codexPolicy: null,
    modeOptions: () => [],
    hasTaskStore: true,
    currentAgentName: undefined,
    reconnecting: false,
    sideEffectPending: false,
  },
)

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

// Forward the composer's prefill so the queue-edit fold-back can reach this input.
const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => composer.value?.prefill(text, images),
})
</script>

<template>
  <div class="content">
    <SessionTitleBar
      v-if="alwaysTitle || hasActiveSession"
      :active-title="activeTitle"
      :vendor="vendor"
      :agent-switch="agentSwitch"
      :show-mode="showMode"
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
      @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
      @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
      @list-commands="emit('list-commands')"
    />
  </div>
</template>
