import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildRobotHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'robots'
  | 'robot_turns'
  | 'app_registration_progress'
  | 'app_registration_result'
  | 'my_im_identity'
  | 'im_identity_challenge_created'
  | 'im_identity_bindings'
  | 'im_group_workspace_scopes'
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
    robots: (_ctx, msg) => {
      ctx.robotsLoading.value = false
      ctx.robots.value = msg.robots
      // A selection that no longer exists (deleted elsewhere) is dropped rather
      // than left pointing at nothing.
      if (
        ctx.selectedRobotId.value &&
        !msg.robots.some((r) => r.id === ctx.selectedRobotId.value)
      ) {
        ctx.selectedRobotId.value = null
        ctx.robotTurns.value = []
      }
    },
    robot_turns: (_ctx, msg) => {
      // Ignore a reply for a robot the user has since navigated away from.
      if (msg.robotId === ctx.selectedRobotId.value) ctx.robotTurns.value = msg.turns
    },
    app_registration_progress: (_ctx, msg) => {
      // Only the frame for the CURRENT request is applied; a late frame from
      // a cancelled/replaced attempt is ignored, never applied to a new one.
      if (feishuAppRegistration.value.requestId !== msg.requestId) return
      const current = feishuAppRegistration.value
      feishuAppRegistration.value =
        msg.status === 'waiting_scan'
          ? {
              ...current,
              phase: 'waiting_scan',
              verificationUrl: msg.verificationUrl ?? null,
              expiresAt: msg.expiresAt ?? null,
            }
          : { ...current, phase: msg.status }
    },
    app_registration_result: (_ctx, msg) => {
      if (feishuAppRegistration.value.requestId !== msg.requestId) return
      if (msg.outcome === 'ready') {
        feishuAppRegistration.value = {
          ...feishuAppRegistration.value,
          phase: 'ready',
          appId: msg.appId,
          appSecret: msg.appSecret,
        }
      } else if (msg.outcome === 'manual_setup_required') {
        feishuAppRegistration.value = {
          ...feishuAppRegistration.value,
          phase: 'manual_setup_required',
          appId: msg.appId,
          appSecret: msg.appSecret,
          manualSetupReason: msg.reason,
        }
      } else {
        feishuAppRegistration.value = {
          ...feishuAppRegistration.value,
          phase: 'failed',
          failedReason: msg.reason,
          detail: msg.detail ?? null,
        }
      }
    },
    my_im_identity: (_ctx, msg) => {
      myImIdentity.value = {
        bindings: msg.bindings,
        pendingChallenges: msg.pendingChallenges,
        noAuthLocalHint: msg.noAuthLocalHint,
      }
    },
    im_identity_challenge_created: (_ctx, msg) => {
      imIdentityChallengeCreated.value = msg.challenge
    },
    im_identity_bindings: (_ctx, msg) => {
      imIdentityBindings.value = msg.bindings
    },
    im_group_workspace_scopes: (_ctx, msg) => {
      if (msg.chatId !== imGroupScopeChatId.value) return
      imGroupWorkspaceScopes.value = msg.grants
    },
  }
}
