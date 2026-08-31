import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildFilesHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<HandlerMap, 'dir_listed' | 'file_git_status' | 'file_read' | 'files_searched'> {
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
    dir_listed: (_ctx, msg) => {
      // Adopt the listing only for the workspace currently being browsed.
      if (msg.workspaceName !== filesProject.value) return
      filesDirs.value = { ...filesDirs.value, [msg.rel]: msg.entries }
      if (filesLoadingDirs.value.has(msg.rel)) {
        const next = new Set(filesLoadingDirs.value)
        next.delete(msg.rel)
        filesLoadingDirs.value = next
      }
    },
    file_git_status: (_ctx, msg) => {
      // Authoritative workspace Git-status snapshot; the action guards workspace
      // isolation and the in-flight/merge bookkeeping.
      ctx.applyFileGitStatus(msg.workspaceName, msg.files)
    },
    file_read: (_ctx, msg) => {
      // Intent-detail `spec` tab: adopt the reply only for the rel we are
      // awaiting, so a concurrent files read never overwrites the spec view.
      if (
        msg.workspaceName === intentsProject.value &&
        pendingSpecRel.value !== null &&
        msg.file.path === pendingSpecRel.value
      ) {
        intentSpecContent.value = msg.file.content ?? ''
        intentSpecLoading.value = false
        pendingSpecRel.value = null
      }
      // Files page: fill the matching tab's content (opened optimistically).
      if (msg.workspaceName === filesProject.value) {
        filesTabs.value = filesTabs.value.map((tab) =>
          tab.path === msg.file.path ? { ...tab, file: msg.file, loading: false } : tab,
        )
      }
    },
    files_searched: (_ctx, msg) => {
      if (msg.workspaceName !== filesProject.value) return
      // Ignore a stale reply if the user switched modes mid-flight.
      if (msg.mode !== filesSearchMode.value) return
      filesSearchResult.value = {
        query: msg.query,
        mode: msg.mode,
        hits: msg.hits,
        truncated: msg.truncated,
        timedOut: msg.timedOut,
      }
      filesSearchLoading.value = false
    },
  }
}
