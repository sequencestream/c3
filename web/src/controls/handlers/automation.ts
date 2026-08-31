import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildAutomationHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'automations'
  | 'automation_detail'
  | 'tool_manifest'
  | 'execution_transcript'
  | 'wait_user_events'
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
    automations: (_ctx, msg) => {
      automations.value = { ...automations.value, [msg.workspaceName]: msg.items }
      // A automation create/update round-trip completed — release the saving overlay.
      if (automationSaving.value) automationSaving.value = false
      // After a run completes the server re-broadcasts the list; refresh the open
      // automation's execution logs so history stays current.
      if (
        activeTab.value === 'automations' &&
        automationsProject.value === msg.workspaceName &&
        selectedAutomationId.value
      ) {
        send({ type: 'get_automation_detail', automationId: selectedAutomationId.value })
      }
    },
    automation_detail: (_ctx, msg) => {
      automationLogs.value = { ...automationLogs.value, [msg.automation.id]: msg.logs }
    },
    tool_manifest: (_ctx, msg) => {
      // The asking grid tags its request with a `scope`, which the server echoes;
      // route to that form's cache so a reply that lands after the other form
      // opened cannot pollute the wrong manifest (a robot has no workspace MCP
      // namespaces; an automation's does).
      if (msg.scope === 'robot') {
        robotToolManifest.value = { ...robotToolManifest.value, [msg.vendor]: msg.tools }
        robotToolManifestLoading.value = false
        robotToolManifestError.value = null
      } else {
        automationToolManifest.value = {
          ...automationToolManifest.value,
          [msg.vendor]: msg.tools,
        }
        automationToolManifestLoading.value = false
        automationToolManifestError.value = null
      }
    },
    execution_transcript: (_ctx, msg) => {
      executionTranscripts.value = {
        ...executionTranscripts.value,
        [msg.executionId]: msg.items,
      }
    },
    wait_user_events: (_ctx, msg) => {
      if (msg.hasMore === undefined) {
        const nonTodo = workcenterEvents.value.filter((event) => event.status !== 'todo')
        workcenterEvents.value = [...msg.items, ...nonTodo]
      } else if (ctx.workcenterAppendNext.value) {
        const seen = new Set(workcenterEvents.value.map((event) => event.id))
        workcenterEvents.value = [
          ...workcenterEvents.value,
          ...msg.items.filter((event) => !seen.has(event.id)),
        ]
        ctx.workcenterHasMore.value = msg.hasMore
        ctx.workcenterAppendNext.value = false
        ctx.workcenterLoading.value = false
      } else {
        workcenterEvents.value = msg.items
        ctx.workcenterHasMore.value = msg.hasMore
        ctx.workcenterLoading.value = false
      }
    },
  }
}
