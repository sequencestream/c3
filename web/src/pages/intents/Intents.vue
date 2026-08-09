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
import type { RequestedDetailSubTab } from './components/IntentDetail/useIntentDetailTabs'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type { StandaloneDeliveryRequest } from '@/lib/delivery-view'
import type { WorktreeBaselineNotice } from '@/lib/worktree-baseline'
import type {
  ActionTarget,
  CodexPolicy,
  Delivery,
  ModeToken,
  WorkflowStatus,
  Intent,
  IntentLog,
  IntentSpecMode,
  IntentStatus,
  PromptImage,
  SessionAgentSwitch,
  SessionStatus,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { DepType } from '@ccc/shared/protocol'

const props = defineProps<{
  // left: intent list
  project: string
  intents: Intent[]
  automation: WorkflowStatus | null
  intentActionErrorSeq?: number
  createIntentPending?: boolean
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
  /** 本工作区的交付列表,透传给详情标题栏的「关联交付」弹窗候选。 */
  deliveries?: Delivery[]
  /** 按意图 id 存的 worktree 基线提示;详情只取当前选中那条。 */
  worktreeBaselineNotices?: Record<string, WorktreeBaselineNotice>
  /** 「当前意图独立交付」是否在飞行中(控制层 pending 槽)。 */
  standaloneDeliveryPending?: boolean
  /** Selected intent's spec.md content (intent detail `spec` tab); null=未加载/无。 */
  intentSpecContent: string | null
  intentSpecLoading: boolean
  /** Per-session run status map;用于判定选中意图 spec 会话是否运行中(直接编辑 spec 门禁③)。 */
  sessionStatus?: Record<string, SessionStatus>
  /** Per-intent lifecycle-log cache (intent detail `changelog` tab),按 intent id 取。 */
  intentLogsById: Record<string, IntentLog[]>
  intentLogsLoading: boolean
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
  /** 活动会话的权限模式 token / codex 双策略 / 可选项,透传到两处聊天列的标题栏。 */
  mode?: ModeToken
  codexPolicy?: CodexPolicy | null
  modeOptions?: { value: ModeToken; label: string }[]
  /** One-shot sub-tab request for IntentDetail (WorkCenter jump-to-source / post-Start-Work jump). */
  requestedIntentSubTab?: RequestedDetailSubTab | null
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
  'repair-worktree': [intentId: string, mode: 'rebuild' | 'merge']
  'dismiss-worktree-baseline': [intentId: string]
  /** 派生「下一步」跳转:列表与详情共用同一条上抛路径,最终落到同一个分发器。 */
  'action-target': [target: ActionTarget]
  'save-intent-content': [intentId: string, content: string]
  'save-spec-content': [intentId: string, content: string]
  'write-spec': [intentId: string]
  'approve-spec': [intentId: string]
  'revoke-spec-approval': [intentId: string]
  'open-spec-session': [intentId: string]
  'open-spec-review-session': [intentId: string]
  'open-intent-session': [sessionId: string]
  'read-spec': [intentId: string, specPath: string]
  'list-intent-logs': [intentId: string]
  'reset-intent-session': [intentId: string, userInput: string]
  'reset-spec-session': [intentId: string, userInput: string]
  'start-intent-session': [intentId: string, text: string, images: PromptImage[]]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-work-session': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  /** 每意图规格模式覆盖(详情概览 Tab);null = 恢复继承工作区。 */
  'set-spec-mode': [intentId: string, mode: IntentSpecMode | null]
  'start-automation': []
  'stop-automation': []
  'open-queue': []
  /** 「+」入口:请求打开新增意图弹窗(不再直接登记空白 draft)。 */
  'new-intent': []
  'create-pr': [intentId: string, deliveryId?: string]
  'sync-pr-status': [intentId: string]
  /** 意图详情「关联交付」跳转:交付页是另一个一级 tab,由 App 切换。 */
  'open-delivery': [deliveryId: string]
  // ── 意图侧交付归属入口(与交付页入口并存,协议消息相同) ──
  'open-link-dialog': [workspaceId: string]
  'link-delivery': [workspaceId: string, deliveryId: string, intentId: string]
  'unlink-delivery': [workspaceId: string, deliveryId: string, intentId: string]
  'standalone-delivery': [payload: StandaloneDeliveryRequest]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  share: [intentId: string]
  delete: [intentId: string]
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
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

// 依赖整组更新:模板内写不下对象字面量的类型标注(花括号会被模板解析器吃掉),
// 所以落成具名 handler。
function handleUpdateDeps(
  intentId: string,
  deps: { dependsOnId: string; depType: DepType }[],
): void {
  emit('update-deps', intentId, deps)
}

// 选中意图的 worktree 基线提示;没被告知过就是 null(绝大多数情况)。
const selectedWorktreeBaselineNotice = computed<WorktreeBaselineNotice | null>(() =>
  selectedIntentId.value ? (props.worktreeBaselineNotices?.[selectedIntentId.value] ?? null) : null,
)

// 选中意图的变更日志(changelog tab),未拉取时为空数组。
const selectedIntentLogs = computed<IntentLog[]>(() =>
  selectedIntentId.value ? (props.intentLogsById[selectedIntentId.value] ?? []) : [],
)

// 选中意图的 spec 会话是否运行中:specSessionId 对应会话状态为活跃态(running /
// awaiting_permission / team)即视为运行中。直接编辑 spec 的门禁③(前端侧;服务端
// 以进程表 isRunning 二次校验)。无 specSessionId 或状态未知则视为不运行。
const ACTIVE_SESSION_STATUSES: SessionStatus[] = ['running', 'awaiting_permission', 'team']
const selectedSpecSessionRunning = computed<boolean>(() => {
  const id = selectedIntent.value?.specSessionId
  if (!id) return false
  const st = props.sessionStatus?.[id]
  return st !== undefined && ACTIVE_SESSION_STATUSES.includes(st)
})

// 选中意图最新工作会话(lastWorkSessionId)的运行状态,派生给 IntentDetail 的工作会话 tab
// 标签状态点。无 lastWorkSessionId 或状态未知时为 null(不显示状态点)。
const selectedWorkSessionStatus = computed<SessionStatus | null>(() => {
  const id = selectedIntent.value?.lastWorkSessionId
  if (!id) return null
  return props.sessionStatus?.[id] ?? null
})

// 选中意图的意图会话(intentSessionId)运行状态,派生给 IntentDetail 的意图会话 tab
// 标签状态点。无 intentSessionId 或状态未知时为 null(不显示状态点)。
const selectedIntentSessionStatus = computed<SessionStatus | null>(() => {
  const id = selectedIntent.value?.intentSessionId
  if (!id) return null
  return props.sessionStatus?.[id] ?? null
})

// 选中意图的 spec 会话(specSessionId)运行状态,派生给 IntentDetail 的编写规范 tab
// 标签状态点。无 specSessionId 或状态未知时为 null(不显示状态点)。纯展示用,与上方
// 直接编辑 spec 门禁的 selectedSpecSessionRunning 相互独立。
const selectedSpecSessionStatus = computed<SessionStatus | null>(() => {
  const id = selectedIntent.value?.specSessionId
  if (!id) return null
  return props.sessionStatus?.[id] ?? null
})

// 选中意图的评审会话(specReviewSessionId)运行状态,派生给 IntentDetail 的评审 tab
// 标签状态点。无 specReviewSessionId 或状态未知时为 null(不显示状态点)。
const selectedSpecReviewSessionStatus = computed<SessionStatus | null>(() => {
  const id = selectedIntent.value?.specReviewSessionId
  if (!id) return null
  return props.sessionStatus?.[id] ?? null
})

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
    viewingNewIntentSession.value = false
    mobileActiveKey.value = 'right'
    emit('requested-intent-consumed')
  },
  { immediate: true },
)

// External one-shot request to open a standalone intent (chat) session here (a chat
// with no owning intent, traced from the session page's title-bar source button):
// flip the right column to the standalone chat and signal the parent to clear the
// request. `requestedIntentSessionId` is consumed on the same tick, so the target
// is captured into a local ref — the column only counts as session-bound once the
// global active session has actually aligned with it (跳转窗口期间不渲染旧会话状态)。
const capturedIntentSessionId = ref<string | null>(null)
watch(
  () => props.requestedIntentSessionId,
  (sessionId) => {
    if (!sessionId) return
    capturedIntentSessionId.value = sessionId
    viewingNewIntentSession.value = true
    emit('requested-intent-session-consumed')
  },
  { immediate: true },
)

// 离开独立会话聊天列(点意图行 / 外部意图选择跳走)即复位捕获,避免旧捕获残留。
watch(viewingNewIntentSession, (v) => {
  if (!v) capturedIntentSessionId.value = null
})

// 独立聊天列是否已绑定到目标会话:捕获 id 非空且活动会话已对齐。
const standaloneSessionBound = computed<boolean>(
  () =>
    capturedIntentSessionId.value !== null && props.activeSession === capturedIntentSessionId.value,
)
// 未对齐窗口内标题取中性兜底文案,不显示上一会话的 activeTitle。
const standaloneActiveTitle = computed<string>(() =>
  standaloneSessionBound.value ? props.activeTitle : t('intent.intentSession.title.label'),
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

// 外部子 tab 请求若与一个尚未落入快照的意图选择请求同时到达，先不把它交给当前
// 详情页，避免旧意图提前消费。目标意图选中后再透传，由新详情页打开指定 tab。
const detailRequestedSubTab = computed(() => {
  if (props.requestedIntentId && selectedIntentId.value !== props.requestedIntentId) return null
  return props.requestedIntentSubTab ?? null
})

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
        :create-intent-pending="createIntentPending"
        :selected-intent-id="selectedIntentId"
        @filter="(status: IntentStatus | null) => emit('filter', status)"
        @start-automation="emit('start-automation')"
        @stop-automation="emit('stop-automation')"
        @open-queue="emit('open-queue')"
        @select-intent="handleSelectIntent"
        @ordered-change="handleOrderedChange"
        @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
        @action-target="(target: ActionTarget) => emit('action-target', target)"
        @new-intent="emit('new-intent')"
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
        :deliveries="deliveries"
        :worktree-baseline-notice="selectedWorktreeBaselineNotice"
        :standalone-delivery-pending="standaloneDeliveryPending"
        :requested-sub-tab="detailRequestedSubTab"
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
        :mode="mode"
        :codex-policy="codexPolicy"
        :mode-options="modeOptions"
        :intent-spec-content="intentSpecContent"
        :intent-spec-loading="intentSpecLoading"
        :spec-session-running="selectedSpecSessionRunning"
        :work-session-status="selectedWorkSessionStatus"
        :intent-session-status="selectedIntentSessionStatus"
        :spec-session-status="selectedSpecSessionStatus"
        :spec-review-session-status="selectedSpecReviewSessionStatus"
        :intent-logs="selectedIntentLogs"
        :intent-logs-loading="intentLogsLoading"
        @refine="(id: string) => emit('refine', id)"
        @repair-worktree="
          (id: string, mode: 'rebuild' | 'merge') => emit('repair-worktree', id, mode)
        "
        @dismiss-worktree-baseline="(id: string) => emit('dismiss-worktree-baseline', id)"
        @save-intent-content="
          (id: string, content: string) => emit('save-intent-content', id, content)
        "
        @save-spec-content="(id: string, content: string) => emit('save-spec-content', id, content)"
        @list-intent-logs="(id: string) => emit('list-intent-logs', id)"
        @write-spec="(id: string) => emit('write-spec', id)"
        @approve-spec="(id: string) => emit('approve-spec', id)"
        @revoke-spec-approval="(id: string) => emit('revoke-spec-approval', id)"
        @open-spec-session="(id: string) => emit('open-spec-session', id)"
        @open-spec-review-session="(id: string) => emit('open-spec-review-session', id)"
        @open-intent-session="(sessionId: string) => emit('open-intent-session', sessionId)"
        @read-spec="(id: string, specPath: string) => emit('read-spec', id, specPath)"
        @reset-intent-session="
          (id: string, input: string) => emit('reset-intent-session', id, input)
        "
        @reset-spec-session="(id: string, input: string) => emit('reset-spec-session', id, input)"
        @start-intent-session="
          (id: string, text: string, images: PromptImage[]) =>
            emit('start-intent-session', id, text, images)
        "
        @start-dev="(id: string, hasDeps: boolean) => emit('start-dev', id, hasDeps)"
        @open-work-session="(sessionId: string) => emit('open-work-session', sessionId)"
        @set-status="(id: string, status: IntentStatus) => emit('set-status', id, status)"
        @delete="(id: string) => emit('delete', id)"
        @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
        @set-spec-mode="
          (id: string, mode: IntentSpecMode | null) => emit('set-spec-mode', id, mode)
        "
        @create-pr="(id: string, deliveryId?: string) => emit('create-pr', id, deliveryId)"
        @sync-pr-status="(id: string) => emit('sync-pr-status', id)"
        @share="(id: string) => emit('share', id)"
        @update-deps="handleUpdateDeps"
        @select-dependency="handleSelectDependency"
        @open-delivery="(id: string) => emit('open-delivery', id)"
        @open-link-dialog="(ws: string) => emit('open-link-dialog', ws)"
        @link-delivery="
          (ws: string, deliveryId: string, id: string) => emit('link-delivery', ws, deliveryId, id)
        "
        @unlink-delivery="
          (ws: string, deliveryId: string, id: string) =>
            emit('unlink-delivery', ws, deliveryId, id)
        "
        @standalone-delivery="(p: StandaloneDeliveryRequest) => emit('standalone-delivery', p)"
        @set-mode="(m: ModeToken) => emit('set-mode', m)"
        @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
        @set-session-agent="(agentId: string) => emit('set-session-agent', agentId)"
        @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
        @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
        @requested-subtab-consumed="emit('requested-subtab-consumed')"
        @action-target="(target: ActionTarget) => emit('action-target', target)"
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
        :active-title="standaloneActiveTitle"
        :session-bound="standaloneSessionBound"
        :vendor="vendor ?? null"
        :agent-switch="agentSwitch ?? null"
        :show-mode="true"
        :mode="mode"
        :codex-policy="codexPolicy"
        :mode-options="modeOptions"
        :mode-disabled="true"
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
