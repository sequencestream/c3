import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import * as SHARED from './shared'
import { translateUiError } from '@/i18n/errors'
import { normalizeGuidance } from '@/lib/git-failure-guidance'
import { isCreatePrFailureCode } from '@/lib/create-pr-failure'
import { gateEscapeFor } from '@/lib/gate-escape'

export function buildErrorHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<HandlerMap, 'error'> {
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
    error: (_ctx, msg) => {
      // A refused `create_delivery` is the terminal of a 「当前意图独立交付」 run:
      // nothing was created, so the chain has nothing to continue with. Release
      // the pending slot (it is also the double-send guard) so the button is
      // usable again, then let the error fall through to its normal toast.
      if (
        pendingStandaloneDelivery.value &&
        (msg.error.code === 'delivery.createFailed' ||
          msg.error.code === 'delivery.titleRequired' ||
          msg.error.code === 'delivery.multiRepoUnsupported' ||
          msg.error.code === 'delivery.dbUnavailable' ||
          msg.error.code === 'workspace.unknown')
      ) {
        pendingStandaloneDelivery.value = null
      }
      // A branch-init failure (fetch / push / orphan mismatch / bind-missing /
      // multi-repo) clears the in-flight init state so the form re-enables, and
      // surfaces the reason in a toast (the form lives on the deliveries page,
      // not the chat stream the generic error line below appends to).
      // A failed 「同步主线」 releases the in-flight phase so the button
      // re-enables, and shows git's own words — conflicts included, verbatim.
      if (
        activeDeliverySyncPhase.value &&
        (msg.error.code === 'delivery.syncMainlineConflict' ||
          msg.error.code === 'delivery.syncMainlineFailed' ||
          msg.error.code === 'delivery.syncMainlineForbidden' ||
          msg.error.code === 'delivery.guard.branchNotReady')
      ) {
        activeDeliverySyncPhase.value = null
        ctx.showToast(translateUiError(msg.error))
        return
      }
      if (
        activeDeliveryBranchInit.value &&
        (msg.error.code === 'delivery.multiRepoUnsupported' ||
          msg.error.code === 'delivery.branchConflict' ||
          msg.error.code === 'delivery.branchNotFound' ||
          msg.error.code === 'delivery.initFailed')
      ) {
        activeDeliveryBranchInit.value = null
        ctx.showToast(translateUiError(msg.error))
        return
      }
      // A delivery-PR round trip failed. Every one of these codes means NOTHING
      // moved server-side, so clearing the busy flag simply re-offers the retry.
      if (
        activeDeliveryPrBusy.value &&
        (msg.error.code === 'delivery.deliveryPrForbidden' ||
          msg.error.code === 'delivery.deliveryPrModeUnsupported' ||
          msg.error.code === 'delivery.deliveryPrNoDiff' ||
          msg.error.code === 'delivery.deliveryPrCreateFailed' ||
          msg.error.code === 'delivery.deliveryPrNotFound' ||
          msg.error.code === 'delivery.deliveryPrSyncFailed' ||
          msg.error.code === 'delivery.guard.branchNotReady')
      ) {
        activeDeliveryPrBusy.value = false
        ctx.showToast(translateUiError(msg.error))
        return
      }
      // A create_pr run has no error code of its own — its gates report
      // `intent.prCreate*` and `workspace.unknown` — so the failure terminal is
      // recognised by the echoed `requestId` instead. Errors from any other
      // request on this connection carry no token (or an older one) and leave
      // the overlay alone, which then converges on its safety timeout. The
      // reason is shown by the dialog / chat line below, never in the overlay.
      if (createPrProgress.value) {
        const progress = createPrProgress.value
        ctx.dispatchCreatePr({ kind: 'failed', requestId: msg.requestId, now: Date.now() })
        if (msg.requestId === progress.requestId && isCreatePrFailureCode(msg.error.code)) {
          createPrFailureContext.value = {
            intentId: progress.intentId,
            deliveryId: progress.deliveryId,
          }
        }
      }
      if (linkIntentPrPending.value || msg.error.code.startsWith('intent.prLink')) {
        const reason = translateUiError(msg.error)
        ctx.failLinkIntentPr(reason)
        ctx.showToast(reason)
        return
      }
      // Machine-readable code translated locally via the web i18n catalog (spec 003).
      // Intent action errors (start_development gates, approve/write spec, deps, …)
      // surface as a persistent global dialog so they are visible on the intents page. They used
      // to be appended only to the (often not-open) chat stream, so a rejected action
      // looked like "nothing happened". The seq bump still releases the start-dev
      // in-flight guard. Not added to the chat stream — an action error is not session
      // content.
      // Every way `create_intent` can be refused must release the "增加意图"
      // in-flight guard, or the button (and the create dialog's submit) stays
      // disabled until the page state is rebuilt. The base-selection refusals
      // are listed alongside the original three because they are rejections of
      // the SAME request — and they are the ones the dialog stays open for, so
      // the user can fix the base and resubmit without retyping the content.
      // Spread across three prefixes (`workspace.` / `intent.` / `delivery.`),
      // hence an explicit set rather than a prefix test.
      // The same refusals are also the create overlay's failure terminal — it has
      // no echoed token of its own, so the refusal codes ARE the correlation (the
      // single-flight guard means at most one create is ever in flight). An error
      // with any other code leaves the overlay up for its safety timeout.
      if (createIntentPending.value && SHARED.CREATE_INTENT_REFUSAL_CODES.has(msg.error.code)) {
        createIntentPending.value = false
        awaitingIntentSessionBindId.value = null
        ctx.dispatchCreateIntent({
          kind: 'failed',
          code: msg.error.code,
          message: translateUiError(msg.error),
          now: Date.now(),
        })
      }
      // An agent-configuration refusal (an unusable agent group) can arrive from
      // ANY creation flow — new session, intent conversation, spec authoring or
      // review — so it is surfaced globally rather than in one page's error
      // channel, and it releases whatever startup overlay was waiting on the
      // session that will now never exist.
      if (msg.error.code.startsWith('agent.')) {
        const reason = translateUiError(msg.error)
        if (devLaunch.value) ctx.closeDevLaunch()
        if (specLaunch.value) ctx.dispatchSpecLaunch({ kind: 'failed', now: Date.now() })
        createIntentPending.value = false
        awaitingIntentSessionBindId.value = null
        // The create overlay closes without a toast of its own: the one below is
        // the report, and repeating it would say the same thing twice.
        ctx.dispatchCreateIntent({
          kind: 'failed',
          code: msg.error.code,
          message: reason,
          now: Date.now(),
        })
        ctx.showToast(reason)
        return
      }
      // Post-create owner-session bind failed: drop the in-page loading gate so
      // firstIntentTurn / start_intent_session retry is available again.
      if (SHARED.INTENT_SESSION_BIND_FAIL_CODES.has(msg.error.code)) {
        awaitingIntentSessionBindId.value = null
      }
      if (msg.error.code.startsWith('intent.')) {
        intentActionErrorSeq.value += 1
        // A refusal that leaves the user an EXIT gets the escape dialog instead
        // of the plain error one — never both, or the same refusal would be
        // reported twice. The intent comes from the in-flight launch overlay:
        // an `error` frame carries no intent id, and an exit with no target is
        // a button that does nothing.
        const escape = gateEscapeFor(msg.error.code, devLaunch.value?.intentId ?? null)
        if (escape) {
          ctx.showIntentGateEscape(escape, translateUiError(msg.error))
          ctx.closeDevLaunch()
          return
        }
        // A Git/forge failure may ride along with targeted repair guidance. It
        // is untrusted input, so it is validated here; anything malformed —
        // unknown reason, unknown retry action, missing intent — becomes null
        // and the dialog stays the plain translated error with no button.
        ctx.showIntentActionError(
          translateUiError(msg.error),
          normalizeGuidance(msg.error.guidance),
        )
        // A rejected intent action releases any in-flight startup overlay too.
        // Close it directly: the specific error dialog already explains the failure.
        if (devLaunch.value) ctx.closeDevLaunch()
        if (specLaunch.value) ctx.dispatchSpecLaunch({ kind: 'failed', now: Date.now() })
        return
      }
      // Automation save/update failed — release the saving overlay.
      if (automationSaving.value) automationSaving.value = false
      // A rejected workspace-gate save rolls the toggle back to the last
      // server-confirmed value; the global toast below surfaces the reason.
      if (automationEnabledSaving.value) {
        if (automationSettingBeforeSave.value) {
          automationWorkspaceSetting.value = automationSettingBeforeSave.value
        }
        automationSettingBeforeSave.value = null
        automationEnabledSaving.value = false
      }
      // A refused queue control (unpark on a non-parked intent, an override with
      // no verdict, a missing intent id) has to be visible where it was clicked.
      // The queue page is its own view and never renders the chat stream, so a
      // refusal that only landed there would read as "the button did nothing" —
      // exactly the false success the client must never show.
      if (msg.error.code.startsWith('queue.')) {
        ctx.showToast(translateUiError(msg.error))
        return
      }
      // A refused memory delete has to be visible where it was clicked: the
      // workspace-setting page is a full-screen overlay that never renders the
      // chat stream, so a refusal landing only there would read as "the button
      // did nothing". The row stays — nothing was removed.
      if (msg.error.code.startsWith('memory.')) {
        ctx.deletingMemoryIds.value = []
        ctx.showToast(translateUiError(msg.error))
        return
      }
      // The memory listing has exactly one refusal: a workspace the server
      // cannot resolve. Release the in-flight read so the tab shows the failure
      // (with its retry) instead of spinning forever.
      if (ctx.workspaceMemoriesLoading.value && msg.error.code === 'workspace.unknown') {
        ctx.workspaceMemoriesLoading.value = false
        ctx.workspaceMemoriesError.value = msg.error
      }
      add({ kind: 'system', text: `— ${translateUiError(msg.error)} —` })
    },
  }
}
