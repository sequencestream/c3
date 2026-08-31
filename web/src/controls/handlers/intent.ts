import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildIntentHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'intents'
  | 'create_intent_result'
  | 'dev_launch_progress'
  | 'create_pr_progress'
  | 'create_pr_response'
  | 'link_intent_pr_response'
  | 'spec_launch_progress'
  | 'intent_logs_list'
  | 'intent_worktree_baseline_notice'
  | 'intent_worktree_repair_result'
  | 'intent_sessions'
  | 'workflow_status'
  | 'queue_detail'
  | 'sync_intent_pr_status_response'
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
    intents: (_ctx, msg) => {
      intents.value = { ...intents.value, [msg.workspaceName]: msg.items }
      intentsSdd.value = { ...intentsSdd.value, [msg.workspaceName]: msg.sddEnabled }
      // Success terminal for the startup overlay: the target intent flipping to
      // `in_progress` (via the resident `run:bound` subscription) means the dev
      // session bound — close the overlay (silently, no toast).
      const dl = devLaunch.value
      if (dl && msg.items.some((it) => it.id === dl.intentId && it.status === 'in_progress')) {
        ctx.dispatchDevLaunch({ kind: 'ready', intentId: dl.intentId, now: Date.now() })
      }
      ctx.consumePendingWorkSessionSelect(true)
      const sl = specLaunch.value
      if (sl && msg.items.some((it) => it.id === sl.intentId && !!it.specSessionId)) {
        ctx.dispatchSpecLaunch({ kind: 'ready', intentId: sl.intentId, now: Date.now() })
      }
      // Clear the post-create "awaiting session bind" flag only when the session
      // id actually lands — a mid-prepare snapshot that lists the id without a
      // session is the normal create window and must keep the in-page loader.
      const awaitingBind = awaitingIntentSessionBindId.value
      if (awaitingBind && msg.items.some((it) => it.id === awaitingBind && !!it.intentSessionId)) {
        awaitingIntentSessionBindId.value = null
      }
    },
    create_intent_result: (_ctx, msg) => {
      createIntentPending.value = false
      // The intent exists, so the form has nothing left to preserve — this is
      // the ONLY thing that closes the create dialog. A refusal leaves it open
      // with the typed content intact.
      createIntentDialogOpen.value = false
      if (msg.workspaceName === intentsProject.value) {
        // Merge the receipt into the local snapshot so Intents.vue can select
        // immediately — do not wait for a later `intents` broadcast (which often
        // arrives only after worktree / session bind). Later broadcasts remain
        // authoritative and overwrite this row (including intentSessionId).
        const prev = intents.value[msg.workspaceName] ?? []
        const idx = prev.findIndex((it) => it.id === msg.intent.id)
        const merged =
          idx >= 0 ? prev.map((it, i) => (i === idx ? msg.intent : it)) : [...prev, msg.intent]
        intents.value = { ...intents.value, [msg.workspaceName]: merged }
        // Land on the created intent by its exact server id — never by list
        // position or title. The one-shot request is consumed by Intents.vue
        // once that id is in this workspace's snapshot (now true via the merge
        // above), so the create result and the `intents` broadcast may arrive
        // in either order.
        requestedIntentId.value = msg.intent.id
        requestedIntentSubTab.value = 'intentSession'
        // Contentful creates start an owner session asynchronously; arm the
        // in-page loading gate so firstIntentTurn does not flash during bind.
        // Blank registration does not start a session and must not arm.
        if ((msg.intent.content ?? '').trim() !== '') {
          awaitingIntentSessionBindId.value = msg.intent.id
        }
      }
      // The wait is over: close the progress overlay (silently, after its
      // minimum dwell) so it only covers the switch to the new intent's tab.
      ctx.dispatchCreateIntent({ kind: 'done', now: Date.now() })
    },
    dev_launch_progress: (_ctx, msg) => {
      // Advance the overlay's coarse phase; a `failed` stage closes it with an
      // error toast (the reducer + dispatch handle the side-effects).
      ctx.dispatchDevLaunch({
        kind: 'stage',
        intentId: msg.intentId,
        stage: msg.stage,
        now: Date.now(),
      })
    },
    create_pr_progress: (_ctx, msg) => {
      // Advance the create-PR overlay's stage; the reducer ignores a repeat, a
      // back-step, another intent's frame or another run's token.
      ctx.dispatchCreatePr({
        kind: 'stage',
        intentId: msg.intentId,
        stage: msg.stage,
        requestId: msg.requestId,
        now: Date.now(),
      })
    },
    create_pr_response: (_ctx, msg) => {
      // Success terminal: the PR link arrives with the intents broadcast, so the
      // overlay just closes (after its minimum dwell) — but only for the run it
      // belongs to; a reply outliving its overlay is dropped by the reducer.
      ctx.dispatchCreatePr({ kind: 'done', requestId: msg.requestId, now: Date.now() })
      createPrFailureContext.value = null
    },
    link_intent_pr_response: (_ctx, msg) => {
      ctx.closeLinkIntentPrDialog()
      createPrFailureContext.value = null
      ctx.showToast(t('intent.prLink.success'))
    },
    spec_launch_progress: (_ctx, msg) => {
      ctx.dispatchSpecLaunch({
        kind: 'stage',
        intentId: msg.intentId,
        stage: msg.stage,
        now: Date.now(),
      })
    },
    intent_logs_list: (_ctx, msg) => {
      // Cache per intent id; the changelog tab renders straight from this map.
      intentLogsById.value = { ...intentLogsById.value, [msg.intentId]: msg.items }
      intentLogsLoading.value = false
    },
    intent_worktree_baseline_notice: (_ctx, msg) => {
      // 会话已经起来了 —— 这条只是说它跑在一个落后于基准分支的目录里。存起来由
      // 意图详情常驻提示,不弹窗、不打断,修复与否是用户的事。
      ctx.noteWorktreeBaseline(msg)
    },
    intent_worktree_repair_result: (_ctx, msg) => {
      // 修完了(重建或合入),那条提示的前提已不复存在,立刻撤掉。
      ctx.clearWorktreeBaselineNotice(msg.intentId)
      ctx.showToast(
        msg.mode === 'rebuild'
          ? t('intent.worktreeBaseline.rebuilt')
          : t('intent.worktreeBaseline.merged'),
      )
    },
    intent_sessions: (_ctx, msg) => {
      intentSessions.value = { ...intentSessions.value, [msg.workspaceName]: msg.items }
      // Authoritatively reconcile the live run-state from the snapshot.
      if (msg.runStates) {
        intentSessionRunStates.value = msg.runStates
      }
      // Update the selected session id when the list changes.
      if (msg.workspaceName === intentsProject.value && msg.items.length > 0) {
        const active = msg.items.find((s) => s.sessionId === activeSession.value)
        if (active) {
          selectedIntentSessionId.value = active.sessionId
          // Sync the right-panel title with the DB title.
          if (active.title) {
            activeTitle.value = active.title
          }
        } else if (activeSession.value) {
          selectedIntentSessionId.value = activeSession.value
        } else {
          selectedIntentSessionId.value = msg.items[0].sessionId
        }
      }
    },
    workflow_status: (_ctx, msg) => {
      automation.value = { ...automation.value, [msg.status.workspaceName]: msg.status }
    },
    queue_detail: (_ctx, msg) => {
      queueDetail.value = { ...queueDetail.value, [msg.detail.workspaceName]: msg.detail }
    },
    sync_intent_pr_status_response: (_ctx, msg) => {
      ctx.intentPrSync.value = {
        ...ctx.intentPrSync.value,
        [msg.intentId]: {
          state: msg.ok ? 'success' : 'error',
          message:
            msg.message ??
            msg.error ??
            (msg.ok ? t('intent.prSync.success') : t('intent.prSync.failed')),
        },
      }
      if (msg.ok && msg.changed) ctx.showToast(msg.message ?? t('intent.prSync.success'))
    },
  }
}
