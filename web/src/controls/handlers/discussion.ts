import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  reconcileRunState,
  reconcileResearchState,
  researchMessageToChat,
  applyDispatchStatus,
  clearDispatchAgent,
} from '@/lib/discussion-view'
import * as SHARED from './shared'

export function buildDiscussionHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'discussions'
  | 'discussion_detail'
  | 'discussion_message'
  | 'discussion_dispatch_status'
  | 'discussion_run_status'
  | 'research_message'
  | 'research_run_status'
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
    discussions: (_ctx, msg) => {
      discussions.value = { ...discussions.value, [msg.workspaceName]: msg.items }
      // Authoritatively reconcile the live run-state for THIS list's discussions.
      discussionRunState.value = reconcileRunState(
        discussionRunState.value,
        msg.items,
        msg.runStates,
      )
      // Same authoritative reconcile for the research phase (id → running).
      researchState.value = reconcileResearchState(
        researchState.value,
        msg.items,
        msg.researchStates,
      )
      // Keep the open discussion's status/conclusion in sync.
      if (activeDiscussionId.value) {
        const updated = msg.items.find((d) => d.id === activeDiscussionId.value)
        if (updated) activeDiscussion.value = updated
      }
    },
    discussion_detail: (_ctx, msg) => {
      activeDiscussion.value = msg.discussion
      activeDiscussionId.value = msg.discussion.id
      // Render the persisted history as read-only chat bubbles (own id space).
      const agents = serverSettings.value?.agents ?? []
      const defaultAgentId = serverSettings.value?.defaultAgentId ?? SHARED.SYSTEM_AGENT_ID
      discussionMessages.value = discussionMessagesToChat(
        msg.messages,
        agents,
        defaultAgentId,
        t,
      ).map((b, i) => ({
        ...b,
        id: i + 1,
      }))
      discussionMaxSeq.value = msg.messages.length ? msg.messages[msg.messages.length - 1].seq : 0
      // Research messages are runtime-only, but the snapshot replays the live
      // run's transcript (empty when none in flight) so a reconnect/refresh
      // mid-research restores what was already shown; later live `research_message`
      // events de-dupe against `researchMaxSeq`.
      researchMessages.value = msg.researchMessages.map((rm, i) => ({
        ...researchMessageToChat(rm, { researcher: t('discussion.speaker.researcher') }),
        id: i + 1,
      }))
      researchMaxSeq.value = msg.researchMessages.length
        ? msg.researchMessages[msg.researchMessages.length - 1].seq
        : 0
      ctx.persistViewMode()
      // Check for deep-link fulfillment: the target discussion landed.
      if (
        pendingDeepLink.value?.kind === 'discussion' &&
        msg.discussion.id === pendingDeepLink.value.id
      ) {
        deepLinkFulfilled.value = new Set(deepLinkFulfilled.value).add(msg.discussion.id)
        ctx.clearPendingDeepLink()
      }
    },
    discussion_message: (_ctx, msg) => {
      // A landed reply clears its author's in-flight (pending) status.
      const cleared = clearDispatchAgent(
        discussionDispatch.value[msg.discussionId],
        msg.message.speakerAgentId,
      )
      if (cleared !== discussionDispatch.value[msg.discussionId])
        discussionDispatch.value = {
          ...discussionDispatch.value,
          [msg.discussionId]: cleared!,
        }
      // Live append while the organizer engine runs.
      if (
        msg.discussionId === activeDiscussionId.value &&
        msg.message.seq > discussionMaxSeq.value
      ) {
        discussionMaxSeq.value = msg.message.seq
        const liveAgents = serverSettings.value?.agents ?? []
        const liveDefaultAgentId = serverSettings.value?.defaultAgentId ?? SHARED.SYSTEM_AGENT_ID
        discussionMessages.value.push({
          ...discussionMessageToChat(msg.message, liveAgents, liveDefaultAgentId, t),
          id: discussionMessages.value.length + 1,
        })
      }
    },
    discussion_dispatch_status: (_ctx, msg) => {
      // Transient in-flight/failed status of dispatched agents.
      discussionDispatch.value = {
        ...discussionDispatch.value,
        [msg.discussionId]: applyDispatchStatus(discussionDispatch.value[msg.discussionId], msg),
      }
    },
    discussion_run_status: (_ctx, msg) => {
      // Track the live run-state; `ended` drops the entry.
      const next = { ...discussionRunState.value }
      if (msg.state === 'ended') delete next[msg.discussionId]
      else next[msg.discussionId] = msg.state
      discussionRunState.value = next
      // The run ending clears any lingering dispatch status for that discussion.
      if (msg.state === 'ended' && discussionDispatch.value[msg.discussionId]) {
        const d = { ...discussionDispatch.value }
        delete d[msg.discussionId]
        discussionDispatch.value = d
      }
    },
    research_message: (_ctx, msg) => {
      // Live append of a research turn while the read-only research agent works.
      if (msg.discussionId === activeDiscussionId.value && msg.message.seq > researchMaxSeq.value) {
        researchMaxSeq.value = msg.message.seq
        researchMessages.value.push({
          ...researchMessageToChat(msg.message, {
            researcher: t('discussion.speaker.researcher'),
          }),
          id: researchMessages.value.length + 1,
        })
      }
    },
    research_run_status: (_ctx, msg) => {
      // Track research liveness; `ended` drops the entry.
      const next = { ...researchState.value }
      if (msg.state === 'ended') delete next[msg.discussionId]
      else next[msg.discussionId] = 'running'
      researchState.value = next
    },
  }
}
