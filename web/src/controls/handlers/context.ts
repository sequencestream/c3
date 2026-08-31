import type { SessionInfo, WorkspaceDashboardRow } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { resolveCurrentWorkspace } from '@/lib/current-workspace'
import { activeSessionTitleFromSessions } from '@/lib/session-title-sync'
import type { AppCtx } from '../types'
import type { SessionPageKind } from '../state/types'

/** Mutable cold-start onboarding inputs (per connection, not persisted). */
export interface ColdStartState {
  workspacesEmpty: boolean | null
  isAdmin: boolean
  agentsConfigured: boolean | null
  onboardingEvaluated: boolean
  firstSettingsEvaluated: boolean
}

/**
 * Per-install closure shared across domain handlers: destructured ctx refs,
 * cold-start guards, and session-list helpers that multiple domains need.
 */
export interface MessageHandlerLocals {
  auth: AppCtx['auth']
  t: AppCtx['t']
  send: AppCtx['send']
  add: AppCtx['add']
  workspaces: AppCtx['workspaces']
  workspaceSettingOpen: AppCtx['workspaceSettingOpen']
  currentWorkspaceSetting: AppCtx['currentWorkspaceSetting']
  detectedMainBranch: AppCtx['detectedMainBranch']
  resolvedSpecRoot: AppCtx['resolvedSpecRoot']
  sysExtraMounts: AppCtx['sysExtraMounts']
  currentWorkspace: AppCtx['currentWorkspace']
  sessionsByWorkspace: AppCtx['sessionsByWorkspace']
  sessionPagingByWorkspace: AppCtx['sessionPagingByWorkspace']
  sessionCounts: AppCtx['sessionCounts']
  ownerRunningCounts: AppCtx['ownerRunningCounts']
  activeWorkspace: AppCtx['activeWorkspace']
  activeSession: AppCtx['activeSession']
  activeTitle: AppCtx['activeTitle']
  activeVendor: AppCtx['activeVendor']
  activeAgentSwitch: AppCtx['activeAgentSwitch']
  activeSessionSource: AppCtx['activeSessionSource']
  mode: AppCtx['mode']
  codexPolicy: AppCtx['codexPolicy']
  sessionStatus: AppCtx['sessionStatus']
  messages: AppCtx['messages']
  counters: AppCtx['counters']
  availableCommands: AppCtx['availableCommands']
  activity: AppCtx['activity']
  sideEffectPendingBySession: AppCtx['sideEffectPendingBySession']
  currentAgentIndexBySession: AppCtx['currentAgentIndexBySession']
  taskModel: AppCtx['taskModel']
  selectedIntentSessionId: AppCtx['selectedIntentSessionId']
  teamSessions: AppCtx['teamSessions']
  serverSettings: AppCtx['serverSettings']
  personalizedSettings: AppCtx['personalizedSettings']
  hostStatus: AppCtx['hostStatus']
  vendorRuntime: AppCtx['vendorRuntime']
  sandboxStatus: AppCtx['sandboxStatus']
  bindingStats: AppCtx['bindingStats']
  myMcpApiKeys: AppCtx['myMcpApiKeys']
  myMcpApiKeyCreated: AppCtx['myMcpApiKeyCreated']
  myImIdentity: AppCtx['myImIdentity']
  imIdentityChallengeCreated: AppCtx['imIdentityChallengeCreated']
  imIdentityBindings: AppCtx['imIdentityBindings']
  imGroupWorkspaceScopes: AppCtx['imGroupWorkspaceScopes']
  imGroupScopeChatId: AppCtx['imGroupScopeChatId']
  userWorkspaceAccess: AppCtx['userWorkspaceAccess']
  providerProbes: AppCtx['providerProbes']
  workspaceAccessors: AppCtx['workspaceAccessors']
  sessionCapabilities: AppCtx['sessionCapabilities']
  vendorCapabilities: AppCtx['vendorCapabilities']
  vendorModes: AppCtx['vendorModes']
  skillSupport: AppCtx['skillSupport']
  skillLinkStatuses: AppCtx['skillLinkStatuses']
  installingSkillIds: AppCtx['installingSkillIds']
  skillApprovalRequest: AppCtx['skillApprovalRequest']
  intents: AppCtx['intents']
  intentsSdd: AppCtx['intentsSdd']
  intentSessions: AppCtx['intentSessions']
  intentSessionRunStates: AppCtx['intentSessionRunStates']
  intentSpecContent: AppCtx['intentSpecContent']
  intentSpecLoading: AppCtx['intentSpecLoading']
  pendingSpecRel: AppCtx['pendingSpecRel']
  intentLogsById: AppCtx['intentLogsById']
  intentLogsLoading: AppCtx['intentLogsLoading']
  deliveryLogsById: AppCtx['deliveryLogsById']
  deliveryLogsLoading: AppCtx['deliveryLogsLoading']
  intentsProject: AppCtx['intentsProject']
  requestedIntentId: AppCtx['requestedIntentId']
  requestedIntentSubTab: AppCtx['requestedIntentSubTab']
  createIntentPending: AppCtx['createIntentPending']
  createIntentDialogOpen: AppCtx['createIntentDialogOpen']
  awaitingIntentSessionBindId: AppCtx['awaitingIntentSessionBindId']
  automation: AppCtx['automation']
  queueDetail: AppCtx['queueDetail']
  discussions: AppCtx['discussions']
  discussionRunState: AppCtx['discussionRunState']
  researchState: AppCtx['researchState']
  activeDiscussion: AppCtx['activeDiscussion']
  activeDiscussionId: AppCtx['activeDiscussionId']
  deliveries: AppCtx['deliveries']
  deliveriesProject: AppCtx['deliveriesProject']
  deliveriesNeedsAction: AppCtx['deliveriesNeedsAction']
  activeDelivery: AppCtx['activeDelivery']
  activeDeliveryId: AppCtx['activeDeliveryId']
  activeDeliveryPlan: AppCtx['activeDeliveryPlan']
  activeDeliveryIntents: AppCtx['activeDeliveryIntents']
  activeDeliveryMainlineAhead: AppCtx['activeDeliveryMainlineAhead']
  activeDeliveryBranchAhead: AppCtx['activeDeliveryBranchAhead']
  activeDeliverySyncPhase: AppCtx['activeDeliverySyncPhase']
  activeDeliveryPr: AppCtx['activeDeliveryPr']
  activeDeliveryPrBusy: AppCtx['activeDeliveryPrBusy']
  autoSyncedDeliveryPrs: AppCtx['autoSyncedDeliveryPrs']
  activeDeliveryBranchInit: AppCtx['activeDeliveryBranchInit']
  pendingStandaloneDelivery: AppCtx['pendingStandaloneDelivery']
  discussionMessages: AppCtx['discussionMessages']
  discussionMaxSeq: AppCtx['discussionMaxSeq']
  researchMessages: AppCtx['researchMessages']
  researchMaxSeq: AppCtx['researchMaxSeq']
  discussionDispatch: AppCtx['discussionDispatch']
  automations: AppCtx['automations']
  automationsProject: AppCtx['automationsProject']
  automationWorkspaceSetting: AppCtx['automationWorkspaceSetting']
  automationWorkspaceSettingId: AppCtx['automationWorkspaceSettingId']
  automationEnabledSaving: AppCtx['automationEnabledSaving']
  automationSettingBeforeSave: AppCtx['automationSettingBeforeSave']
  selectedAutomationId: AppCtx['selectedAutomationId']
  automationSaving: AppCtx['automationSaving']
  automationLogs: AppCtx['automationLogs']
  automationToolManifest: AppCtx['automationToolManifest']
  automationToolManifestLoading: AppCtx['automationToolManifestLoading']
  automationToolManifestError: AppCtx['automationToolManifestError']
  robotToolManifest: AppCtx['robotToolManifest']
  robotToolManifestLoading: AppCtx['robotToolManifestLoading']
  robotToolManifestError: AppCtx['robotToolManifestError']
  feishuAppRegistration: AppCtx['feishuAppRegistration']
  executionTranscripts: AppCtx['executionTranscripts']
  filesProject: AppCtx['filesProject']
  filesDirs: AppCtx['filesDirs']
  filesLoadingDirs: AppCtx['filesLoadingDirs']
  filesTabs: AppCtx['filesTabs']
  filesSearchMode: AppCtx['filesSearchMode']
  filesSearchResult: AppCtx['filesSearchResult']
  filesSearchLoading: AppCtx['filesSearchLoading']
  activeTab: AppCtx['activeTab']
  workcenterEvents: AppCtx['workcenterEvents']
  intentActionErrorSeq: AppCtx['intentActionErrorSeq']
  createPrFailureContext: AppCtx['createPrFailureContext']
  linkIntentPrPending: AppCtx['linkIntentPrPending']
  linkIntentPrDialogOpen: AppCtx['linkIntentPrDialogOpen']
  clearSideEffectPending: AppCtx['clearSideEffectPending']
  devLaunch: AppCtx['devLaunch']
  specLaunch: AppCtx['specLaunch']
  createPrProgress: AppCtx['createPrProgress']
  pendingDeepLink: AppCtx['pendingDeepLink']
  deepLinkFulfilled: AppCtx['deepLinkFulfilled']
  deepLinkTimers: AppCtx['deepLinkTimers']
  settingsOpen: AppCtx['settingsOpen']
  addWorkspaceOpen: AppCtx['addWorkspaceOpen']
  coldStart: ColdStartState
  evaluateWorkspaceOnboarding: () => void
  findSessionRow: (sessionId: string) => SessionInfo | undefined
  ownerKindForSessionKind: (kind: SessionPageKind) => NonNullable<SessionInfo['ownerKind']> | null
  placeholderKindFor: (pinnedSessionId: string, displayKind: SessionPageKind) => SessionPageKind
  appendPinnedConsoleSessionIfMissing: (input: {
    workspaceName: string
    sessionKind: SessionPageKind
    sessions: SessionInfo[]
  }) => SessionInfo[]
  pruneDashboardPending: (rows: WorkspaceDashboardRow[]) => void
}

/** Drop in-flight toggle flags for workspaces no longer present in the snapshot. */
function pruneDashboardPending(ctx: AppCtx, rows: WorkspaceDashboardRow[]): void {
  const ids = new Set(rows.map((row) => row.workspaceName))
  ctx.dashboardPending.value = new Set([...ctx.dashboardPending.value].filter((id) => ids.has(id)))
}

/** Build the shared closure every domain handler reads through `locals`. */
export function createMessageHandlerLocals(ctx: AppCtx): MessageHandlerLocals {
  const t = ctx.t
  const auth = ctx.auth
  const send = ctx.send
  const add = ctx.add
  const {
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
  } = ctx

  const coldStart: ColdStartState = {
    workspacesEmpty: null,
    isAdmin: false,
    agentsConfigured: null,
    onboardingEvaluated: false,
    firstSettingsEvaluated: false,
  }

  function evaluateWorkspaceOnboarding(): void {
    if (coldStart.onboardingEvaluated) return
    if (coldStart.workspacesEmpty === null || coldStart.agentsConfigured === null) return
    coldStart.onboardingEvaluated = true
    if (coldStart.workspacesEmpty && coldStart.agentsConfigured && coldStart.isAdmin) {
      addWorkspaceOpen.value = true
    }
  }

  const findSessionRow = (sessionId: string): SessionInfo | undefined => {
    for (const list of Object.values(sessionsByWorkspace.value)) {
      const row = list.find((s) => s.sessionId === sessionId)
      if (row) return row
    }
    return undefined
  }

  function ownerKindForSessionKind(
    kind: SessionPageKind,
  ): NonNullable<SessionInfo['ownerKind']> | null {
    if (kind === 'intent' || kind === 'spec' || kind === 'spec_review') return 'intent'
    if (kind === 'discussion') return 'discussion'
    if (kind === 'automation') return 'automation'
    return null
  }

  function placeholderKindFor(
    pinnedSessionId: string,
    displayKind: SessionPageKind,
  ): SessionPageKind {
    if (activeSession.value !== pinnedSessionId) return displayKind
    const real = ctx.activeSessionRealKind.value
    return real && real !== 'consensus' && real !== 'robot' ? real : displayKind
  }

  function appendPinnedConsoleSessionIfMissing(input: {
    workspaceName: string
    sessionKind: SessionPageKind
    sessions: SessionInfo[]
  }): SessionInfo[] {
    if (
      activeTab.value !== 'console' ||
      input.workspaceName !== currentWorkspace.value ||
      input.sessionKind !== ctx.activeSessionKind.value
    ) {
      return input.sessions
    }
    const pinned = ctx.consoleSession.value
    if (!pinned || pinned.workspaceName !== input.workspaceName) return input.sessions
    if (pinned.sessionId.startsWith(PENDING_SESSION_PREFIX)) return input.sessions
    if (input.sessions.some((s) => s.sessionId === pinned.sessionId)) return input.sessions
    const existing = findSessionRow(pinned.sessionId)
    if (existing) return [...input.sessions, existing]
    const placeholderKind = placeholderKindFor(pinned.sessionId, input.sessionKind)
    return [
      ...input.sessions,
      {
        sessionId: pinned.sessionId,
        title:
          activeSession.value === pinned.sessionId && activeTitle.value
            ? activeTitle.value
            : pinned.sessionId,
        lastModified: 0,
        mode: 'default',
        isToolSession: input.sessionKind === 'tool',
        vendor:
          activeSession.value === pinned.sessionId ? (activeVendor.value ?? 'claude') : 'claude',
        state: 'stale',
        sessionKind: placeholderKind,
        ownerKind: ownerKindForSessionKind(placeholderKind),
        ownerId: null,
      },
    ]
  }

  return {
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
    pruneDashboardPending: (rows) => pruneDashboardPending(ctx, rows),
  }
}

// re-export for handlers that need resolveCurrentWorkspace in workspace domain
export { resolveCurrentWorkspace }
