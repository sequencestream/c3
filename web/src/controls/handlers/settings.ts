import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import * as SHARED from './shared'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { applyLocale, i18n } from '@/i18n'
import { normalizePersonalized, writeLocalPersonalized } from '@/lib/personalized-settings'
import { applyTheme } from '@/lib/theme'
import { applyFontScale } from '@/lib/font-scale'
import { providerProbeKey } from '@/lib/model-provider'
import { VIEW_MODE_KEY } from '../state/types'

export function buildSettingsHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'settings'
  | 'model_provider_probe_result'
  | 'auto_configure_agents_result'
  | 'personalized_settings'
  | 'skill_link_status'
  | 'skill_install_result'
  | 'skill_load_approval_request'
  | 'update_status'
  | 'self_update_state'
  | 'user_workspace_access'
  | 'my_mcp_api_keys'
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
    settings: (_ctx, msg) => {
      var firstSettingsReply = serverSettings.value === null // eslint-disable-line no-var
      serverSettings.value = msg.settings
      if (msg.settings.showSessionsPage === true) {
        if (firstSettingsReply) {
          try {
            if (localStorage.getItem(SHARED.VIEW_MODE_KEY) === 'console') ctx.switchToConsoleTab()
          } catch {
            /* localStorage unavailable — retain the safe intents default */
          }
        }
      } else if (!(firstSettingsReply && pendingDeepLink.value?.kind === 'session')) {
        if (ctx.savedTab.value === 'console') ctx.savedTab.value = 'intents'
        if (activeTab.value === 'console') ctx.onSelectTab('intents')
        try {
          if (localStorage.getItem(SHARED.VIEW_MODE_KEY) === 'console') {
            localStorage.setItem(SHARED.VIEW_MODE_KEY, 'intents')
          }
        } catch {
          /* localStorage unavailable — in-memory normalization still applies */
        }
      }
      hostStatus.value = msg.hostStatus
      // 旧服务端不发此字段 ⇒ null,由 state 的 vendorAvailability 走 hostStatus 回落。
      vendorRuntime.value = msg.vendorRuntime ?? null
      sandboxStatus.value = msg.sandboxStatus ?? null
      bindingStats.value = msg.bindingStats
      sessionCapabilities.value = msg.sessionCapabilities
      vendorCapabilities.value = msg.vendorCapabilities ?? null
      vendorModes.value = msg.vendorModes ?? null
      skillSupport.value = msg.skillSupport ?? null
      // 冷启动引导:首个快照里若没有任何真实(非 system 回退)agent,直接打开
      // 系统设置 —— SettingsPanel 自身默认落在 Agent Tab,这里不引入额外的 Tab 状态。
      if (!coldStart.firstSettingsEvaluated) {
        coldStart.firstSettingsEvaluated = true
        const configured = msg.settings.agents.some((agent) => agent.id !== SHARED.SYSTEM_AGENT_ID)
        if (!configured) settingsOpen.value = true
        // agent 未配置好时不排队、不叠加「新增工作区」:本次会话只留 agent 引导一个
        // 模态,用户配好 agent 后走手动「+」或下一次整页加载的重新判定。
        coldStart.agentsConfigured = configured
        evaluateWorkspaceOnboarding()
      }
    },
    model_provider_probe_result: (_ctx, msg) => {
      // 探测是逐条协议 URL 的瞬时结论,按 provider×protocolType 覆盖写入,不累积历史。
      const key = providerProbeKey(msg.providerId ?? '', msg.protocolType)
      providerProbes.value = {
        ...providerProbes.value,
        [key]: {
          reachable: msg.reachable,
          ...(msg.status !== undefined ? { status: msg.status } : {}),
          ...(msg.issue !== undefined ? { issue: msg.issue } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...(msg.latencyMs !== undefined ? { latencyMs: msg.latencyMs } : {}),
        },
      }
    },
    auto_configure_agents_result: (_ctx, msg) => {
      // The registry itself arrives on the `settings` echo that follows; this
      // frame only explains the outcome. `created: 0` has two very different
      // causes, so it is never reported as a bare "nothing happened": no
      // runnable vendor points at the runtime diagnostics, while an already
      // covered registry says so plainly.
      if (msg.created > 0) {
        ctx.showToast(t('settings.agents.autoConfigure.result.created', { n: msg.created }))
      } else if (msg.availableVendors === 0) {
        ctx.showToast(t('settings.agents.autoConfigure.result.noVendor'))
      } else {
        ctx.showToast(t('settings.agents.autoConfigure.result.alreadyConfigured'))
      }
    },
    personalized_settings: (_ctx, msg) => {
      // The echo is authoritative for this identity: an account record beats what
      // this browser held, and a `local` scope reply is just our own value
      // normalized. Mirror it into the browser copy so the signed-out state keeps
      // the account's latest choice, then apply the language and theme live.
      const next = normalizePersonalized(msg.settings)
      personalizedSettings.value = next
      writeLocalPersonalized(next)
      if (next.uiLang && next.uiLang !== i18n.global.locale.value) applyLocale(next.uiLang)
      // Unconditional: cold start applied this browser's theme, so a login, logout
      // or reconnect must be able to correct it back to the account's value.
      applyTheme(next.theme)
      // Same reasoning for the font scale: the echo is authoritative for this
      // identity, so a reconnect corrects the cold-start browser value.
      applyFontScale(next.fontScale)
    },
    skill_link_status: (_ctx, msg) => {
      // Only adopt statuses for the workspace currently being edited.
      if (msg.workspaceName === currentWorkspace.value) {
        skillLinkStatuses.value = msg.statuses
      }
    },
    skill_install_result: (_ctx, msg) => {
      // Clear the row's busy flag, then re-fetch link status.
      installingSkillIds.value = installingSkillIds.value.filter((id) => id !== msg.skillId)
      if (msg.workspaceName === currentWorkspace.value) ctx.querySkillLinkStatus()
    },
    skill_load_approval_request: (_ctx, msg) => {
      skillApprovalRequest.value = {
        requestId: msg.requestId,
        kind: msg.kind,
        id: msg.id,
        vendor: msg.vendor,
        repo: msg.repo,
        ref: msg.ref,
        detail: msg.detail,
      }
    },
    update_status: (_ctx, msg) => {
      // Refreshed "is a newer c3 release available?" snapshot. Drives the header
      // upgrade hint; fail-soft on the server means this only moves toward known.
      ctx.updateStatus.value = msg.updateStatus
    },
    self_update_state: (_ctx, msg) => {
      // Download progress / staged / failed. The server is the only authority
      // here, so the snapshot is adopted wholesale.
      ctx.selfUpdate.value = msg.selfUpdate
    },
    user_workspace_access: (_ctx, msg) => {
      userWorkspaceAccess.value = { workspaces: msg.workspaces, accounts: msg.accounts }
    },
    my_mcp_api_keys: (_ctx, msg) => {
      // Authoritative for THIS identity: the reply replaces the snapshot whole,
      // so a revoked key cannot linger in the list.
      myMcpApiKeys.value = msg.keys
      // `created` rides only on a successful create or reset. A plain roster
      // refresh must NOT clear an open reveal — the user may still be copying —
      // but a roster that arrives with no `created` after one did is the next
      // operation's answer, so the previous plaintext goes.
      myMcpApiKeyCreated.value = msg.created ?? null
    },
  }
}
