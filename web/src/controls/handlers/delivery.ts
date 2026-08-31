import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import { defaultDeliveryBranchName } from '@/lib/delivery-view'
import { translateUiError } from '@/i18n/errors'

export function buildDeliveryHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'deliveries'
  | 'create_delivery_result'
  | 'delivery_logs_list'
  | 'delivery_detail'
  | 'delivery_transition_failed'
  | 'delivery_sync_mainline_progress'
  | 'delivery_sync_mainline_result'
  | 'delivery_branch_init_progress'
  | 'delivery_branch_init_result'
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
    deliveries: (_ctx, msg) => {
      deliveries.value = { ...deliveries.value, [msg.workspaceName]: msg.items }
      deliveriesNeedsAction.value = {
        ...deliveriesNeedsAction.value,
        [msg.workspaceName]: msg.needsActionCount,
      }
      // Keep the open delivery's model in sync with the freshest list frame.
      if (activeDeliveryId.value) {
        const updated = msg.items.find((d) => d.id === activeDeliveryId.value)
        if (updated) activeDelivery.value = updated
      }
    },
    create_delivery_result: (_ctx, msg) => {
      // Open the newly-created delivery on the creating connection right away.
      activeDeliveryId.value = msg.delivery.id
      activeDelivery.value = msg.delivery
      // The id just changed to a brand-new delivery: its detail is re-fetched
      // below, but the previous delivery's PR / ahead values must not linger
      // across the gap (a failed or dropped detail reply would otherwise leave
      // a stale PR row on a delivery that has none).
      activeDeliveryPr.value = null
      activeDeliveryMainlineAhead.value = null
      activeDeliveryBranchAhead.value = null
      send({ type: 'get_delivery_detail', deliveryId: msg.delivery.id })
      // One-time `pr:merge` semantic-change notice — the only defense against
      // the drift, shown exactly on the workspace's first delivery creation.
      if (msg.prMergeNotice) ctx.showToast(t('delivery.page.prMergeNotice.label'))
      // 「当前意图独立交付」 continues here: this frame is the first moment the
      // new delivery's id exists. Link first, then initialize the branch —
      // linking before the branch exists is what keeps the diff-bloat check
      // silent, and it is correct to be silent: a branch cut from the current
      // mainline head necessarily has the intent's fork point as an ancestor.
      // The pending slot is consumed here, so a delivery-page create that
      // arrives later is never chained onto.
      const standalone = pendingStandaloneDelivery.value
      if (standalone) {
        pendingStandaloneDelivery.value = null
        ctx.linkIntentDelivery(standalone.workspaceName, msg.delivery.id, standalone.intentId)
        ctx.initDeliveryBranchFor(
          standalone.workspaceName,
          msg.delivery.id,
          defaultDeliveryBranchName(msg.delivery.id, msg.delivery.title),
          'create',
        )
      }
    },
    delivery_logs_list: (_ctx, msg) => {
      // Cache per DELIVERY id — a reply that arrives after the user moved on
      // lands under its own key and is never rendered as the open delivery's
      // trail. The loading flag only clears for the delivery it belongs to.
      deliveryLogsById.value = { ...deliveryLogsById.value, [msg.deliveryId]: msg.items }
      if (deliveryLogsLoading.value === msg.deliveryId) deliveryLogsLoading.value = null
    },
    delivery_detail: (_ctx, msg) => {
      activeDelivery.value = msg.delivery
      activeDeliveryId.value = msg.delivery.id
      // This frame is the reply to EVERY delivery write, so the trail this page
      // holds for the delivery may now be one action short. Dropping the cache
      // makes an open 「日志」 tab re-fetch at once and a closed one re-fetch when
      // it is next opened — the tab, not this handler, decides which.
      ctx.invalidateDeliveryLogs(msg.delivery.id)
      activeDeliveryPlan.value = msg.transitionPlan
      activeDeliveryIntents.value = msg.associatedIntents
      activeDeliveryMainlineAhead.value = msg.mainlineAhead
      activeDeliveryBranchAhead.value = msg.deliveryBranchAhead
      activeDeliveryPr.value = msg.deliveryPr
      activeDeliveryPrBusy.value = false
      // 「进页自动同步一次」: c3 never polls the forge, so the window between a
      // human merging on the forge and c3 knowing it is closed by syncing once
      // when the delivery is opened. Guarded by the once-per-open set — this
      // very frame is also the sync's own reply, and re-firing on it would loop.
      if (
        msg.deliveryPr &&
        msg.delivery.status !== 'delivered' &&
        msg.delivery.status !== 'cancelled' &&
        !autoSyncedDeliveryPrs.value.has(msg.delivery.id)
      ) {
        autoSyncedDeliveryPrs.value.add(msg.delivery.id)
        ctx.syncDeliveryPr(msg.delivery.id)
      }
      // Only a `link_intent_to_delivery` reply carries this: the link DID go
      // through, so it is a toast, not an error — the user may well have meant
      // to develop on mainline first and rebase later.
      if (msg.linkWarning === 'delivery.diffBloat') {
        ctx.showToast(t('delivery.warning.diffBloat.label'))
      }
      // The server settled 「已交付」 on its own because the branch was already on
      // mainline — the user asked for a PR (or a sync) and got a terminal status,
      // so the reason has to be said out loud.
      if (msg.notice === 'delivery.autoDelivered') {
        ctx.showToast(t('delivery.notice.autoDelivered.label'))
      }
      ctx.persistViewMode()
    },
    delivery_transition_failed: (_ctx, msg) => {
      // A refused status write is also the terminal of a delivery-PR sync that
      // found `merged` but could not settle it — the button must stop spinning.
      activeDeliveryPrBusy.value = false
      // Server truth wins: re-fetch the plan so the persistent gap list under
      // the selector shows the CURRENT gaps (the client's may be stale), then
      // surface the `delivery.error.*` copy in a toast.
      send({ type: 'get_delivery_detail', deliveryId: msg.deliveryId })
      ctx.showToast(
        translateUiError({
          code: msg.code,
          params: { from: msg.currentStatus, to: msg.to },
        }),
      )
    },
    delivery_sync_mainline_progress: (_ctx, msg) => {
      if (msg.deliveryId === activeDeliveryId.value) {
        activeDeliverySyncPhase.value = msg.phase
      }
    },
    delivery_sync_mainline_result: (_ctx, msg) => {
      activeDeliverySyncPhase.value = null
      // `ahead: 0` is a success, not a no-op error: mainline held nothing the
      // delivery branch did not, so there was genuinely nothing to sync.
      ctx.showToast(
        msg.ahead === 0
          ? t('delivery.syncMainline.upToDate.label')
          : t('delivery.syncMainline.done.label', { count: msg.ahead }),
      )
      send({ type: 'get_delivery_detail', deliveryId: msg.deliveryId })
    },
    delivery_branch_init_progress: (_ctx, msg) => {
      // Advance the in-flight init phase. The action seeded it optimistically
      // as `fetching`; a bind / orphan-idempotent path reports a single
      // `binding`. Ignore a frame for a different delivery (superseded retry).
      if (msg.deliveryId === activeDeliveryBranchInit.value?.deliveryId) {
        activeDeliveryBranchInit.value = { deliveryId: msg.deliveryId, phase: msg.phase }
      }
    },
    delivery_branch_init_result: (_ctx, msg) => {
      // Success terminal: clear the in-flight state, adopt the updated model,
      // then re-fetch the detail for the fresh transition plan (branch ready
      // unlocks the status gates). `deliveries` is broadcast separately.
      activeDeliveryBranchInit.value = null
      activeDelivery.value = msg.delivery
      activeDeliveryId.value = msg.delivery.id
      // A branch init changes the branch — the previous delivery's PR row and
      // ahead counts are stale until the detail re-fetch below replaces them.
      activeDeliveryPr.value = null
      activeDeliveryMainlineAhead.value = null
      activeDeliveryBranchAhead.value = null
      send({ type: 'get_delivery_detail', deliveryId: msg.delivery.id })
      if (msg.warning === 'delivery.branchBehindMain') {
        ctx.showToast(t('delivery.warning.branchBehindMain.label'))
      }
    },
  }
}
