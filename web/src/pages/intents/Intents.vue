<script setup lang="ts">
/*
 * Intents.vue — 需求页容器。
 *
 * 桌面两栏布局:左侧意图列表 + 右侧意图详情列。选中意图后右栏展示其完整详情
 * (IntentDetail,含按意图绑定的 intent session 沟通 tab)。
 * 首次进入默认选中列表首条意图,右栏直接展示其详情。
 * 移动端退化为二级 drill-down 栈:列表 → 详情逐级滑入/返回。
 * 状态/连接由 App.vue 持有,经 props 注入,动作经 emit 上抛。prefill 经 defineExpose 转发到详情列。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import IntentMergedList from './components/IntentMergedList/IntentMergedList.vue'
import IntentDetail from './components/IntentDetail/IntentDetail.vue'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type {
  AutomationStatus,
  Intent,
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
  /**
   * One-shot external select request (from a work session's title-bar jump button).
   * When set and the target lands in `intents`, it's selected (right panel shows its
   * detail) and `requested-intent-consumed` is emitted so the parent clears it. A
   * target that never appears (deleted / not loaded) leaves the default selection.
   */
  requestedIntentId?: string | null
  /** 当前 workspace SDD 总开关,透传给 IntentDetail 的四态主按钮。 */
  sddEnabled?: boolean
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  /** 当前 workspace 配置的主分支;用于隐藏主分支上的 Create PR 动作。 */
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
  /** Selected intent's spec.md content (intent detail `spec` tab); null=未加载/无。 */
  intentSpecContent: string | null
  intentSpecLoading: boolean
  // right: chat column (shared with sessions page)
  /** The global active session id; passed to IntentDetail to gate its chat tabs. */
  activeSession: string | null
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
  /** One-shot sub-tab request for IntentDetail (WorkCenter jump-to-source). */
  requestedIntentSubTab?: 'intentSession' | 'specSession' | null
  /**
   * One-shot request to open a standalone intent (chat) session here (from the
   * session page's title-bar source button, for a chat with no owning intent).
   * When set, the right column flips to the standalone chat bound to `activeSession`;
   * `requested-intent-session-consumed` is emitted so the parent clears it.
   */
  requestedIntentSessionId?: string | null
}>()

const emit = defineEmits<{
  // intent list events
  filter: [status: IntentStatus | null]
  refine: [intentId: string]
  'write-spec': [intentId: string]
  'approve-spec': [intentId: string]
  'open-spec-session': [intentId: string]
  'open-intent-session': [sessionId: string]
  'read-spec': [intentId: string, specPath: string]
  'reset-intent-session': [intentId: string, userInput: string]
  'reset-spec-session': [intentId: string, userInput: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-intent': []
  'new-intent-session': []
  'create-pr': [intentId: string]
  'sync-pr-status': [intentId: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  share: [intentId: string]
  'set-session-agent': [agentId: string]
  // external select request consumed (parent clears `requestedIntentId`)
  'requested-intent-consumed': []
  // external standalone-session request consumed (parent clears `requestedIntentSessionId`)
  'requested-intent-session-consumed': []
  // external sub-tab request consumed (parent clears `requestedIntentSubTab`)
  'requested-subtab-consumed': []
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

// ---- 选中意图(驱动右栏 IntentDetail) ----
// 默认选中项必须对齐左侧列表「实际渲染顺序」的首条(IntentList 把未完成项置顶、终止态沉底),
// 而非服务端原序(priority ASC)首条;故由 IntentList 上抛 ordered-change(有序 id 列表),据此选首条。
const selectedIntentId = ref<string | null>(null)
const userSelectedIntent = ref(false)

// 右栏双态:false=展示选中意图的 IntentDetail;true=展示「+」新建的独立意图会话
// 聊天列(不绑定具体意图)。点「+」置 true,点任一意图行置 false 切回详情。
const viewingNewIntentSession = ref(false)
function handleOrderedChange(ids: string[]): void {
  if (ids.length === 0) {
    selectedIntentId.value = null
    userSelectedIntent.value = false
    return
  }
  if (!selectedIntentId.value || !ids.includes(selectedIntentId.value)) {
    userSelectedIntent.value = false
    selectedIntentId.value = ids[0]
    return
  }
  if (!userSelectedIntent.value && selectedIntentId.value !== ids[0]) {
    selectedIntentId.value = ids[0]
  }
}
const selectedIntent = computed<Intent | null>(
  () => props.intents.find((r) => r.id === selectedIntentId.value) ?? null,
)

// External one-shot select request (work session title-bar jump button): when the
// requested intent is present in the loaded list, select it (winning over the
// default-first-row logic via userSelectedIntent=true) and signal the parent to
// clear the request. The request may arrive before `intents` loads, so we watch
// both; a target that never lands is silently ignored (default selection stands).
watch(
  () => [props.requestedIntentId, props.intents] as const,
  ([requestedId]) => {
    if (!requestedId) return
    if (!props.intents.some((it) => it.id === requestedId)) return
    selectedIntentId.value = requestedId
    userSelectedIntent.value = true
    emit('requested-intent-consumed')
  },
  { immediate: true },
)

// External one-shot request to open a standalone intent (chat) session here (a chat
// with no owning intent, traced from the session page's title-bar source button):
// flip the right column to the standalone chat — it binds to the active session the
// control layer is selecting — and signal the parent to clear the request.
watch(
  () => props.requestedIntentSessionId,
  (sessionId) => {
    if (!sessionId) return
    viewingNewIntentSession.value = true
    emit('requested-intent-session-consumed')
  },
  { immediate: true },
)

// ---- Mobile drill-down state ----
// 桌面两栏(意图列表 + 详情列),移动端两级 drill-down:列表 → 详情。
const mobilePanes = computed(
  () =>
    [
      { key: 'list', title: t('intent.list.title.label') },
      { key: 'right', title: selectedIntent.value?.title ?? t('intent.list.title.label') },
    ] as const,
)

type MobilePaneKey = (typeof mobilePanes.value)[number]['key']

const mobileActiveKey = ref<MobilePaneKey>('list')
const mobileActiveToken = computed(() => selectedIntentId.value ?? props.project ?? 'list')

function handleSelectIntent(intentId: string): void {
  userSelectedIntent.value = true
  selectedIntentId.value = intentId
  // 选中意图即切回详情视图(若此前在看新建意图会话聊天列)。
  viewingNewIntentSession.value = false
  // 移动端:点击意图行 drill 进右栏详情(桌面下右栏常驻,仅更新选中)。
  mobileActiveKey.value = 'right'
}

// 列表标题栏「+」:新建意图会话。右栏切到独立聊天列;新会话经服务端
// session_selected 成为活动会话后由 ChatColumn 渲染。移动端 drill 进右栏。
function handleNewIntentSession(): void {
  viewingNewIntentSession.value = true
  mobileActiveKey.value = 'right'
  emit('new-intent-session')
}

function handleSelectDependency(intentId: string): void {
  handleSelectIntent(intentId)
}

function handleMobileBack(targetKey: string): void {
  mobileActiveKey.value = targetKey as MobilePaneKey
  emit('mobile-back', targetKey)
}

// ---- Composer refs for prefill forwarding ----
// Prefill routes to whichever right-column view is active: the standalone
// intent-session chat (`composer`) or the intent detail's chat tabs (`detailRef`).
const detailRef = ref<InstanceType<typeof IntentDetail> | null>(null)
const composer = ref<InstanceType<typeof ChatColumn> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => {
    if (viewingNewIntentSession.value) composer.value?.prefill(text, images)
    else detailRef.value?.prefill(text, images)
  },
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
    <template #list>
      <IntentMergedList
        :project="project"
        :intents="intents"
        :automation="automation"
        :sdd-enabled="sddEnabled"
        :workspace-main-branch="workspaceMainBranch"
        :workspace-git-branch-mode="workspaceGitBranchMode"
        :selected-intent-id="selectedIntentId"
        @filter="(status: IntentStatus | null) => emit('filter', status)"
        @start-automation="emit('start-automation')"
        @stop-automation="emit('stop-automation')"
        @select-intent="handleSelectIntent"
        @ordered-change="handleOrderedChange"
        @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
        @refine="(id: string) => emit('refine', id)"
        @new-intent-session="handleNewIntentSession"
      />
    </template>

    <template #right>
      <IntentDetail
        v-if="!viewingNewIntentSession"
        ref="detailRef"
        :intent="selectedIntent"
        :intents="intents"
        :intent-action-error-seq="intentActionErrorSeq"
        :intent-pr-sync="intentPrSync"
        :sdd-enabled="sddEnabled"
        :workspace-main-branch="workspaceMainBranch"
        :workspace-git-branch-mode="workspaceGitBranchMode"
        :requested-sub-tab="requestedIntentSubTab"
        :active-session="activeSession"
        :active-title="activeTitle"
        :vendor="vendor ?? null"
        :agent-switch="agentSwitch ?? null"
        :has-active-session="hasActiveSession"
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
        :intent-spec-content="intentSpecContent"
        :intent-spec-loading="intentSpecLoading"
        @refine="(id: string) => emit('refine', id)"
        @write-spec="(id: string) => emit('write-spec', id)"
        @approve-spec="(id: string) => emit('approve-spec', id)"
        @open-spec-session="(id: string) => emit('open-spec-session', id)"
        @open-intent-session="(sessionId: string) => emit('open-intent-session', sessionId)"
        @read-spec="(id: string, specPath: string) => emit('read-spec', id, specPath)"
        @reset-intent-session="
          (id: string, input: string) => emit('reset-intent-session', id, input)
        "
        @reset-spec-session="(id: string, input: string) => emit('reset-spec-session', id, input)"
        @start-dev="(id: string, hasDeps: boolean) => emit('start-dev', id, hasDeps)"
        @open-dev="(sessionId: string) => emit('open-dev', sessionId)"
        @set-status="(id: string, status: IntentStatus) => emit('set-status', id, status)"
        @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
        @create-pr="(id: string) => emit('create-pr', id)"
        @sync-pr-status="(id: string) => emit('sync-pr-status', id)"
        @share="(id: string) => emit('share', id)"
        @update-deps="(id, deps) => emit('update-deps', id, deps)"
        @select-dependency="handleSelectDependency"
        @set-session-agent="(agentId: string) => emit('set-session-agent', agentId)"
        @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
        @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
        @requested-subtab-consumed="emit('requested-subtab-consumed')"
        @refresh="emit('refresh')"
        @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
        @delete-queued="(id: number) => emit('delete-queued', id)"
        @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
        @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
        @stop="emit('stop')"
        @continue="emit('continue')"
        @list-commands="emit('list-commands')"
      />
      <ChatColumn
        v-else
        ref="composer"
        :active-title="activeTitle || t('intent.intentSession.title.label')"
        :vendor="vendor ?? null"
        :agent-switch="agentSwitch ?? null"
        :show-mode="false"
        :always-title="true"
        :has-active-session="hasActiveSession"
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
        @set-session-agent="(agentId: string) => emit('set-session-agent', agentId)"
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
