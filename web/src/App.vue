<script setup lang="ts">
// App.vue is a thin entry: all controller logic (state, the WebSocket message
// router, and every domain action) lives under `./controls`. `useAppController`
// builds one shared `ctx` object and we destructure it here — the destructured
// refs/computeds stay the SAME reactive objects, so the template below is
// unchanged. See controls/index.ts for the decomposition map.
import AppHeader from './components/AppHeader/AppHeader.vue'
import Login from './pages/login/Login.vue'
import Queue from './pages/queue/Queue.vue'
import AsyncViewLoading from './components/AsyncFallback/AsyncViewLoading.vue'
import AsyncViewError from './components/AsyncFallback/AsyncViewError.vue'
import AsyncOverlayLoading from './components/AsyncFallback/AsyncOverlayLoading.vue'
import AsyncOverlayError from './components/AsyncFallback/AsyncOverlayError.vue'
import {
  computed,
  defineAsyncComponent,
  ref,
  watch,
  type AsyncComponentLoader,
  type Component,
} from 'vue'
import type { SessionInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from './i18n'
import { useAppController } from './controls'
import { FILES_CHAT_WIDTH_DEFAULT } from './controls/state'

// ── 懒加载装配约定 ─────────────────────────────────────────────────────────
// App.vue 是唯一的装配边界:重量级业务页面与低频全局组件都由 defineAsyncComponent
// 包一层动态 import,首次真正渲染时才拉取各自的 chunk。首屏只留登录门、顶栏、toast
// 与当前分支需要的代码;静态 import 仅保留这三者和轻量的 Queue(意图页兄弟视图)。
// 两个门槛必须同时守住,少一个懒加载就不成立:
//   1. 挂载点必须带 v-if——tab 分支天然有,弹窗/覆盖层则以各自的 open/model/状态做门。
//      无条件挂载的 wrapper 一上来就会触发 loader,即使组件内部靠 open 隐藏也照样下载。
//   2. loading/error 走统一兜底(components/AsyncFallback):页面级占住内容区的 flex
//      位置,弹窗级占住同层遮罩,不留白屏、不改布局;失败只静态兜底,不自动重试。
// 条件回到 false 时 wrapper 卸载,再次打开复用已解析的组件与浏览器缓存,不重复下载。
function asyncView<T extends Component>(loader: AsyncComponentLoader<T>): T {
  return defineAsyncComponent<T>({
    loader,
    loadingComponent: AsyncViewLoading,
    errorComponent: AsyncViewError,
  })
}
function asyncOverlay<T extends Component>(loader: AsyncComponentLoader<T>): T {
  return defineAsyncComponent<T>({
    loader,
    loadingComponent: AsyncOverlayLoading,
    errorComponent: AsyncOverlayError,
  })
}

// 业务页面:首次进入对应 tab / workcenter 页面时加载。
const Works = asyncView(() => import('./pages/works/Works.vue'))
const Intents = asyncView(() => import('./pages/intents/Intents.vue'))
const Deliveries = asyncView(() => import('./pages/deliveries/Deliveries.vue'))
const Discussions = asyncView(() => import('./pages/discussions/Discussions.vue'))
const Automations = asyncView(() => import('./pages/automations/Automations.vue'))
const Files = asyncView(() => import('./pages/files/Files.vue'))
const WorkCenter = asyncView(() => import('./pages/workcenter/WorkCenter.vue'))
const Dashboard = asyncView(() => import('./pages/workcenter/components/WorkspaceDashboard.vue'))

// 设置页与低频全局组件:首次打开(门控条件转 true)时加载。
const SystemSettingsPage = asyncOverlay(() => import('./pages/systemsettings/SystemSettings.vue'))
const WorkspaceSettingPage = asyncOverlay(
  () => import('./pages/workspacesetting/WorkspaceSetting.vue'),
)
const PersonalizedSettingPage = asyncOverlay(
  () => import('./pages/personalizedsetting/PersonalizedSetting.vue'),
)
const SkillApprovalModal = asyncOverlay(
  () => import('./components/SkillApprovalModal/SkillApprovalModal.vue'),
)
const NewSessionModal = asyncOverlay(
  () => import('./pages/works/components/NewSessionModal/NewSessionModal.vue'),
)
const CreatePrOverlay = asyncOverlay(
  () => import('./components/CreatePrOverlay/CreatePrOverlay.vue'),
)
const CreateIntentOverlay = asyncOverlay(
  () => import('./components/CreateIntentOverlay/CreateIntentOverlay.vue'),
)
const DevStartupOverlay = asyncOverlay(
  () => import('./components/DevStartupOverlay/DevStartupOverlay.vue'),
)
const SpecStartupOverlay = asyncOverlay(
  () => import('./components/SpecStartupOverlay/SpecStartupOverlay.vue'),
)
const AutomationSaveOverlay = asyncOverlay(
  () => import('./components/AutomationSaveOverlay/AutomationSaveOverlay.vue'),
)
const IntentActionErrorDialog = asyncOverlay(
  () => import('./components/IntentActionErrorDialog/IntentActionErrorDialog.vue'),
)
const GateEscapeDialog = asyncOverlay(
  () => import('./components/GateEscapeDialog/GateEscapeDialog.vue'),
)
const CreateIntentDialog = asyncOverlay(
  () => import('./pages/intents/components/CreateIntentDialog/CreateIntentDialog.vue'),
)

const { t } = useTypedI18n()

const {
  // ---- auth / connection / top bar ----
  auth,
  authStatus,
  updateStatus,
  selfUpdate,
  startSelfUpdate,
  applySelfUpdate,
  status,
  workspaces,
  currentWorkspace,
  HEADER_TABS,
  activeTab,
  viewMode,
  workcenterPendingCount,
  onSelectTab,
  setViewMode,
  openSettings,
  openPersonalizedSetting,
  openWorkspaceSetting,
  addWorkspace,
  addWorkspaceOpen,
  workspaceDirectoryPicker,
  selectWorkspaceDirectory,
  selectWorkspace,
  removeWorkspace,
  // ---- console (Works) ----
  currentSessions,
  activeSessionKind,
  sessionCounts,
  currentSessionPaging,
  sessionStatus,
  activeWorkspace,
  activeSession,
  activeTitle,
  activeVendor,
  activeAgentSwitch,
  activeSessionSource,
  activeSessionReadonly,
  sessionCapabilities,
  hasActiveSession,
  mode,
  modeOptions,
  codexPolicy,
  messages,
  actionablePermId,
  taskModel,
  taskStoreAvailable,
  running,
  activeIsTeam,
  activity,
  currentAgentName,
  reconnecting,
  sideEffectPending,
  currentQueue,
  availableCommands,
  serverSettings,
  composer,
  openNewSession,
  refreshSessions,
  selectSessionKind,
  loadMoreSessions,
  selectSession,
  jumpSessionSource,
  jumpActiveSessionSource,
  deleteSession,
  renameSession,
  setMode,
  setCodexPolicy,
  onSetSessionAgent,
  respond,
  submitAsk,
  refreshStatus,
  onEditQueued,
  onDeleteQueued,
  onSubmit,
  onEnqueue,
  stopRun,
  onContinue,
  listCommands,
  clearViewedSession,
  // ---- deep link (URL hash routing) ----
  pendingDeepLink,
  clearPendingDeepLink,
  // ---- intents ----
  intentsProject,
  requestedIntentId,
  requestedIntentSubTab,
  awaitingIntentSessionBindId,
  openLinkedIntent,
  requestedIntentSessionId,
  requestedWorkcenterEventId,
  currentIntents,
  currentIntentsSdd,
  currentWorkflow,
  intentActionErrorSeq,
  intentActionError,
  intentActionErrorGuidance,
  intentGateEscape,
  closeIntentGateEscape,
  repairIntentWorktree,
  worktreeBaselineNotices,
  clearWorktreeBaselineNotice,
  createIntentPending,
  intentPrSync,
  closeIntentActionError,
  retryIntentAction,
  intentSpecContent,
  intentSpecLoading,
  intentLogsById,
  intentLogsLoading,
  listIntentLogs,
  setIntentFilter,
  refineIntent,
  writeSpec,
  approveSpec,
  revokeSpecApproval,
  openSpecSession,
  openSpecReviewSession,
  readIntentSpec,
  resetIntentSession,
  resetSpecSession,
  startDevelopment,
  selectWorkSession,
  setIntentStatus,
  deleteIntent,
  setIntentAutomate,
  setIntentSpecMode,
  updateIntentContent,
  saveSpecContent,
  updateIntentDeps,
  createPr,
  syncIntentPrStatus,
  startWorkflow,
  stopWorkflow,
  // ---- automation queue page ----
  queuePageOpen,
  currentQueueDetail,
  openQueuePage,
  closeQueuePage,
  refreshQueueDetail,
  queueControl,
  selectIntentSession,
  createIntent,
  createIntentDialogOpen,
  openCreateIntentDialog,
  closeCreateIntentDialog,
  startIntentSession,
  // ---- deliveries ----
  deliveriesProject,
  currentDeliveries,
  deliveriesNeedsAction,
  activeDeliveryId,
  activeDelivery,
  activeDeliveryPlan,
  activeDeliveryIntents,
  activeDeliveryBranchInit,
  activeDeliveryMainlineAhead,
  activeDeliveryBranchAhead,
  activeDeliverySyncPhase,
  activeDeliveryPr,
  activeDeliveryPrBusy,
  syncDeliveryMainline,
  createDeliveryPr,
  syncDeliveryPr,
  deliveryLinkIntents,
  openDelivery,
  createDelivery,
  updateDelivery,
  cancelDelivery,
  transitionDelivery,
  initDeliveryBranch,
  cleanupDeliveryBranch,
  linkIntentToDelivery,
  unlinkIntentFromDelivery,
  openDeliveryFromIntent,
  onDeliveryMobileBack,
  intentLinkDeliveries,
  pendingStandaloneDelivery,
  loadDeliveriesForLink,
  linkIntentDelivery,
  unlinkIntentDelivery,
  createStandaloneDelivery,
  // ---- discussions ----
  discussionsProject,
  currentDiscussions,
  activeDiscussionId,
  discussionRunState,
  activeDiscussion,
  activeDiscussionRunState,
  discussionMessages,
  researchMessages,
  activeDiscussionPhase,
  discussionLaunch,
  activeDiscussionDispatch,
  discussionInput,
  openDiscussion,
  createDiscussion,
  startDiscussion,
  pauseDiscussion,
  resumeDiscussion,
  cancelDiscussion,
  convertDiscussionToIntent,
  submitDiscussionInput,
  openResearchSession,
  onDiscussionMobileBack,
  // ---- automations ----
  currentAutomations,
  selectedAutomationId,
  selectedAutomation,
  selectedAutomationLogs,
  executionTranscripts,
  automationFormOpen,
  automationFormTarget,
  automationsProject,
  automationTimezone,
  automationEnabled,
  automationEnabledSaving,
  setAutomationEnabled,
  selectedExecutionId,
  automationSaving,
  selectedExecution,
  automationToolManifest,
  automationToolManifestLoading,
  automationToolManifestError,
  hostStatus,
  vendorAvailability,
  sandboxStatus,
  onSelectAutomation,
  openAutomationForm,
  onToggleAutomationEnabled,
  runNowAutomation,
  onLoadExecutionSession,
  onSelectExecution,
  onAutomationMobileBack,
  createAutomation,
  createAutomationFromTemplate,
  importAutomations,
  updateAutomation,
  deleteAutomation,
  onLoadAutomationToolManifest,
  // ---- files ----
  filesProject,
  filesDirs,
  filesExpanded,
  filesLoadingDirs,
  filesGitStatus,
  filesTabs,
  filesActivePath,
  filesActiveTab,
  filesSearchMode,
  filesSearchQuery,
  filesSearchPattern,
  filesSearchResult,
  filesSearchLoading,
  toggleFilesDir,
  refreshFilesTree,
  openFile,
  openFileSearchHit,
  closeFileTab,
  setFilesActiveTab,
  setFilesSearchMode,
  runFileSearch,
  showToast,
  filesBoundSessionId,
  readFilesChatWidth,
  persistFilesChatWidth,
  createFilesChatSession,
  resetFilesChatSession,
  // ---- workcenter ----
  workcenterEvents,
  workcenterHasMore,
  workcenterLoading,
  respondWorkcenter,
  submitAskWorkcenter,
  jumpToSource,
  reloadWorkcenter,
  loadMoreWorkcenter,
  markDoneWorkcenter,
  // ---- workcenter dashboard ----
  workcenterPage,
  dashboardRows,
  dashboardLoading,
  dashboardError,
  dashboardPending,
  setWorkcenterPage,
  loadDashboard,
  toggleWorkspaceAutomation,
  // ---- modals ----
  newSessionOpen,
  confirmNewSession,
  openSettingsFromPicker,
  openActionTarget,
  clearActionTarget,
  settingsOpen,
  closeSettings,
  settingsTarget,
  bindingStats,
  saveSettings,
  autoConfigureAgents,
  setLocale,
  setTheme,
  setFontScale,
  personalizedSettingOpen,
  personalizedSettings,
  setAdminPassword,
  removeAccount,
  setAdminAccount,
  myMcpApiKeys,
  myMcpApiKeyCreated,
  createMyMcpApiKey,
  resetMyMcpApiKey,
  revokeMyMcpApiKey,
  dismissMyMcpApiKeyReveal,
  closePersonalizedSetting,
  openSettingsFromPersonalizedSetting,
  workspaceAccessors,
  fetchWorkspaceAccessors,
  userWorkspaceAccess,
  fetchUserWorkspaceAccess,
  saveUserWorkspaceAccess,
  openSettingsFromWorkspaceSetting,
  workspaceSettingOpen,
  currentWorkspaceSetting,
  detectedMainBranch,
  resolvedSpecRoot,
  sysExtraMounts,
  vendorModes,
  skillLinkStatuses,
  installingSkillIds,
  parkRecoveryStats,
  parkRecoveryError,
  parkRecoveryLoading,
  saveWorkspaceSetting,
  loadParkRecoveryStats,
  querySkillLinkStatus,
  installSkill,
  skillApprovalRequest,
  approveSkillLoad,
  cancelSkillLoad,
  dismissSkillApproval,
  // ---- share (three title-bar「分享」buttons) ----
  shareLink,
  // ---- global toast ----
  toast,
  // ---- dev-launch startup overlay ----
  devLaunch,
  specLaunch,
  // ---- create-PR progress overlay ----
  createPrProgress,
  // ---- create-intent progress overlay ----
  createIntentProgress,
} = useAppController()

/** 当前工作区 id 解析出的 `WorkspaceInfo`,只供工作区设置页页头展示「正在改哪个
 *  工作区」(名称 + 绝对路径)。列表未到达或 id 无匹配(切换中)时为 null,
 *  设置页据此整块不渲染。身份仍是 id,path 只是展示数据。 */
const currentWorkspaceInfo = computed(
  () => workspaces.value.find((w) => w.name === currentWorkspace.value) ?? null,
)

/** 分享按钮处理:各页标题栏发 `share` 后,在此组装 `ShareTarget`(kind + 当前
 *  workspace + id + title + 已本地化的类型标签)交给 `shareLink` 拼深链复制。
 *  必要数据缺失(无活动会话/意图/讨论或 workspace)时静默忽略。 */
function shareSession(): void {
  const ws = currentWorkspace.value
  const id = activeSession.value
  if (!ws || !id) return
  shareLink({
    kind: 'session',
    workspaceName: ws,
    id,
    title: activeTitle.value,
    typeLabel: t('share.kind.session.label'),
  })
}
function shareIntent(intentId: string): void {
  const ws = intentsProject.value
  const it = currentIntents.value.find((i) => i.id === intentId)
  if (!ws || !it) return
  shareLink({
    kind: 'intent',
    workspaceName: ws,
    id: it.id,
    title: it.title,
    typeLabel: t('share.kind.intent.label'),
  })
}
// ── Gate escapes ──────────────────────────────────────────────────────────
// Each exit is one explicit user decision, executed the moment it is made and
// never remembered: a force-release covers this launch only, and a worktree
// repair is a one-off git action. The dialog closes first so a second refusal
// (a different gate, or the same one still closed) shows as its own event.

/**
 * The intent workspace's main branch: the explicit workspace setting first, the
 * server-side project config next, the probed default last. Named once because
 * both the intents page and the create dialog's branch pre-fill must agree on
 * what "the default" is — two copies of this chain could disagree.
 */
const intentsWorkspaceMainBranch = computed<string | null>(
  () =>
    currentWorkspaceSetting.value?.defaultMainBranch ??
    (intentsProject.value
      ? serverSettings.value?.projectConfigs?.[intentsProject.value]?.defaultMainBranch
      : null) ??
    detectedMainBranch.value ??
    null,
)

/** The candidate deliveries the `delivery-context` exit offers, from the ledger. */
const gateEscapeDeliveries = computed(() => {
  const id = intentGateEscape.value?.escape.intentId
  if (!id) return []
  return currentIntents.value.find((i) => i.id === id)?.linkedDeliveries ?? []
})

function onForceDependencyGate(intentId: string): void {
  closeIntentGateEscape()
  startDevelopment(intentId, false, { forceDependencyGate: true })
}

// worktree 基线提示上的两个显式出口。提示本身不阻断任何操作,所以这里只发动作,
// 提示由 `intent_worktree_repair_result` 回来时撤掉。
function onRepairWorktree(intentId: string, mode: 'rebuild' | 'merge'): void {
  repairIntentWorktree(intentId, mode)
}

function onChooseDeliveryContext(intentId: string, deliveryId: string): void {
  closeIntentGateEscape()
  startDevelopment(intentId, false, { deliveryId })
}

function shareDiscussion(): void {
  const ws = discussionsProject.value
  const d = activeDiscussion.value
  if (!ws || !d) return
  shareLink({
    kind: 'discussion',
    workspaceName: ws,
    id: d.id,
    title: d.title,
    typeLabel: t('share.kind.discussion.label'),
  })
}

/** Fulfill an intent deep link: called when Intents.vue consumes requestedIntentId.
 *  Marks the link as fulfilled so the ready-handler timeout won't fire. */
function onRequestedIntentConsumed(): void {
  if (pendingDeepLink?.value?.kind === 'intent') {
    clearPendingDeepLink()
  }
  requestedIntentId.value = null
}

/** 队列页点击某条意图:关闭队列页并在意图页选中它(队列页是意图页的兄弟视图)。 */
function onQueueSelectIntent(intentId: string): void {
  closeQueuePage()
  requestedIntentId.value = intentId
}

/** Files 内嵌 ChatColumn 的分隔条宽度(像素,per-workspace,仅 localStorage)。切换
 *  workspace 时从持久化读回;拖拽/键盘调节后写回。仅本地,不进服务端配置。 */
const filesChatWidth = ref(FILES_CHAT_WIDTH_DEFAULT)
watch(
  filesProject,
  (ws) => {
    if (ws) filesChatWidth.value = readFilesChatWidth(ws)
  },
  { immediate: true },
)
// Closing settings also drops any one-shot locate target that was never acted on,
// so the next open lands wherever the user left the panel — not on an old deep link.
// `closeSettings` additionally drops any still-revealed plaintext API key.
function onCloseSettings(): void {
  closeSettings()
  clearActionTarget()
}

function onFilesChatWidth(px: number): void {
  const ws = filesProject.value
  if (!ws) return
  filesChatWidth.value = px
  persistFilesChatWidth(ws, px)
}
</script>

<template>
  <!-- Login gate (ADR-0023): when the server says this connection is
       unauthenticated, the gate replaces the whole app. The toast lives outside
       the gate (at root) so a "session expired" notice shows over it too. -->
  <Login v-if="authStatus === 'login-required'" />
  <template v-else>
    <AppHeader
      v-model:add-workspace-open="addWorkspaceOpen"
      :workspace-directory-picker="workspaceDirectoryPicker"
      :workspaces="workspaces"
      :current-workspace="currentWorkspace"
      :status="status"
      :tabs="HEADER_TABS"
      :active-tab="activeTab"
      :tabs-enabled="currentWorkspace !== null"
      :view-mode="viewMode"
      :workcenter-page="workcenterPage"
      :workcenter-badge-count="workcenterPendingCount"
      :show-logout="authStatus === 'authenticated'"
      :update-status="updateStatus"
      :self-update="selfUpdate"
      @select-tab="onSelectTab"
      @update:view-mode="setViewMode"
      @select-workcenter-page="setWorkcenterPage"
      @open-settings="openSettings"
      @open-personalized-setting="openPersonalizedSetting"
      @open-workspace-setting="openWorkspaceSetting"
      @add-workspace="addWorkspace"
      @select-workspace-directory="selectWorkspaceDirectory"
      @select-workspace="selectWorkspace"
      @remove-workspace="removeWorkspace"
      @start-self-update="startSelfUpdate"
      @apply-self-update="applySelfUpdate"
      @logout="auth.logout"
    />

    <div class="body">
      <template v-if="viewMode === 'workspace'">
        <Works
          v-if="activeTab === 'console'"
          ref="composer"
          :current-workspace="currentWorkspace"
          :sessions="currentSessions"
          :active-session-kind="activeSessionKind"
          :session-counts="sessionCounts"
          :show-tool-sessions="serverSettings?.showToolSessions === true"
          :sessions-has-more="currentSessionPaging.hasMore"
          :sessions-exhausted="currentSessionPaging.exhausted"
          :session-status="sessionStatus"
          :active-workspace="activeWorkspace"
          :active-session="activeSession"
          :active-title="activeTitle"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          :source-label="activeSessionSource?.label ?? null"
          :vendor-session-caps="sessionCapabilities ?? undefined"
          :has-active-session="hasActiveSession"
          :mode="mode"
          :mode-options="modeOptions"
          :codex-policy="codexPolicy"
          :messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :readonly-session="activeSessionReadonly"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          @create-session="openNewSession"
          @refresh-sessions="() => refreshSessions(currentWorkspace)"
          @select-session-kind="selectSessionKind"
          @load-more-sessions="() => loadMoreSessions(currentWorkspace)"
          @select-session="
            (path: string, session: SessionInfo) => selectSession(path, session.sessionId, session)
          "
          @jump-session-source="jumpSessionSource"
          @delete-session="deleteSession"
          @rename-session="renameSession"
          @set-mode="setMode"
          @set-codex-policy="setCodexPolicy"
          @set-session-agent="onSetSessionAgent"
          @open-source="jumpActiveSessionSource"
          @share="shareSession"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @submit="onSubmit"
          @enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
          @mobile-back="clearViewedSession"
        />

        <Queue
          v-else-if="activeTab === 'intents' && intentsProject && queuePageOpen"
          :detail="currentQueueDetail"
          @control="queueControl"
          @refresh="refreshQueueDetail"
          @close="closeQueuePage"
          @select-intent="onQueueSelectIntent"
        />

        <Intents
          v-else-if="activeTab === 'intents' && intentsProject"
          ref="composer"
          :project="intentsProject"
          :intents="currentIntents"
          :sdd-enabled="currentIntentsSdd"
          :requested-intent-id="requestedIntentId"
          :requested-intent-sub-tab="requestedIntentSubTab"
          :awaiting-intent-session-bind-id="awaitingIntentSessionBindId"
          :requested-intent-session-id="requestedIntentSessionId"
          :workspace-main-branch="intentsWorkspaceMainBranch"
          :workspace-git-branch-mode="
            currentWorkspaceSetting?.gitBranchMode ??
            (intentsProject
              ? serverSettings?.projectConfigs?.[intentsProject]?.gitBranchMode
              : undefined) ??
            'current-branch'
          "
          :deliveries="intentLinkDeliveries"
          :worktree-baseline-notices="worktreeBaselineNotices"
          :standalone-delivery-pending="pendingStandaloneDelivery !== null"
          :automation="currentWorkflow"
          :intent-action-error-seq="intentActionErrorSeq"
          :create-intent-pending="createIntentPending"
          :intent-pr-sync="intentPrSync"
          :intent-spec-content="intentSpecContent"
          :intent-spec-loading="intentSpecLoading"
          :session-status="sessionStatus"
          :intent-logs-by-id="intentLogsById"
          :intent-logs-loading="intentLogsLoading"
          :active-session="activeSession"
          :active-title="activeTitle"
          :has-active-session="hasActiveSession"
          :messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          :mode="mode"
          :mode-options="modeOptions"
          :codex-policy="codexPolicy"
          @set-mode="setMode"
          @set-codex-policy="setCodexPolicy"
          @requested-intent-consumed="onRequestedIntentConsumed()"
          @requested-subtab-consumed="requestedIntentSubTab = null"
          @action-target="openActionTarget"
          @requested-intent-session-consumed="requestedIntentSessionId = null"
          @filter="setIntentFilter"
          @refine="refineIntent"
          @repair-worktree="onRepairWorktree"
          @dismiss-worktree-baseline="clearWorktreeBaselineNotice"
          @save-intent-content="updateIntentContent"
          @save-spec-content="saveSpecContent"
          @write-spec="writeSpec"
          @approve-spec="approveSpec"
          @revoke-spec-approval="revokeSpecApproval"
          @open-spec-session="openSpecSession"
          @open-spec-review-session="(id: string) => openSpecReviewSession(id)"
          @open-intent-session="selectIntentSession"
          @read-spec="readIntentSpec"
          @list-intent-logs="listIntentLogs"
          @reset-intent-session="resetIntentSession"
          @reset-spec-session="resetSpecSession"
          @start-dev="startDevelopment"
          @open-work-session="selectWorkSession"
          @set-status="setIntentStatus"
          @delete="deleteIntent"
          @set-automate="setIntentAutomate"
          @set-spec-mode="setIntentSpecMode"
          @update-deps="updateIntentDeps"
          @create-pr="createPr"
          @sync-pr-status="syncIntentPrStatus"
          @open-delivery="
            (id: string) => intentsProject && openDeliveryFromIntent(intentsProject, id)
          "
          @open-link-dialog="loadDeliveriesForLink"
          @link-delivery="linkIntentDelivery"
          @unlink-delivery="unlinkIntentDelivery"
          @standalone-delivery="createStandaloneDelivery"
          @share="shareIntent"
          @start-automation="startWorkflow"
          @stop-automation="stopWorkflow"
          @open-queue="openQueuePage"
          @new-intent="openCreateIntentDialog"
          @start-intent-session="startIntentSession"
          @set-session-agent="onSetSessionAgent"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @submit="onSubmit"
          @enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
          @mobile-back="clearViewedSession"
        />

        <Deliveries
          v-else-if="activeTab === 'deliveries' && deliveriesProject"
          :deliveries="currentDeliveries"
          :active-id="activeDeliveryId"
          :active-delivery="activeDelivery"
          :active-plan="activeDeliveryPlan"
          :branch-init="activeDeliveryBranchInit"
          :associated-intents="activeDeliveryIntents"
          :intents="deliveryLinkIntents"
          :mainline-ahead="activeDeliveryMainlineAhead"
          :delivery-branch-ahead="activeDeliveryBranchAhead"
          :sync-phase="activeDeliverySyncPhase"
          :delivery-pr="activeDeliveryPr"
          :delivery-pr-busy="activeDeliveryPrBusy"
          :workspace-git-branch-mode="
            currentWorkspaceSetting?.gitBranchMode ??
            (deliveriesProject
              ? serverSettings?.projectConfigs?.[deliveriesProject]?.gitBranchMode
              : undefined) ??
            'current-branch'
          "
          @open="openDelivery"
          @create="createDelivery"
          @update="updateDelivery"
          @cancel="cancelDelivery"
          @transition="(to, confirm) => transitionDelivery(to, confirm)"
          @init-branch="(payload) => initDeliveryBranch(payload)"
          @cleanup-branch="cleanupDeliveryBranch"
          @sync-mainline="syncDeliveryMainline"
          @create-delivery-pr="createDeliveryPr"
          @sync-delivery-pr="syncDeliveryPr"
          @link-intent="linkIntentToDelivery"
          @unlink-intent="unlinkIntentFromDelivery"
          @open-intent="
            (id: string) => deliveriesProject && openLinkedIntent(deliveriesProject, id)
          "
          @open-workspace-settings="openWorkspaceSetting"
          @mobile-back="onDeliveryMobileBack"
        />

        <Discussions
          v-else-if="activeTab === 'discussion' && discussionsProject"
          :discussions="currentDiscussions"
          :active-id="activeDiscussionId"
          :run-state="discussionRunState"
          :active-discussion="activeDiscussion"
          :active-run-state="activeDiscussionRunState"
          :messages="discussionMessages"
          :research-messages="researchMessages"
          :phase="activeDiscussionPhase"
          :launch-action="discussionLaunch"
          :dispatch="activeDiscussionDispatch"
          :input="discussionInput"
          :agents="serverSettings?.agents ?? []"
          :default-agent-id="serverSettings?.defaultAgentId ?? null"
          :active-session="activeSession"
          :session-title="activeTitle"
          :session-has-active="hasActiveSession"
          :session-messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          @open="openDiscussion"
          @create="createDiscussion"
          @start="startDiscussion"
          @pause="pauseDiscussion"
          @resume="resumeDiscussion"
          @cancel="cancelDiscussion"
          @convert="convertDiscussionToIntent"
          @share="shareDiscussion"
          @update:input="discussionInput = $event"
          @submit-input="submitDiscussionInput"
          @mobile-back="onDiscussionMobileBack"
          @open-research-session="openResearchSession"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @session-submit="onSubmit"
          @session-enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
        />

        <Automations
          v-else-if="activeTab === 'automations' && automationsProject"
          :automations="currentAutomations"
          :active-id="selectedAutomationId"
          :automation="selectedAutomation"
          :logs="selectedAutomationLogs"
          :transcripts="executionTranscripts"
          :form-open="automationFormOpen"
          :form-target="automationFormTarget"
          :workspace-name="automationsProject ?? ''"
          :timezone="automationTimezone"
          :automation-enabled="automationEnabled"
          :automation-enabled-saving="automationEnabledSaving"
          :execution-id="selectedExecutionId"
          :execution="selectedExecution"
          :tool-manifest="automationToolManifest"
          :tool-manifest-loading="automationToolManifestLoading"
          :tool-manifest-error="automationToolManifestError"
          :vendor-availability="vendorAvailability"
          :agents="serverSettings?.agents ?? []"
          :automation-agent-id="serverSettings?.automationAgentId ?? ''"
          :default-agent-id="serverSettings?.defaultAgentId ?? ''"
          @select="onSelectAutomation"
          @open-form="openAutomationForm"
          @delete-automation="deleteAutomation"
          @toggle-enabled="onToggleAutomationEnabled"
          @set-automation-enabled="setAutomationEnabled"
          @run-now="runNowAutomation"
          @load-session="onLoadExecutionSession"
          @select-execution="onSelectExecution"
          @mobile-back="onAutomationMobileBack"
          @close-form="automationFormOpen = false"
          @create="createAutomation"
          @import-automations="importAutomations"
          @new-from-template="createAutomationFromTemplate"
          @update="updateAutomation"
          @load-tool-manifest="onLoadAutomationToolManifest"
        />

        <Files
          v-else-if="activeTab === 'files' && filesProject"
          ref="composer"
          :dirs="filesDirs"
          :expanded="filesExpanded"
          :loading-dirs="filesLoadingDirs"
          :git-status="filesGitStatus"
          :tabs="filesTabs"
          :active-path="filesActivePath"
          :active-tab="filesActiveTab"
          :search-mode="filesSearchMode"
          :search-query="filesSearchQuery"
          :search-pattern="filesSearchPattern"
          :search-result="filesSearchResult"
          :search-loading="filesSearchLoading"
          :files-bound-session-id="
            filesProject ? (filesBoundSessionId[filesProject] ?? null) : null
          "
          :files-chat-width="filesChatWidth"
          :active-session="activeSession"
          :active-title="activeTitle"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          :mode="mode"
          :mode-options="modeOptions"
          :codex-policy="codexPolicy"
          :messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          @toggle-dir="toggleFilesDir"
          @open-file="openFile"
          @open-hit="openFileSearchHit"
          @close-tab="closeFileTab"
          @select-tab="setFilesActiveTab"
          @set-search-mode="setFilesSearchMode"
          @update:search-query="filesSearchQuery = $event"
          @update:search-pattern="filesSearchPattern = $event"
          @run-search="runFileSearch"
          @refresh-tree="refreshFilesTree"
          @toast="showToast"
          @create-files-chat="filesProject && createFilesChatSession(filesProject)"
          @reset-files-chat="filesProject && resetFilesChatSession(filesProject)"
          @files-chat-width="onFilesChatWidth"
          @set-mode="setMode"
          @set-codex-policy="setCodexPolicy"
          @set-session-agent="onSetSessionAgent"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @submit="onSubmit"
          @enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
        />
      </template>

      <div v-else class="workcenter-view">
        <Dashboard
          v-if="workcenterPage === 'dashboard'"
          :rows="dashboardRows"
          :loading="dashboardLoading"
          :refresh-failed="dashboardError !== null"
          :pending="dashboardPending"
          :is-admin="auth.isAdmin.value"
          @toggle="toggleWorkspaceAutomation"
          @refresh="loadDashboard"
        />

        <WorkCenter
          v-else
          :events="workcenterEvents"
          :has-more="workcenterHasMore"
          :loading="workcenterLoading"
          :current-workspace="currentWorkspace"
          :workspaces="workspaces"
          :requested-event-id="requestedWorkcenterEventId"
          @respond="respondWorkcenter"
          @submit-ask="submitAskWorkcenter"
          @jump-to-source="jumpToSource"
          @reload="reloadWorkcenter"
          @load-more="loadMoreWorkcenter"
          @mark-done="markDoneWorkcenter"
          @requested-event-consumed="requestedWorkcenterEventId = null"
        />
      </div>
    </div>

    <!-- 以下设置页 / 弹窗 / 覆盖层都是懒加载装配点:v-if 既是显示条件,也是异步
         wrapper 的挂载门(见 script 顶部的懒加载约定)。带 open prop 的组件继续传原
         表达式——在 v-if 已放行的分支里它恒为 true,组件内部的关闭/取消协议不变。 -->
    <NewSessionModal
      v-if="newSessionOpen"
      :open="newSessionOpen"
      :agents="serverSettings?.agents ?? []"
      :default-agent-id="serverSettings?.defaultAgentId ?? null"
      :vendor-availability="vendorAvailability"
      @confirm="confirmNewSession"
      @close="newSessionOpen = false"
      @goto-settings="openSettingsFromPicker"
    />

    <SystemSettingsPage
      v-if="settingsOpen"
      :open="settingsOpen"
      :settings="serverSettings"
      :host-status="hostStatus"
      :vendor-availability="vendorAvailability"
      :sandbox-status="sandboxStatus"
      :binding-stats="bindingStats"
      :workspaces="workspaces"
      :target="settingsTarget"
      :user-access-accounts="userWorkspaceAccess?.accounts ?? null"
      :user-access-workspaces="userWorkspaceAccess?.workspaces ?? []"
      @close="onCloseSettings"
      @target-consumed="clearActionTarget"
      @save="saveSettings"
      @auto-configure-agents="autoConfigureAgents"
      @set-password="setAdminPassword"
      @remove-account="removeAccount"
      @set-admin-account="setAdminAccount"
      @reload-user-access="fetchUserWorkspaceAccess"
      @save-user-access="saveUserWorkspaceAccess"
    />

    <PersonalizedSettingPage
      v-if="personalizedSettingOpen"
      :open="personalizedSettingOpen"
      :settings="personalizedSettings"
      :mcp-api-keys="myMcpApiKeys"
      :mcp-api-key-created="myMcpApiKeyCreated"
      :base-url="serverSettings?.baseUrl ?? null"
      @close="closePersonalizedSetting"
      @set-ui-lang="setLocale"
      @set-theme="setTheme"
      @set-font-scale="setFontScale"
      @create-mcp-api-key="createMyMcpApiKey"
      @reset-mcp-api-key="(id: string) => resetMyMcpApiKey({ id })"
      @revoke-mcp-api-key="(id: string) => revokeMyMcpApiKey({ id })"
      @dismiss-mcp-api-key-reveal="dismissMyMcpApiKeyReveal"
      @goto-system-settings="openSettingsFromPersonalizedSetting"
    />

    <WorkspaceSettingPage
      v-if="workspaceSettingOpen"
      :open="workspaceSettingOpen"
      :workspace-setting="currentWorkspaceSetting"
      :detected-main-branch="detectedMainBranch"
      :resolved-spec-root="resolvedSpecRoot"
      :sys-extra-mounts="sysExtraMounts"
      :current-workspace="currentWorkspace"
      :current-workspace-info="currentWorkspaceInfo"
      :vendor-modes="vendorModes"
      :agents="serverSettings?.agents ?? []"
      :link-statuses="skillLinkStatuses"
      :installing-skill-ids="installingSkillIds"
      :park-recovery-stats="parkRecoveryStats"
      :park-recovery-error="parkRecoveryError"
      :park-recovery-loading="parkRecoveryLoading"
      :base-url="serverSettings?.baseUrl ?? null"
      :workspace-accessors="workspaceAccessors"
      :is-admin="auth.isAdmin.value"
      @close="workspaceSettingOpen = false"
      @save="saveWorkspaceSetting"
      @query-link-status="querySkillLinkStatus"
      @install-skill="installSkill"
      @reload-park-recovery="loadParkRecoveryStats"
      @goto-system-settings="openSettingsFromWorkspaceSetting"
      @reload-workspace-accessors="fetchWorkspaceAccessors"
    />

    <SkillApprovalModal
      v-if="skillApprovalRequest !== null"
      :open="skillApprovalRequest !== null"
      :approval="skillApprovalRequest"
      @approve="approveSkillLoad"
      @cancel="cancelSkillLoad"
      @close="dismissSkillApproval"
    />
  </template>

  <div v-if="toast" class="toast" role="status">{{ toast }}</div>

  <IntentActionErrorDialog
    v-if="intentActionError !== null"
    :open="intentActionError !== null"
    :message="intentActionError ?? ''"
    :guidance="intentActionErrorGuidance"
    @close="closeIntentActionError"
    @retry="retryIntentAction"
  />

  <!-- The EXIT a refused launch left the user. Shown instead of the plain error
       dialog above, never alongside it: one refusal, one dialog. Every exit is an
       explicit choice — nothing here happens on its own. -->
  <GateEscapeDialog
    v-if="intentGateEscape"
    :escape="intentGateEscape?.escape ?? null"
    :message="intentGateEscape?.message ?? ''"
    :deliveries="gateEscapeDeliveries"
    @cancel="closeIntentGateEscape"
    @force-dependency="onForceDependencyGate"
    @choose-delivery="onChooseDeliveryContext"
  />

  <!-- 「增加意图」 dialog: base (delivery or branch) + the content that becomes the
       intent's body AND the first turn of its session. Opened by the intent
       list's 「+」; closed by the create result, never by a refusal — a refused
       create keeps the form so the user can fix the base without retyping. -->
  <CreateIntentDialog
    v-if="createIntentDialogOpen"
    :open="createIntentDialogOpen"
    :deliveries="intentLinkDeliveries"
    :main-branch="intentsWorkspaceMainBranch"
    :pending="createIntentPending"
    @confirm="createIntent"
    @cancel="closeCreateIntentDialog"
  />

  <!-- Dev-launch startup overlay (App-global, like the toast): blocks interaction
       immediately while a manual Start-Dev launch is in flight. -->
  <DevStartupOverlay v-if="devLaunch" :model="devLaunch" />
  <SpecStartupOverlay v-if="specLaunch" :model="specLaunch" />

  <!-- Create-PR progress overlay: blocks interaction while a manual 创建 PR runs
       (commit + push + forge call), lighting its four stages. -->
  <CreatePrOverlay v-if="createPrProgress" :model="createPrProgress" />

  <!-- Create-intent progress overlay: covers the create dialog while a with-content
       创建意图 runs (fetch branch + worktree + persist + session), narrating its
       four stages until the console lands on the new intent. -->
  <CreateIntentOverlay v-if="createIntentProgress" :model="createIntentProgress" />

  <!-- Automation save overlay: blocks interaction while a automation create/update is
       in flight (2-4s typical round-trip). -->
  <AutomationSaveOverlay v-if="automationSaving" :saving="automationSaving" />
</template>

<style scoped>
.workcenter-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  max-width: 90vw;
  padding: 10px 16px;
  border-radius: 8px;
  background: #b00020;
  color: #fff;
  font-size: 13px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
</style>
