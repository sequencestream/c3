<script setup lang="ts">
/*
 * ChatColumn.vue — 复用的聊天列(会话信息 + 消息 + 任务面板 + 状态栏 + 待发队列 + 输入框)。
 *
 * 从 Works.vue(console)与 Intents.vue(意图会话)抽出的同一段聊天界面,供三处复用:
 * 会话页右栏、意图页合并列的 sessions tab、以及意图详情的会话 tab(`intent session` /
 * `spec session` / 只读的 `spec review` / `work session`)。所有状态/连接经 props 注入,
 * 用户动作经 emit 上抛;不持有任何会话状态——绑定哪个会话由上层(App.vue 控制层)的
 * 单一活动会话决定。
 *
 * 变体:`show-mode` 控制标题栏是否展示模式/codex 策略下拉,`mode-disabled` 让它只读
 * (意图会话 / spec 会话的模式由服务端钉死,只展示不可改);
 * `always-title` 控制无活动会话时是否仍渲染标题栏(意图侧常驻标题、会话页隐藏)。
 * composer 的 prefill 经 defineExpose 透传,供上层待发队列「编辑」回填草稿。
 *
 * `readonly` 是整列的能力门(不是 `show-input` 的扩义):用于 spec_review 这类只能回放、
 * 不能续跑的会话。它统一移除所有能改变会话/队列/权限决策的入口——隐藏 composer、
 * 不渲染待发队列、状态栏保留状态文字但不给 stop/continue、权限消息仍完整回放但不渲染
 * allow/deny/ask 控件;并且即便子组件被程序化触发,只读分支也不会再上抛 respond /
 * submit-ask / submit / enqueue / stop / continue。标题、消息、任务信息、刷新与实时状态
 * 不受影响。它只是呈现层,真正的防线是服务端按 sessionKind 的门禁。
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
import type { SessionSourceLabel } from '../../lib/session-jump'

const props = withDefaults(
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
    /** Render the mode controls read-only (intent / spec sessions are pinned server-side). */
    modeDisabled?: boolean
    /** Render the title bar even with no active session (intent side keeps it). */
    alwaysTitle?: boolean
    showTitleBar?: boolean
    /** Source-button label family for the title bar (works side only); null ⇒ no button. */
    sourceLabel?: SessionSourceLabel | null
    /** Show the「分享」icon button in the title bar (works console only). */
    showShare?: boolean
    // chat body
    hasActiveSession: boolean
    messages: ChatMsg[]
    showMessages?: boolean
    actionablePermissionId: string | null
    taskModel: TaskListModel
    /** Whether the active vendor exposes `taskStore`; gates the TaskPanel. Default open. */
    hasTaskStore?: boolean
    showTaskPanel?: boolean
    showStatusBar?: boolean
    showInput?: boolean
    /**
     * Replay-only column: no composer, no pending queue, no run controls, no
     * permission answering — and no change-events out of this column. See the
     * header comment; used by read-only session kinds (spec review).
     */
    readonly?: boolean
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
    showTitleBar: true,
    vendor: null,
    agentSwitch: null,
    mode: undefined,
    codexPolicy: null,
    modeOptions: () => [],
    modeDisabled: false,
    sourceLabel: null,
    showShare: false,
    hasTaskStore: true,
    showMessages: true,
    showTaskPanel: true,
    showStatusBar: true,
    showInput: true,
    readonly: false,
    currentAgentName: undefined,
    reconnecting: false,
    sideEffectPending: false,
  },
)

const emit = defineEmits<{
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
  'set-session-agent': [agentId: string]
  'open-source': []
  share: []
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

// The read-only gate, applied to every change-event this column can emit. Child
// components are guarded at render time too (the controls simply aren't there),
// but routing the emits through here means even a programmatic child event
// cannot escape the column as a change request.
function emitUnlessReadonly(fn: () => void): void {
  if (props.readonly) return
  fn()
}

// Forward the composer's prefill so the queue-edit fold-back can reach this input.
const composer = ref<InstanceType<typeof MessageInput> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => composer.value?.prefill(text, images),
})
</script>

<template>
  <div class="content">
    <SessionTitleBar
      v-if="showTitleBar && (alwaysTitle || hasActiveSession)"
      :active-title="activeTitle"
      :vendor="vendor"
      :agent-switch="agentSwitch"
      :show-mode="showMode"
      :mode="mode"
      :codex-policy="codexPolicy"
      :mode-options="modeOptions"
      :mode-disabled="modeDisabled"
      :source-label="sourceLabel"
      :show-share="showShare"
      @set-mode="(m: ModeToken) => emit('set-mode', m)"
      @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
      @set-session-agent="(id: string) => emit('set-session-agent', id)"
      @open-source="emit('open-source')"
      @share="emit('share')"
    >
      <!-- 标题栏动作插槽:Codes 内嵌会话用它渲染「+ 新建」/「↻ 重置」按钮。 -->
      <template #action><slot name="title-action" /></template>
    </SessionTitleBar>
    <ChatMessages
      v-if="showMessages"
      :messages="messages"
      :has-active-session="hasActiveSession"
      :actionable-permission-id="readonly ? null : actionablePermissionId"
      @respond="
        (m: PermissionMsg, d: 'allow' | 'deny') => emitUnlessReadonly(() => emit('respond', m, d))
      "
      @submit-ask="
        (m: PermissionMsg, a: Record<string, string>) =>
          emitUnlessReadonly(() => emit('submit-ask', m, a))
      "
    />
    <TaskPanel v-if="showTaskPanel" :model="taskModel" :has-task-store="hasTaskStore" />
    <SessionStatusBar
      v-if="showStatusBar"
      :has-active-session="hasActiveSession"
      :running="running"
      :team-active="teamActive"
      :connection="connection"
      :activity="activity"
      :current-agent-name="currentAgentName"
      :reconnecting="reconnecting"
      :side-effect-pending="sideEffectPending"
      :hide-run-controls="readonly"
      @refresh="emit('refresh')"
      @stop="emitUnlessReadonly(() => emit('stop'))"
      @continue="emitUnlessReadonly(() => emit('continue'))"
    />
    <PendingQueue
      v-if="!readonly"
      :items="queue"
      @edit="(item: PendingItem) => emit('edit-queued', item)"
      @delete="(id: number) => emit('delete-queued', id)"
    />
    <MessageInput
      v-if="showInput && !readonly"
      ref="composer"
      :running="running"
      :team-active="teamActive"
      :has-active-session="hasActiveSession"
      :available-commands="availableCommands"
      :voice-lang="voiceLang"
      @submit="
        (text: string, imgs: PromptImage[]) => emitUnlessReadonly(() => emit('submit', text, imgs))
      "
      @enqueue="
        (text: string, imgs: PromptImage[]) => emitUnlessReadonly(() => emit('enqueue', text, imgs))
      "
      @list-commands="emit('list-commands')"
    />
  </div>
</template>
