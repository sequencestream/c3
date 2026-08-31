import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildAuthHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  'login_result' | 'admin_password_result' | 'account_op_result' | 'unauthenticated'
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
    login_result: (_ctx, msg) => {
      auth.handleLoginResult(msg.result)
      // Login minted a token but this socket is still unauthenticated — force a
      // fresh handshake so `buildUrl()` carries the `?token=` and the server
      // admits us + emits `ready` (with the workspaces snapshot).
      if (msg.result.ok) ctx.reconnect()
    },
    admin_password_result: (_ctx, msg) => {
      if (msg.result.ok) {
        ctx.showToast(t('settings.auth.password.result.ok'))
        // Refresh settings so the panel sees the new "password set" signal.
        send({ type: 'get_settings' })
      } else {
        ctx.showToast(
          t(
            msg.result.code === 'not_authenticated'
              ? 'settings.auth.password.error.not_authenticated'
              : 'settings.auth.password.error.invalid',
          ),
        )
      }
    },
    account_op_result: (_ctx, msg) => {
      if (msg.result.ok) {
        ctx.showToast(t('settings.auth.account.result.ok'))
        // Refresh settings so the panel reflects the mutated account set / admin.
        send({ type: 'get_settings' })
      } else {
        ctx.showToast(
          t(
            msg.result.code === 'admin_must_reassign'
              ? 'settings.auth.account.error.admin_must_reassign'
              : msg.result.code === 'not_found'
                ? 'settings.auth.account.error.not_found'
                : 'settings.auth.account.error.invalid',
          ),
        )
      }
    },
    unauthenticated: (_ctx, msg) => {
      // The WS analogue of HTTP 401 — drop the local session, show the login
      // gate, and surface why (session expired / invalid / sign-in required).
      auth.handleUnauthenticated(msg.reason)
      const reasonKey =
        msg.reason === 'expired'
          ? 'auth.session.expired'
          : msg.reason === 'invalid'
            ? 'auth.session.invalid'
            : 'auth.session.missing'
      ctx.showToast(t(reasonKey))
    },
  }
}
