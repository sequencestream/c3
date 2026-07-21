<script setup lang="ts">
// App.vue is a thin entry: all controller logic (state, the WebSocket message
// router, and every domain action) lives under `./controls`. `useAppController`
// builds one shared `ctx` object and we destructure it here — the destructured
// refs/computeds stay the SAME reactive objects, so the template below is
// unchanged. See controls/index.ts for the decomposition map.
import AppHeader from './components/AppHeader/AppHeader.vue'
import Works from './pages/works/Works.vue'
import Intents from './pages/intents/Intents.vue'
import Discussions from './pages/discussions/Discussions.vue'
import Automations from './pages/automations/Automations.vue'
import Codes from './pages/codes/Codes.vue'
import WorkCenter from './pages/workcenter/WorkCenter.vue'
import Dashboard from './pages/workcenter/components/WorkspaceDashboard.vue'
import SystemSettingsPage from './pages/systemsettings/SystemSettings.vue'
import WorkspaceSettingPage from './pages/workspacesetting/WorkspaceSetting.vue'
import Login from './pages/login/Login.vue'
import SkillApprovalModal from './components/SkillApprovalModal/SkillApprovalModal.vue'
import SandboxConflictModal from './components/SandboxConflictModal/SandboxConflictModal.vue'
import NewSessionModal from './pages/works/components/NewSessionModal/NewSessionModal.vue'
import DevStartupOverlay from './components/DevStartupOverlay/DevStartupOverlay.vue'
import SpecStartupOverlay from './components/SpecStartupOverlay/SpecStartupOverlay.vue'
import AutomationSaveOverlay from './components/AutomationSaveOverlay/AutomationSaveOverlay.vue'
import ErrorDialog from './components/ErrorDialog/ErrorDialog.vue'
import { ref, watch } from 'vue'
import { useTypedI18n } from './i18n'
import { useAppController } from './controls'
import { CODES_CHAT_WIDTH_DEFAULT } from './controls/state'

const { t } = useTypedI18n()

const {
  // ---- auth / connection / top bar ----
  auth,
  authStatus,
  updateStatus,
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
  openWorkspaceSetting,
  addWorkspace,
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
  requestedIntentSessionId,
  currentIntents,
  currentIntentsSdd,
  currentWorkflow,
  intentActionErrorSeq,
  intentActionError,
  intentPrSync,
  closeIntentActionError,
  intentSpecContent,
  intentSpecLoading,
  intentLogsById,
  intentLogsLoading,
  listIntentLogs,
  setIntentFilter,
  refineIntent,
  writeSpec,
  approveSpec,
  openSpecSession,
  readIntentSpec,
  resetIntentSession,
  resetSpecSession,
  startDevelopment,
  selectWorkSession,
  setIntentStatus,
  setIntentAutomate,
  updateIntentContent,
  saveSpecContent,
  updateIntentDeps,
  createPr,
  syncIntentPrStatus,
  startWorkflow,
  stopWorkflow,
  selectIntentSession,
  newIntentSession,
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
  showStart,
  activeDiscussionDispatch,
  discussionInput,
  openDiscussion,
  createDiscussion,
  startDiscussion,
  pauseDiscussion,
  resumeDiscussion,
  convertDiscussionToIntent,
  submitDiscussionInput,
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
  // ---- codes ----
  codesProject,
  codesDirs,
  codesExpanded,
  codesLoadingDirs,
  codesGitStatus,
  codesTabs,
  codesActivePath,
  codesActiveTab,
  codesSearchMode,
  codesSearchQuery,
  codesSearchPattern,
  codesSearchResult,
  codesSearchLoading,
  toggleCodesDir,
  refreshCodesTree,
  openCodeFile,
  openCodeSearchHit,
  closeCodeTab,
  setCodesActiveTab,
  setCodesSearchMode,
  runCodeSearch,
  showToast,
  codesBoundSessionId,
  readCodesChatWidth,
  persistCodesChatWidth,
  createCodesChatSession,
  resetCodesChatSession,
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
  settingsOpen,
  bindingStats,
  saveSettings,
  setLocale,
  setAdminPassword,
  removeAccount,
  setAdminAccount,
  workspaceSettingOpen,
  currentWorkspaceSetting,
  detectedMainBranch,
  resolvedSpecRoot,
  sysExtraMounts,
  vendorModes,
  skillLinkStatuses,
  installingSkillIds,
  saveWorkspaceSetting,
  querySkillLinkStatus,
  installSkill,
  skillApprovalRequest,
  approveSkillLoad,
  cancelSkillLoad,
  dismissSkillApproval,
  // ---- sandbox-conflict modal ----
  sandboxConflict,
  respondSandboxConflict,
  // ---- share (three title-bar「分享」buttons) ----
  shareLink,
  // ---- global toast ----
  toast,
  // ---- dev-launch startup overlay ----
  devLaunch,
  specLaunch,
} = useAppController()

/** 分享按钮处理:各页标题栏发 `share` 后,在此组装 `ShareTarget`(kind + 当前
 *  workspace + id + title + 已本地化的类型标签)交给 `shareLink` 拼深链复制。
 *  必要数据缺失(无活动会话/意图/讨论或 workspace)时静默忽略。 */
function shareSession(): void {
  const ws = currentWorkspace.value
  const id = activeSession.value
  if (!ws || !id) return
  shareLink({
    kind: 'session',
    workspaceId: ws,
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
    workspaceId: ws,
    id: it.id,
    title: it.title,
    typeLabel: t('share.kind.intent.label'),
  })
}
function shareDiscussion(): void {
  const ws = discussionsProject.value
  const d = activeDiscussion.value
  if (!ws || !d) return
  shareLink({
    kind: 'discussion',
    workspaceId: ws,
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

/** Codes 内嵌 ChatColumn 的分隔条宽度(像素,per-workspace,仅 localStorage)。切换
 *  workspace 时从持久化读回;拖拽/键盘调节后写回。仅本地,不进服务端配置。 */
const codesChatWidth = ref(CODES_CHAT_WIDTH_DEFAULT)
watch(
  codesProject,
  (ws) => {
    if (ws) codesChatWidth.value = readCodesChatWidth(ws)
  },
  { immediate: true },
)
function onCodesChatWidth(px: number): void {
  const ws = codesProject.value
  if (!ws) return
  codesChatWidth.value = px
  persistCodesChatWidth(ws, px)
}
</script>

<template>
  <!-- Login gate (ADR-0023): when the server says this connection is
       unauthenticated, the gate replaces the whole app. The toast lives outside
       the gate (at root) so a "session expired" notice shows over it too. -->
  <Login v-if="authStatus === 'login-required'" />
  <template v-else>
    <AppHeader
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
      @select-tab="onSelectTab"
      @update:view-mode="setViewMode"
      @select-workcenter-page="setWorkcenterPage"
      @open-settings="openSettings"
      @open-workspace-setting="openWorkspaceSetting"
      @add-workspace="addWorkspace"
      @select-workspace="selectWorkspace"
      @remove-workspace="removeWorkspace"
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
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          @create-session="openNewSession"
          @refresh-sessions="() => refreshSessions(currentWorkspace)"
          @select-session-kind="selectSessionKind"
          @load-more-sessions="() => loadMoreSessions(currentWorkspace)"
          @select-session="selectSession"
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

        <Intents
          v-else-if="activeTab === 'intents' && intentsProject"
          ref="composer"
          :project="intentsProject"
          :intents="currentIntents"
          :sdd-enabled="currentIntentsSdd"
          :requested-intent-id="requestedIntentId"
          :requested-intent-sub-tab="requestedIntentSubTab"
          :requested-intent-session-id="requestedIntentSessionId"
          :workspace-main-branch="
            currentWorkspaceSetting?.defaultMainBranch ??
            (intentsProject
              ? serverSettings?.projectConfigs?.[intentsProject]?.defaultMainBranch
              : null) ??
            detectedMainBranch
          "
          :workspace-git-branch-mode="
            currentWorkspaceSetting?.gitBranchMode ??
            (intentsProject
              ? serverSettings?.projectConfigs?.[intentsProject]?.gitBranchMode
              : undefined) ??
            'current-branch'
          "
          :automation="currentWorkflow"
          :intent-action-error-seq="intentActionErrorSeq"
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
          @requested-intent-session-consumed="requestedIntentSessionId = null"
          @filter="setIntentFilter"
          @refine="refineIntent"
          @save-intent-content="updateIntentContent"
          @save-spec-content="saveSpecContent"
          @write-spec="writeSpec"
          @approve-spec="approveSpec"
          @open-spec-session="openSpecSession"
          @open-intent-session="selectIntentSession"
          @read-spec="readIntentSpec"
          @list-intent-logs="listIntentLogs"
          @reset-intent-session="resetIntentSession"
          @reset-spec-session="resetSpecSession"
          @start-dev="startDevelopment"
          @open-work-session="selectWorkSession"
          @set-status="setIntentStatus"
          @set-automate="setIntentAutomate"
          @update-deps="updateIntentDeps"
          @create-pr="createPr"
          @sync-pr-status="syncIntentPrStatus"
          @share="shareIntent"
          @start-automation="startWorkflow"
          @stop-automation="stopWorkflow"
          @new-intent-session="newIntentSession"
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
          :show-start="showStart"
          :dispatch="activeDiscussionDispatch"
          :input="discussionInput"
          :agents="serverSettings?.agents ?? []"
          :default-agent-id="serverSettings?.defaultAgentId ?? null"
          @open="openDiscussion"
          @create="createDiscussion"
          @start="startDiscussion"
          @pause="pauseDiscussion"
          @resume="resumeDiscussion"
          @convert="convertDiscussionToIntent"
          @share="shareDiscussion"
          @update:input="discussionInput = $event"
          @submit-input="submitDiscussionInput"
          @mobile-back="onDiscussionMobileBack"
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
          :workspace-path="automationsProject ?? ''"
          :timezone="automationTimezone"
          :automation-enabled="automationEnabled"
          :automation-enabled-saving="automationEnabledSaving"
          :execution-id="selectedExecutionId"
          :execution="selectedExecution"
          :tool-manifest="automationToolManifest"
          :tool-manifest-loading="automationToolManifestLoading"
          :tool-manifest-error="automationToolManifestError"
          :host-status="hostStatus"
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

        <Codes
          v-else-if="activeTab === 'codes' && codesProject"
          ref="composer"
          :dirs="codesDirs"
          :expanded="codesExpanded"
          :loading-dirs="codesLoadingDirs"
          :git-status="codesGitStatus"
          :tabs="codesTabs"
          :active-path="codesActivePath"
          :active-tab="codesActiveTab"
          :search-mode="codesSearchMode"
          :search-query="codesSearchQuery"
          :search-pattern="codesSearchPattern"
          :search-result="codesSearchResult"
          :search-loading="codesSearchLoading"
          :codes-bound-session-id="
            codesProject ? (codesBoundSessionId[codesProject] ?? null) : null
          "
          :codes-chat-width="codesChatWidth"
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
          @toggle-dir="toggleCodesDir"
          @open-file="openCodeFile"
          @open-hit="openCodeSearchHit"
          @close-tab="closeCodeTab"
          @select-tab="setCodesActiveTab"
          @set-search-mode="setCodesSearchMode"
          @update:search-query="codesSearchQuery = $event"
          @update:search-pattern="codesSearchPattern = $event"
          @run-search="runCodeSearch"
          @refresh-tree="refreshCodesTree"
          @toast="showToast"
          @create-codes-chat="codesProject && createCodesChatSession(codesProject)"
          @reset-codes-chat="codesProject && resetCodesChatSession(codesProject)"
          @codes-chat-width="onCodesChatWidth"
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
          @respond="respondWorkcenter"
          @submit-ask="submitAskWorkcenter"
          @jump-to-source="jumpToSource"
          @reload="reloadWorkcenter"
          @load-more="loadMoreWorkcenter"
          @mark-done="markDoneWorkcenter"
        />
      </div>
    </div>

    <NewSessionModal
      :open="newSessionOpen"
      :agents="serverSettings?.agents ?? []"
      :default-agent-id="serverSettings?.defaultAgentId ?? null"
      :host-status="hostStatus"
      @confirm="confirmNewSession"
      @close="newSessionOpen = false"
      @goto-settings="openSettingsFromPicker"
    />

    <SystemSettingsPage
      :open="settingsOpen"
      :settings="serverSettings"
      :host-status="hostStatus"
      :sandbox-status="sandboxStatus"
      :binding-stats="bindingStats"
      @close="settingsOpen = false"
      @save="saveSettings"
      @set-ui-lang="setLocale"
      @set-password="setAdminPassword"
      @remove-account="removeAccount"
      @set-admin-account="setAdminAccount"
    />

    <WorkspaceSettingPage
      :open="workspaceSettingOpen"
      :workspace-setting="currentWorkspaceSetting"
      :detected-main-branch="detectedMainBranch"
      :resolved-spec-root="resolvedSpecRoot"
      :sys-extra-mounts="sysExtraMounts"
      :current-workspace="currentWorkspace"
      :vendor-modes="vendorModes"
      :agents="serverSettings?.agents ?? []"
      :link-statuses="skillLinkStatuses"
      :installing-skill-ids="installingSkillIds"
      @close="workspaceSettingOpen = false"
      @save="saveWorkspaceSetting"
      @query-link-status="querySkillLinkStatus"
      @install-skill="installSkill"
    />

    <SkillApprovalModal
      :open="skillApprovalRequest !== null"
      :approval="skillApprovalRequest"
      @approve="approveSkillLoad"
      @cancel="cancelSkillLoad"
      @close="dismissSkillApproval"
    />
  </template>

  <div v-if="toast" class="toast" role="status">{{ toast }}</div>

  <ErrorDialog
    :open="intentActionError !== null"
    :title="t('error.intentAction.title')"
    :message="intentActionError ?? ''"
    :close-label="t('common.action.close.label')"
    @close="closeIntentActionError"
  />

  <!-- Dev-launch startup overlay (App-global, like the toast): blocks interaction
       immediately while a manual Start-Dev launch is in flight. -->
  <DevStartupOverlay :model="devLaunch" />
  <SpecStartupOverlay :model="specLaunch" />

  <!-- Sandbox-conflict modal (App-global): a system-auth agent bound to a sandbox
       run. Blocks the run until the user picks bypass / switch / cancel. -->
  <SandboxConflictModal
    :request="sandboxConflict"
    @bypass="respondSandboxConflict('bypass')"
    @switch="(agentId) => respondSandboxConflict('switch', agentId)"
    @cancel="respondSandboxConflict('cancel')"
  />

  <!-- Automation save overlay: blocks interaction while a automation create/update is
       in flight (2-4s typical round-trip). -->
  <AutomationSaveOverlay :saving="automationSaving" />
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
