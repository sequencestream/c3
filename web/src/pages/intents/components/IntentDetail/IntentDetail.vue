<script lang="ts">
import { resetWriteSpecGuards } from './useSpecApprovalGate'

// 仅供单测重置模块级防误审门状态,隔离用例之间的污染;生产代码不调用。
// 门状态本体活在 useSpecApprovalGate 的模块作用域,使组件重挂载 / 重选意图后 10 秒窗口仍存活。
export function __resetWriteSpecGuards(): void {
  resetWriteSpecGuards()
}
</script>

<script setup lang="ts">
/*
 * IntentDetail.vue — 需求页右栏:选中意图的详情面板容器(常驻头部 + 七 tab,评审 tab 条件可见)。
 *
 * 本组件收敛为详情页容器:装配 Tab 状态机(useIntentDetailTabs)与编写 Spec 门 / 延迟切 Tab
 * 组合逻辑(useSpecApprovalGate),编排四态主按钮与会话重置弹框,并把标题栏动作、工程进度、Tab
 * 导航、三类内容区(意图/Spec/变更日志)与会话面板分派给各子单元。对 Intents.vue 的 props /
 * emits / prefill 能力保持兼容;拆出的子组件只使用页面内部契约。列表为空(无选中意图)时渲染空态。
 */
import { computed, ref, watch } from 'vue'
import type { ActionTarget, DepType, Intent, IntentLog, IntentStatus } from '@ccc/shared/protocol'
import type {
  CodexPolicy,
  ModeToken,
  PromptImage,
  SessionAgentSwitch,
  SessionStatus,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { PendingItem } from '../../../../lib/pending-queue'
import type { TaskListModel } from '../../../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../../../lib/chat-types'
import { useTypedI18n } from '@/i18n'
import ResetSessionDialog from '../../../../components/ResetSessionDialog/ResetSessionDialog.vue'
import ActionDescriptorBanner from '../../../../components/ActionDescriptorBanner/ActionDescriptorBanner.vue'
import { hasDependencyBlockingSpecSession, statusLabel } from '../../../../lib/intent-list-view'
import { actionTargetIntent } from '../../../../lib/action-descriptor'
import IntentEngineeringProgress from './IntentEngineeringProgress.vue'
import IntentTitleBarActions from './IntentTitleBarActions.vue'
import IntentDetailTabs from './IntentDetailTabs.vue'
import IntentOverviewTab from './IntentOverviewTab.vue'
import IntentSpecTab from './IntentSpecTab.vue'
import IntentChangelogTab from './IntentChangelogTab.vue'
import IntentSessionPanel from './IntentSessionPanel.vue'
import { useIntentDetailTabs, type RequestedDetailSubTab } from './useIntentDetailTabs'
import { useSpecApprovalGate, type MainAction } from './useSpecApprovalGate'

const { t } = useTypedI18n()

const props = defineProps<{
  /** 当前选中的意图;null 表示无选中(列表为空)→ 渲染空态。 */
  intent: Intent | null
  /** 全量意图列表,用于依赖标题查询与未完成依赖判定。 */
  intents: Intent[]
  /** 服务端动作错误序号自增时复位 start-dev in-flight 守卫。 */
  intentActionErrorSeq?: number
  /** Per-intent one-shot PR/MR sync feedback from the control layer. */
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  /** 当前 workspace 的 SDD 总开关,驱动主操作按钮四态(关→Start Work)。 */
  sddEnabled?: boolean
  /** 当前 workspace 配置的主分支;intent 分支与其相同时不显示 Create PR。 */
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
  // ── chat column passthrough(intent session / spec session 两 tab 共用)──
  /** 全局活动会话 id;与期望会话 id 一致时聊天列才渲染(防串台)。 */
  activeSession: string | null
  activeTitle: string
  vendor?: VendorId | null
  agentSwitch?: SessionAgentSwitch | null
  hasActiveSession: boolean
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  hasTaskStore?: boolean
  running: boolean
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  currentAgentName?: string
  reconnecting?: boolean
  sideEffectPending?: boolean
  queue: PendingItem[]
  availableCommands: SlashCommandInfo[]
  voiceLang: string
  // ── 权限模式(标题栏)──
  /** 活动会话的权限模式 token / codex 双策略,与会话页共用同一份控制层状态。 */
  mode?: ModeToken
  codexPolicy?: CodexPolicy | null
  modeOptions?: { value: ModeToken; label: string }[]
  // ── spec 文档(spec tab)──
  /** 选中意图 spec.md 内容;null=未加载/无。 */
  intentSpecContent: string | null
  intentSpecLoading: boolean
  /** 该意图的 spec 会话是否运行中(specSessionId 对应会话活跃);直接编辑 spec 的门禁之一。 */
  specSessionRunning?: boolean
  /** 最新工作会话(lastWorkSessionId)运行状态,用于工作会话 tab 标签的运行中状态点。 */
  workSessionStatus?: SessionStatus | null
  /** 意图会话(intentSessionId)运行状态,用于意图会话 tab 标签的运行中状态点。 */
  intentSessionStatus?: SessionStatus | null
  /** spec 会话(specSessionId)运行状态,用于编写规范 tab 标签的运行中状态点;
   * 与门禁用的 specSessionRunning 相互独立,只服务标签呈现。 */
  specSessionStatus?: SessionStatus | null
  /** 评审会话(specReviewSessionId)运行状态,用于评审 tab 标签的运行中状态点。 */
  specReviewSessionStatus?: SessionStatus | null
  // ── 变更日志(changelog tab)──
  /** 选中意图的生命周期变更日志(倒序);切到 changelog tab 时懒加载。 */
  intentLogs: IntentLog[]
  intentLogsLoading: boolean
  /** One-shot request from WorkCenter jump-to-source or the post-Start-Work jump:
   * force a detail sub-tab switch (intentSession / specSession / specReviewSession /
   * workSession).
   * Cleared via `requested-subtab-consumed`. */
  requestedSubTab?: RequestedDetailSubTab | null
}>()

const emit = defineEmits<{
  refine: [intentId: string]
  // 直接编辑意图正文:上抛 id + 新正文,由控制层透传为 update_intent_content。
  'save-intent-content': [intentId: string, content: string]
  'write-spec': [intentId: string]
  'approve-spec': [intentId: string]
  'revoke-spec-approval': [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  // 内嵌工作会话 tab 激活:请求控制层把 lastWorkSessionId 选为全局活动会话(不进会话页)。
  'open-work-session': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'create-pr': [intentId: string]
  'sync-pr-status': [intentId: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  'select-dependency': [intentId: string]
  /** 跳到某个关联交付的详情页(交付页在另一个一级 tab,故一路上抛到 App)。 */
  'open-delivery': [deliveryId: string]
  // 分享:上抛意图 id,由 App 组装深链复制(workspace/typeLabel 在上层)。
  share: [intentId: string]
  delete: [intentId: string]
  // ── 会话/spec 打开 ──
  'open-intent-session': [sessionId: string]
  'open-spec-session': [intentId: string]
  // 只读评审会话:同样以意图 id 上抛,由服务端按意图当前关联解析并恢复 spec_review runtime。
  'open-spec-review-session': [intentId: string]
  'read-spec': [intentId: string, specPath: string]
  // 直接编辑 spec 源码:上抛 id + 新内容,由控制层透传为 update_spec_content。
  'save-spec-content': [intentId: string, content: string]
  'list-intent-logs': [intentId: string]
  // ── 会话重置(带新输入,拼接意图/spec 内容新起会话) ──
  'reset-intent-session': [intentId: string, userInput: string]
  'reset-spec-session': [intentId: string, userInput: string]
  'start-intent-session': [intentId: string, text: string, images: PromptImage[]]
  // ── chat column passthrough ──
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
  // ── 外部子 tab 请求消耗 ──
  'requested-subtab-consumed': []
  /** 派生「下一步」跳转:与 IntentList 汇入同一个分发器,两处跳法完全一致。 */
  'action-target': [target: ActionTarget]
}>()

// 全量意图按 id 索引:未完成依赖判定与「下一步」提示条的前序解析共用同一份。
const intentById = computed(() => new Map(props.intents.map((x) => [x.id, x])))

// ── 未完成依赖(非 done 的前置意图) ───────────────────────────────────────
const unfinishedDeps = computed<Intent[]>(() => {
  const r = props.intent
  if (!r) return []
  const byId = intentById.value
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Intent => !!x && x.status !== 'done')
})

// ── start-dev in-flight 守卫 ────────────────────────────────────────────────
const startDevInFlight = ref(false)
watch(
  () => props.intent?.status,
  (s) => {
    if (s !== 'todo') startDevInFlight.value = false
  },
)
watch(
  () => props.intentActionErrorSeq,
  (next, prev) => {
    // 任一 intent.* 动作被服务端拒绝都会自增该 seq;释放 start-dev 守卫让按钮重新可点。
    // 直接编辑的保存守卫由各内容区子组件自行监听同一 seq 释放。
    if (next !== prev) startDevInFlight.value = false
  },
)
watch(
  () => props.intent?.id,
  () => {
    startDevInFlight.value = false
  },
)

function startDev(): void {
  const r = props.intent
  if (!r || startDevInFlight.value) return
  const hasUnfinishedDeps = unfinishedDeps.value.length > 0
  if (hasUnfinishedDeps && !window.confirm(t('intent.startDev.confirmUnfinishedDeps'))) return
  startDevInFlight.value = true
  emit('start-dev', r.id, hasUnfinishedDeps)
}

// ── 主操作按钮四态机(只对 todo 意图渲染) ──────────────────────────────────
// 投影只看 specStatus:raw(无 spec,或只有服务端播种的占位)一律停在「编写 Spec」——
// 此时点它继续/恢复撰写会话,而不是把一份还没写出来的文档推给人审批;pending 才是「批准 Spec」;
// approved 才是「开始工作」。不再用 specPath + specApproved 组合推断。
const mainAction = computed<MainAction>(() => {
  const r = props.intent
  if (!r || !props.sddEnabled) return 'startDev'
  if (r.specStatus === 'raw') return 'writeSpec'
  if (r.specStatus === 'pending') return 'approveSpec'
  return 'startDev'
})
const mainActionLabel = computed<string>(() => {
  switch (mainAction.value) {
    case 'writeSpec':
      return t('intent.action.writeSpec.label')
    case 'approveSpec':
      return t('intent.action.approveSpec.label')
    default:
      return t('intent.action.startDev.label')
  }
})
const specDependencyBlocked = computed<boolean>(() =>
  hasDependencyBlockingSpecSession(
    props.intent,
    props.intents,
    props.workspaceGitBranchMode,
    props.workspaceMainBranch,
  ),
)
const mainActionDisabled = computed<boolean>(
  () =>
    (mainAction.value === 'startDev' && startDevInFlight.value) ||
    (mainAction.value === 'writeSpec' && specDependencyBlocked.value),
)
const mainActionTitle = computed<string>(() =>
  mainAction.value === 'writeSpec' && specDependencyBlocked.value
    ? t('intent.specLaunch.dependencyNotMerged')
    : mainActionLabel.value,
)

// ── Tab 状态机 ──────────────────────────────────────────────────────────────
const {
  activeTab,
  visibleTabs,
  workSessionStatusDot,
  intentSessionStatusDot,
  specSessionStatusDot,
  specReviewSessionStatusDot,
  expectedSessionId,
  chatReady,
  chatReadonly,
  firstIntentTurn,
  modeLocked,
  selectTab,
  markPendingSpecSwitch,
} = useIntentDetailTabs({
  intent: () => props.intent,
  sddEnabled: () => props.sddEnabled === true,
  activeSession: () => props.activeSession,
  requestedSubTab: () => props.requestedSubTab,
  intentLogsLength: () => props.intentLogs.length,
  workSessionStatus: () => props.workSessionStatus,
  intentSessionStatus: () => props.intentSessionStatus,
  specSessionStatus: () => props.specSessionStatus,
  specReviewSessionStatus: () => props.specReviewSessionStatus,
  onReadSpec: (id, specPath) => emit('read-spec', id, specPath),
  onListIntentLogs: (id) => emit('list-intent-logs', id),
  onOpenIntentSession: (sessionId) => emit('open-intent-session', sessionId),
  onOpenSpecSession: (id) => emit('open-spec-session', id),
  onOpenSpecReviewSession: (id) => emit('open-spec-review-session', id),
  onOpenWorkSession: (sessionId) => emit('open-work-session', sessionId),
  onRequestedSubTabConsumed: () => emit('requested-subtab-consumed'),
})

// ── 编写 Spec 门 + 延迟切 Tab(Tab 与动作之间的跨域协调) ───────────────────
const { approveGateBlocked, triggerWriteSpec } = useSpecApprovalGate({
  intent: () => props.intent,
  mainAction,
  onSwitchToSpecSession: () => selectTab('specSession'),
})

function onMainAction(): void {
  const r = props.intent
  if (!r) return
  if (mainAction.value === 'writeSpec') {
    emit('write-spec', r.id)
    // 武装防误审门(以触发时刻锚定),并约 1 秒后自动切到 spec session Tab。
    triggerWriteSpec(r.id)
    return
  }
  if (mainAction.value === 'approveSpec') {
    selectTab('spec')
    return
  }
  startDev()
}

// ── 会话重置弹框(intent session / spec session 共用,按入口分流) ─────────────
const resetDialogOpen = ref(false)
const resetDialogTarget = ref<'intentSession' | 'specSession'>('intentSession')
const canResetIntentSession = computed<boolean>(
  () => !!props.intent && !props.intent.lastWorkSessionId,
)
const canResetSpecSession = computed<boolean>(
  () => !!props.intent && !props.intent.lastWorkSessionId && !!props.intent.specPath,
)
const resetDialogTitle = computed<string>(() =>
  resetDialogTarget.value === 'specSession'
    ? t('intent.resetSession.specSession.title')
    : t('intent.resetSession.intentSession.title'),
)
const resetDialogMessage = computed<string>(() =>
  resetDialogTarget.value === 'specSession'
    ? t('intent.resetSession.specSession.message')
    : t('intent.resetSession.intentSession.message'),
)
function openResetDialog(target: 'intentSession' | 'specSession'): void {
  if (target === 'intentSession' && !canResetIntentSession.value) return
  if (target === 'specSession' && !canResetSpecSession.value) return
  resetDialogTarget.value = target
  resetDialogOpen.value = true
}
function onResetConfirm(text: string): void {
  const r = props.intent
  resetDialogOpen.value = false
  if (!r) return
  if (resetDialogTarget.value === 'specSession') {
    // 记录待切状态:新 spec 会话创建成功后由 Tab 状态机自动切到 spec session tab。
    markPendingSpecSwitch(r.id, r.specSessionId)
    emit('reset-spec-session', r.id, text)
  } else {
    emit('reset-intent-session', r.id, text)
  }
}

// ── Spec tab 顶部操作区可见性(承接四态主按钮 + 防误审门 + Spec 依赖门) ───────
const showSpecApproveAction = computed<boolean>(
  () => !!props.intent && props.intent.status === 'todo' && mainAction.value === 'approveSpec',
)
const showSpecApprove = computed<boolean>(
  () => showSpecApproveAction.value && !approveGateBlocked.value,
)
const showSpecModify = computed<boolean>(
  () => canResetSpecSession.value || specDependencyBlocked.value,
)

// ── Composer 透传(供 App.vue 待发队列「编辑」回填) ──────────────────────────
const sessionPanel = ref<InstanceType<typeof IntentSessionPanel> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => sessionPanel.value?.prefill(text, images),
})

function submitChat(text: string, images: PromptImage[]): void {
  const r = props.intent
  if (firstIntentTurn.value && r) emit('start-intent-session', r.id, text, images)
  else emit('submit', text, images)
}
</script>

<template>
  <section class="intent-detail" data-testid="intent-detail">
    <p v-if="!intent" class="intent-detail-empty" data-testid="intent-detail-empty">
      {{ t('intent.list.empty') }}
    </p>
    <template v-else>
      <!-- 常驻头部:标题信息 + 右侧操作 + 工程进度条 -->
      <header class="intent-detail-head">
        <div class="intent-detail-titlebar">
          <div class="intent-detail-title-main">
            <h2 class="intent-detail-title" :title="intent.content">{{ intent.title }}</h2>
            <span v-if="intent.module" class="req-module" :title="intent.module">{{
              intent.module
            }}</span>
            <span class="req-priority" :class="intent.priority">{{ intent.priority }}</span>
            <span class="req-status" :class="intent.status">{{ statusLabel(intent.status) }}</span>
          </div>
          <div class="intent-detail-title-meta">
            <IntentTitleBarActions
              :intent="intent"
              :workspace-main-branch="workspaceMainBranch"
              :workspace-git-branch-mode="workspaceGitBranchMode"
              :intent-pr-sync="intentPrSync"
              :main-action="mainAction"
              :main-action-label="mainActionLabel"
              :main-action-disabled="mainActionDisabled"
              :main-action-title="mainActionTitle"
              @set-status="(id: string, s: IntentStatus) => emit('set-status', id, s)"
              @set-automate="(id: string, a: boolean) => emit('set-automate', id, a)"
              @create-pr="(id: string) => emit('create-pr', id)"
              @sync-pr-status="(id: string) => emit('sync-pr-status', id)"
              @share="(id: string) => emit('share', id)"
              @delete="(id: string) => emit('delete', id)"
              @main-action="onMainAction"
              @modify="openResetDialog('intentSession')"
            />
          </div>
        </div>
        <!-- 派生「下一步」:常驻在详情头部主信息区,与列表行共用同一组件与同一分发器。
             它只提示与导航,不遮断详情本身的任何操作。 -->
        <ActionDescriptorBanner
          :descriptor="intent.actionDescriptor"
          :review-reason="intent.specReviewReason"
          :target-intent="actionTargetIntent(intent.actionDescriptor, intentById)"
          @navigate="(target: ActionTarget) => emit('action-target', target)"
        />
        <IntentEngineeringProgress
          :intent="intent"
          :sdd-enabled="sddEnabled === true"
          :workspace-git-branch-mode="workspaceGitBranchMode"
        />
      </header>

      <!-- Tab 条 -->
      <IntentDetailTabs
        :tabs="visibleTabs"
        :active-tab="activeTab"
        :work-session-status-dot="workSessionStatusDot"
        :intent-session-status-dot="intentSessionStatusDot"
        :spec-session-status-dot="specSessionStatusDot"
        :spec-review-session-status-dot="specReviewSessionStatusDot"
        @select="selectTab"
      />

      <!-- intent tab:元信息 + 正文 + 依赖 -->
      <IntentOverviewTab
        v-if="activeTab === 'intent'"
        :intent="intent"
        :intents="intents"
        :intent-action-error-seq="intentActionErrorSeq"
        :intent-pr-sync="intentPrSync"
        @refine="(id: string) => emit('refine', id)"
        @save-intent-content="(id: string, c: string) => emit('save-intent-content', id, c)"
        @update-deps="(id, deps) => emit('update-deps', id, deps)"
        @select-dependency="(id: string) => emit('select-dependency', id)"
        @open-delivery="(id: string) => emit('open-delivery', id)"
        @sync-pr-status="(id: string) => emit('sync-pr-status', id)"
      />

      <!-- spec tab:渲染 spec.md(或纯文本源码直接编辑) -->
      <IntentSpecTab
        v-else-if="activeTab === 'spec'"
        :intent="intent"
        :intent-spec-content="intentSpecContent"
        :intent-spec-loading="intentSpecLoading"
        :spec-session-running="specSessionRunning"
        :intent-action-error-seq="intentActionErrorSeq"
        :show-approve="showSpecApprove"
        :show-modify="showSpecModify"
        :modify-disabled="specDependencyBlocked"
        @approve-spec="(id: string) => emit('approve-spec', id)"
        @revoke-spec-approval="(id: string) => emit('revoke-spec-approval', id)"
        @save-spec-content="(id: string, c: string) => emit('save-spec-content', id, c)"
        @read-spec="(id: string, p: string) => emit('read-spec', id, p)"
        @modify="openResetDialog('specSession')"
      />

      <!-- changelog tab:生命周期变更日志(倒序) -->
      <IntentChangelogTab
        v-else-if="activeTab === 'changelog'"
        :intent-logs="intentLogs"
        :intent-logs-loading="intentLogsLoading"
      />

      <!-- intent / spec / spec review / work session tab:复用聊天列(评审为只读回放) -->
      <IntentSessionPanel
        v-else
        ref="sessionPanel"
        :active-tab="activeTab"
        :expected-session-id="expectedSessionId"
        :chat-ready="chatReady"
        :chat-readonly="chatReadonly"
        :first-intent-turn="firstIntentTurn"
        :intent-title="intent.title"
        :active-title="activeTitle"
        :mode-locked="modeLocked"
        :vendor="vendor"
        :agent-switch="agentSwitch"
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
        @set-mode="(m: ModeToken) => emit('set-mode', m)"
        @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
        @set-session-agent="(id: string) => emit('set-session-agent', id)"
        @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
        @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
        @refresh="emit('refresh')"
        @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
        @delete-queued="(id: number) => emit('delete-queued', id)"
        @submit="submitChat"
        @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
        @stop="emit('stop')"
        @continue="emit('continue')"
        @list-commands="emit('list-commands')"
      />
    </template>

    <!-- 会话重置输入弹框 -->
    <ResetSessionDialog
      :open="resetDialogOpen"
      :title="resetDialogTitle"
      :message="resetDialogMessage"
      :placeholder="t('intent.resetSession.placeholder')"
      :confirm-label="t('intent.action.modifySession.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="onResetConfirm"
      @cancel="resetDialogOpen = false"
    />
  </section>
</template>

<style scoped>
.intent-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--c-bg);
}
.intent-detail-empty {
  margin: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
.intent-detail-head {
  height: auto;
  flex-shrink: 0;
  padding: var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
}
.intent-detail-titlebar {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--sp-3);
}
.intent-detail-title-main {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
  text-align: left;
}
.intent-detail-title-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
  text-align: right;
}
.intent-detail-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: var(--lh-tight);
  color: var(--c-text);
  word-break: break-word;
}
@media (max-width: 640px) {
  .intent-detail-titlebar {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-2);
  }
  .intent-detail-title-main {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .intent-detail-title-meta {
    justify-content: flex-start;
  }
}
</style>
