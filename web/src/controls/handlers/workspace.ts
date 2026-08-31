import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import { resolveCurrentWorkspace } from '@/lib/current-workspace'

export function buildWorkspaceHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'workspaces'
  | 'workspace_directory_selection'
  | 'workspace_setting'
  | 'park_recovery_stats'
  | 'workspace_memories'
  | 'workspace_memory_deleted'
  | 'workspace_accessors'
  | 'workspace_dashboard'
  | 'workspaces_automation_result'
> {
  const {
    auth,
    t,
    send,
    add,
    workspaces,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    currentWorkspace,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    sessionCounts,
    ownerRunningCounts,
    activeWorkspace,
    activeSession,
    activeTitle,
    activeVendor,
    activeAgentSwitch,
    activeSessionSource,
    mode,
    codexPolicy,
    sessionStatus,
    messages,
    counters,
    availableCommands,
    activity,
    sideEffectPendingBySession,
    currentAgentIndexBySession,
    taskModel,
    selectedIntentSessionId,
    teamSessions,
    serverSettings,
    personalizedSettings,
    hostStatus,
    vendorRuntime,
    sandboxStatus,
    bindingStats,
    myMcpApiKeys,
    myMcpApiKeyCreated,
    myImIdentity,
    imIdentityChallengeCreated,
    imIdentityBindings,
    imGroupWorkspaceScopes,
    imGroupScopeChatId,
    userWorkspaceAccess,
    providerProbes,
    workspaceAccessors,
    sessionCapabilities,
    vendorCapabilities,
    vendorModes,
    skillSupport,
    skillLinkStatuses,
    installingSkillIds,
    skillApprovalRequest,
    intents,
    intentsSdd,
    intentSessions,
    intentSessionRunStates,
    intentSpecContent,
    intentSpecLoading,
    pendingSpecRel,
    intentLogsById,
    intentLogsLoading,
    deliveryLogsById,
    deliveryLogsLoading,
    intentsProject,
    requestedIntentId,
    requestedIntentSubTab,
    createIntentPending,
    createIntentDialogOpen,
    awaitingIntentSessionBindId,
    automation,
    queueDetail,
    discussions,
    discussionRunState,
    researchState,
    activeDiscussion,
    activeDiscussionId,
    deliveries,
    deliveriesProject,
    deliveriesNeedsAction,
    activeDelivery,
    activeDeliveryId,
    activeDeliveryPlan,
    activeDeliveryIntents,
    activeDeliveryMainlineAhead,
    activeDeliveryBranchAhead,
    activeDeliverySyncPhase,
    activeDeliveryPr,
    activeDeliveryPrBusy,
    autoSyncedDeliveryPrs,
    activeDeliveryBranchInit,
    pendingStandaloneDelivery,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    discussionDispatch,
    automations,
    automationsProject,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
    selectedAutomationId,
    automationSaving,
    automationLogs,
    automationToolManifest,
    automationToolManifestLoading,
    automationToolManifestError,
    robotToolManifest,
    robotToolManifestLoading,
    robotToolManifestError,
    feishuAppRegistration,
    executionTranscripts,
    filesProject,
    filesDirs,
    filesLoadingDirs,
    filesTabs,
    filesSearchMode,
    filesSearchResult,
    filesSearchLoading,
    activeTab,
    workcenterEvents,
    intentActionErrorSeq,
    createPrFailureContext,
    linkIntentPrPending,
    linkIntentPrDialogOpen,
    clearSideEffectPending,
    devLaunch,
    specLaunch,
    createPrProgress,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    settingsOpen,
    addWorkspaceOpen,
    coldStart,
    evaluateWorkspaceOnboarding,
    findSessionRow,
    ownerKindForSessionKind,
    placeholderKindFor,
    appendPinnedConsoleSessionIfMissing,
    pruneDashboardPending,
  } = locals

  return {
    workspaces: (_ctx, msg) => {
      workspaces.value = msg.workspaces
      // If the current workspace was removed, fall back to the most-recent one.
      const resolved = resolveCurrentWorkspace(currentWorkspace.value, msg.workspaces)
      if (resolved !== currentWorkspace.value) {
        currentWorkspace.value = resolved
        ctx.persistCurrentWorkspace()
        ctx.ensureSessions(resolved)
      }
    },
    workspace_directory_selection: (_ctx, msg) => {
      const picker = ctx.workspaceDirectoryPicker.value
      // 只认当前请求:弹框已关闭(requestId 置空)或用户又点了一次「选择目录」
      // 时,旧对话框迟到的结果不得回填到别的表单上。
      if (picker.requestId !== msg.requestId) return
      const result = msg.result
      ctx.workspaceDirectoryPicker.value = {
        requestId: null,
        pending: false,
        // 取消是正常结果:不报错、不清空已选路径,弹框保持原状。
        error: result.kind === 'failed' ? result.error : null,
        selection: result.kind === 'selected' ? { path: result.path } : picker.selection,
      }
    },
    workspace_setting: (_ctx, msg) => {
      currentWorkspaceSetting.value = msg.config
      detectedMainBranch.value = msg.detectedMainBranch ?? null
      resolvedSpecRoot.value = msg.resolvedSpecRoot ?? null
      sysExtraMounts.value = msg.sysExtraMounts ?? []
      // The automations view keeps its own gate snapshot, bound to
      // `automationsProject`. Adopt only a reply whose workspace matches, so a
      // late reply for a previous workspace never updates the current toggle.
      // The matching echo (initial load or the save round-trip) is the source of
      // truth: it reconciles the gate value and clears any pending-save flag.
      if (msg.workspaceName === automationsProject.value) {
        automationWorkspaceSetting.value = msg.config
        automationWorkspaceSettingId.value = msg.workspaceName
        automationEnabledSaving.value = false
        automationSettingBeforeSave.value = null
      }
    },
    park_recovery_stats: (_ctx, msg) => {
      // Adopt only a reply for the workspace still on screen: a late answer for
      // one the user has left must be dropped, never shown under the new name.
      if (msg.workspaceName === currentWorkspace.value) {
        ctx.parkRecoveryLoading.value = false
        ctx.parkRecoveryStats.value = msg.stats ?? null
        ctx.parkRecoveryError.value = msg.error ?? null
      }
    },
    workspace_memories: (_ctx, msg) => {
      // Scoped to one workspace: a late answer for one the user has left must be
      // dropped, never shown under the workspace now on screen.
      if (msg.workspaceName === currentWorkspace.value) {
        ctx.workspaceMemoriesLoading.value = false
        ctx.workspaceMemoriesError.value = null
        ctx.workspaceMemories.value = msg.items
      }
    },
    workspace_memory_deleted: (_ctx, msg) => {
      if (msg.workspaceName === currentWorkspace.value) {
        ctx.deletingMemoryIds.value = ctx.deletingMemoryIds.value.filter((id) => id !== msg.id)
        // Drop the confirmed row locally instead of re-reading the whole list:
        // the server told us exactly which id is gone, and a refetch would make
        // an unrelated concurrent write look like part of this delete.
        ctx.workspaceMemories.value =
          ctx.workspaceMemories.value?.filter((m) => m.id !== msg.id) ?? null
        ctx.showToast(t('workspaceSetting.memories.deleted.toast', { title: msg.title }))
      }
    },
    workspace_accessors: (_ctx, msg) => {
      // Scoped to one workspace, like the key roster: a reply that raced with a
      // workspace switch must not describe the page now showing another one.
      if (msg.workspaceName !== currentWorkspace.value) return
      workspaceAccessors.value = msg.subjects
    },
    workspace_dashboard: (_ctx, msg) => {
      ctx.dashboardLoading.value = false
      if (msg.error) {
        // Whole-snapshot failure: keep the last good rows, surface the error.
        ctx.dashboardError.value = msg.error
      } else {
        ctx.dashboardError.value = null
        ctx.dashboardRows.value = msg.rows
        pruneDashboardPending(msg.rows)
      }
      // A refresh requested while this one was in flight — run exactly one more.
      if (ctx.dashboardRefreshPending.value) {
        ctx.dashboardRefreshPending.value = false
        ctx.loadDashboard()
      }
    },
    workspaces_automation_result: (_ctx, msg) => {
      // Clear the in-flight flag for exactly the rows this reply settled (concurrent
      // per-row toggles each get their own reply; never wipe another row's pending).
      const settled = new Set(msg.results.map((r) => r.workspaceName))
      ctx.dashboardPending.value = new Set(
        [...ctx.dashboardPending.value].filter((id) => !settled.has(id)),
      )
      if (msg.dashboardError) {
        // The post-op snapshot failed; keep settled results and re-request once.
        ctx.dashboardError.value = msg.dashboardError
        ctx.loadDashboard()
      } else {
        ctx.dashboardError.value = null
        ctx.dashboardRows.value = msg.dashboard
        pruneDashboardPending(msg.dashboard)
      }
      // A successful toggle is visible (the switch flips to the snapshot state); only
      // surface failures, where the switch reverts and the reason is otherwise silent.
      const failCount = msg.results.filter((r) => !r.ok).length
      if (failCount > 0) ctx.showToast(ctx.t('dashboard.toggleFailed', { count: failCount }))
    },
  }
}
