<script setup lang="ts">
/*
 * Works.vue — 工作(console)页容器。
 *
 * 纯容器:左侧会话列表 + 右侧聊天列(标题栏 + 消息 + 任务面板 + 状态栏 + 待发队列 +
 * 输入框)。所有状态/连接由 App.vue 持有,经 props 注入;用户动作经 emit 上抛。
 * composer ref 经 defineExpose 转发,供 App.vue 的待发队列「编辑」回填草稿。
 */
import { computed, ref, watch } from 'vue'
import WorkSessionList from './components/WorkSessionList/WorkSessionList.vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type {
  CodexPolicy,
  ModeToken,
  PromptImage,
  SessionAgentSwitch,
  SessionCapabilities,
  SessionInfo,
  SessionStatus,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { SessionPageKind } from '../../controls/state'
import type { SessionSourceLabel } from '../../lib/session-jump'

const props = defineProps<{
  // left: session list
  currentWorkspace: string | null
  sessions: SessionInfo[]
  activeSessionKind: SessionPageKind
  sessionCounts: Record<SessionPageKind, number>
  showToolSessions: boolean
  /** Older sessions remain beyond the loaded window (SR-R14). */
  sessionsHasMore?: boolean
  /** A "load more" came back empty (SR-R14). */
  sessionsExhausted?: boolean
  sessionStatus: Record<string, SessionStatus>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
  /** The active session's resolved agent vendor, for the title vendor dot. */
  vendor?: VendorId | null
  /** Same-vendor agent switcher data for the active session (ADR-0015); null ⇒ no switcher. */
  agentSwitch?: SessionAgentSwitch | null
  /** The active session's title-bar source-button label family; null ⇒ no button. */
  sourceLabel?: SessionSourceLabel | null
  /** Per-vendor session-lifecycle capability ledger (ADR-0011), gating row actions. */
  vendorSessionCaps?: Partial<Record<VendorId, SessionCapabilities>>
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
  'select-session-kind': [kind: SessionPageKind]
  'load-more-sessions': []
  'select-session': [path: string, sessionId: string]
  'jump-session-source': [path: string, session: SessionInfo]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
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
    if (!activeSession) {
      mobileActiveKey.value = 'sessions'
    } else if (activeSession.startsWith(PENDING_SESSION_PREFIX)) {
      // 新建会话:服务端回 session_selected 携带 pending id。创建走 NewSessionModal,
      // 不经本组件的 select 路径,故无人切 pane;在此 drill 进聊天,否则停留在会话
      // 列表看不到新会话。pending→real 的二次迁移不是 pending 值,不会再次触发。
      mobileActiveKey.value = 'chat'
    }
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

// 定时任务执行类会话是只读的执行日志(从定时任务跳入查看),不接受用户输入,
// 故隐藏输入框;其余会话类型(work/intent/spec/discussion/tool)仍可对话。
const showInput = computed(() => props.activeSessionKind !== 'schedule')

// Forward the composer's prefill so App.vue's queue-edit can fold text+images back in.
const composer = ref<InstanceType<typeof ChatColumn> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => composer.value?.prefill(text, images),
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
      <WorkSessionList
        :current-workspace="currentWorkspace"
        :sessions="sessions"
        :active-session-kind="activeSessionKind"
        :session-counts="sessionCounts"
        :show-tool-sessions="showToolSessions"
        :has-more="sessionsHasMore"
        :exhausted="sessionsExhausted"
        :session-status="sessionStatus"
        :active-workspace="activeWorkspace"
        :active-session="activeSession"
        :active-title="activeTitle"
        :vendor-session-caps="vendorSessionCaps"
        @create-session="(path: string) => emit('create-session', path)"
        @refresh-sessions="emit('refresh-sessions')"
        @select-session-kind="(kind: SessionPageKind) => emit('select-session-kind', kind)"
        @load-more-sessions="emit('load-more-sessions')"
        @select-session="selectSession"
        @jump-session-source="
          (path: string, session: SessionInfo) => emit('jump-session-source', path, session)
        "
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
      <ChatColumn
        ref="composer"
        :active-title="activeTitle"
        :vendor="vendor"
        :agent-switch="agentSwitch"
        :show-mode="true"
        :mode="mode"
        :codex-policy="codexPolicy"
        :mode-options="modeOptions"
        :source-label="sourceLabel"
        :show-share="true"
        :has-active-session="hasActiveSession"
        :show-input="showInput"
        :messages="messages"
        :actionable-permission-id="actionablePermissionId"
        :task-model="taskModel"
        :has-task-store="hasTaskStore"
        :running="running"
        :team-active="teamActive"
        :connection="connection"
        :activity="activity"
        :current-agent-name="currentAgentName"
        :reconnecting="reconnecting"
        :side-effect-pending="sideEffectPending"
        :queue="queue"
        :available-commands="availableCommands"
        :voice-lang="voiceLang"
        @set-mode="(m: ModeToken) => emit('set-mode', m)"
        @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
        @set-session-agent="(id: string) => emit('set-session-agent', id)"
        @open-source="emit('open-source')"
        @share="emit('share')"
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
  </MobileStack>
</template>
