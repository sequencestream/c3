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
import Schedules from './pages/schedules/Schedules.vue'
import Codes from './pages/codes/Codes.vue'
import WorkCenter from './pages/workcenter/WorkCenter.vue'
import SystemSettingsPage from './pages/systemsettings/SystemSettings.vue'
import WorkspaceSettingPage from './pages/workspacesetting/WorkspaceSetting.vue'
import Login from './pages/login/Login.vue'
import SkillApprovalModal from './components/SkillApprovalModal/SkillApprovalModal.vue'
import NewSessionModal from './pages/works/components/NewSessionModal/NewSessionModal.vue'
import DevStartupOverlay from './components/DevStartupOverlay/DevStartupOverlay.vue'
import SpecStartupOverlay from './components/SpecStartupOverlay/SpecStartupOverlay.vue'
import ScheduleSaveOverlay from './components/ScheduleSaveOverlay/ScheduleSaveOverlay.vue'
import ErrorDialog from './components/ErrorDialog/ErrorDialog.vue'
import { useTypedI18n } from './i18n'
import { useAppController } from './controls'

const { t } = useTypedI18n()

const {
  // ---- auth / connection / top bar ----
  auth,
  authStatus,
  license,
  licenseRefreshing,
  licenseRefreshError,
  activateLicense,
  refreshLicense,
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
  activeLinkedIntentId,
  activeLinkedScheduleId,
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
  // ---- intents ----
  intentsProject,
  requestedIntentId,
  requestedIntentSubTab,
  requestedMergedTab,
  openLinkedIntent,
  currentIntents,
  currentIntentsSdd,
  currentAutomation,
  intentActionErrorSeq,
  intentActionError,
  closeIntentActionError,
  currentIntentSessions,
  selectedIntentSessionId,
  intentSessionRunStates,
  intentSpecContent,
  intentSpecLoading,
  setIntentFilter,
  refineIntent,
  writeSpec,
  approveSpec,
  openSpecSession,
  readIntentSpec,
  resetIntentSession,
  resetSpecSession,
  startDevelopment,
  openDevSession,
  setIntentStatus,
  setIntentAutomate,
  updateIntentDeps,
  createPr,
  startAutomation,
  stopAutomation,
  newIntentChat,
  selectIntentSession,
  renameIntentSession,
  deleteIntentSession,
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
  // ---- schedules ----
  currentSchedules,
  selectedScheduleId,
  selectedSchedule,
  selectedScheduleLogs,
  executionTranscripts,
  scheduleFormOpen,
  scheduleFormTarget,
  schedulesProject,
  scheduleTimezone,
  selectedExecutionId,
  scheduleSaving,
  selectedExecution,
  scheduleToolManifest,
  scheduleToolManifestLoading,
  scheduleToolManifestError,
  hostStatus,
  openSchedules,
  onSelectSchedule,
  openScheduleForm,
  onToggleScheduleEnabled,
  runNowSchedule,
  onLoadExecutionSession,
  onSelectExecution,
  onScheduleMobileBack,
  createSchedule,
  createScheduleFromTemplate,
  updateSchedule,
  deleteSchedule,
  onLoadScheduleToolManifest,
  // ---- codes ----
  codesProject,
  codesDirs,
  codesExpanded,
  codesLoadingDirs,
  codesTabs,
  codesActivePath,
  codesActiveTab,
  codesSearchMode,
  codesSearchQuery,
  codesSearchPattern,
  codesSearchResult,
  codesSearchLoading,
  toggleCodesDir,
  openCodeFile,
  openCodeSearchHit,
  closeCodeTab,
  setCodesActiveTab,
  setCodesSearchMode,
  runCodeSearch,
  showToast,
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
  // ---- global toast ----
  toast,
  // ---- dev-launch startup overlay ----
  devLaunch,
  specLaunch,
} = useAppController()
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
      :workcenter-badge-count="workcenterPendingCount"
      :show-logout="authStatus === 'authenticated'"
      :license="license"
      :license-refreshing="licenseRefreshing"
      :license-refresh-error="licenseRefreshError"
      @activate-license="activateLicense"
      @refresh-license="refreshLicense"
      @select-tab="onSelectTab"
      @update:view-mode="setViewMode"
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
          :linked-intent-id="activeLinkedIntentId"
          :linked-schedule-id="activeLinkedScheduleId"
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
          @open-intent="(id: string) => currentWorkspace && openLinkedIntent(currentWorkspace, id)"
          @open-schedule="
            (id: string) => {
              if (currentWorkspace) {
                openSchedules(currentWorkspace)
                onSelectSchedule(id)
              }
            }
          "
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
          :requested-merged-tab="requestedMergedTab"
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
          :automation="currentAutomation"
          :intent-action-error-seq="intentActionErrorSeq"
          :intent-sessions="currentIntentSessions"
          :selected-intent-session-id="selectedIntentSessionId"
          :intent-session-run-states="intentSessionRunStates"
          :intent-spec-content="intentSpecContent"
          :intent-spec-loading="intentSpecLoading"
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
          @requested-intent-consumed="requestedIntentId = null"
          @requested-subtab-consumed="requestedIntentSubTab = null"
          @requested-tab-consumed="requestedMergedTab = null"
          @filter="setIntentFilter"
          @refine="refineIntent"
          @write-spec="writeSpec"
          @approve-spec="approveSpec"
          @open-spec-session="openSpecSession"
          @open-intent-session="selectIntentSession"
          @read-spec="readIntentSpec"
          @reset-intent-session="resetIntentSession"
          @reset-spec-session="resetSpecSession"
          @start-dev="startDevelopment"
          @open-dev="openDevSession"
          @set-status="setIntentStatus"
          @set-automate="setIntentAutomate"
          @update-deps="updateIntentDeps"
          @create-pr="createPr"
          @start-automation="startAutomation"
          @stop-automation="stopAutomation"
          @new-intent="newIntentChat"
          @select-intent-session="selectIntentSession"
          @new-intent-session="newIntentChat"
          @rename-intent-session="renameIntentSession"
          @delete-intent-session="deleteIntentSession"
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
          @update:input="discussionInput = $event"
          @submit-input="submitDiscussionInput"
          @mobile-back="onDiscussionMobileBack"
        />

        <Schedules
          v-else-if="activeTab === 'schedules' && schedulesProject"
          :schedules="currentSchedules"
          :active-id="selectedScheduleId"
          :schedule="selectedSchedule"
          :logs="selectedScheduleLogs"
          :transcripts="executionTranscripts"
          :form-open="scheduleFormOpen"
          :form-target="scheduleFormTarget"
          :workspace-path="schedulesProject ?? ''"
          :timezone="scheduleTimezone"
          :execution-id="selectedExecutionId"
          :execution="selectedExecution"
          :tool-manifest="scheduleToolManifest"
          :tool-manifest-loading="scheduleToolManifestLoading"
          :tool-manifest-error="scheduleToolManifestError"
          :host-status="hostStatus"
          :agents="serverSettings?.agents ?? []"
          @select="onSelectSchedule"
          @open-form="openScheduleForm"
          @delete-schedule="deleteSchedule"
          @toggle-enabled="onToggleScheduleEnabled"
          @run-now="runNowSchedule"
          @load-session="onLoadExecutionSession"
          @select-execution="onSelectExecution"
          @mobile-back="onScheduleMobileBack"
          @close-form="scheduleFormOpen = false"
          @create="createSchedule"
          @new-from-template="createScheduleFromTemplate"
          @update="updateSchedule"
          @load-tool-manifest="onLoadScheduleToolManifest"
        />

        <Codes
          v-else-if="activeTab === 'codes' && codesProject"
          :dirs="codesDirs"
          :expanded="codesExpanded"
          :loading-dirs="codesLoadingDirs"
          :tabs="codesTabs"
          :active-path="codesActivePath"
          :active-tab="codesActiveTab"
          :search-mode="codesSearchMode"
          :search-query="codesSearchQuery"
          :search-pattern="codesSearchPattern"
          :search-result="codesSearchResult"
          :search-loading="codesSearchLoading"
          @toggle-dir="toggleCodesDir"
          @open-file="openCodeFile"
          @open-hit="openCodeSearchHit"
          @close-tab="closeCodeTab"
          @select-tab="setCodesActiveTab"
          @set-search-mode="setCodesSearchMode"
          @update:search-query="codesSearchQuery = $event"
          @update:search-pattern="codesSearchPattern = $event"
          @run-search="runCodeSearch"
          @toast="showToast"
        />
      </template>

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
      :current-workspace="currentWorkspace"
      :vendor-modes="vendorModes"
      :system-sandboxes="serverSettings?.sandboxes ?? []"
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

  <!-- Schedule save overlay: blocks interaction while a schedule create/update is
       in flight (2-4s typical round-trip). -->
  <ScheduleSaveOverlay :saving="scheduleSaving" />
</template>

<style scoped>
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
