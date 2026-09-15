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
import { allNpmManagedVendorsMissing, deriveVendorAvailability } from '@/lib/vendor-runtime'
import { VIEW_MODE_KEY } from '../state/types'

export function buildSettingsHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'settings'
  | 'model_provider_probe_result'
  | 'model_provider_speed_test_result'
  | 'auto_configure_agents_result'
  | 'vendor_cli_sync_result'
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
    vendorCliSyncing,
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
    speedTest,
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
      // agent 已配置、但两个 npm 托管的 CLI(claude + codex)都缺失时,落入下一跳:
      // 打开设置并定位到 Runtime Tab,把「从哪下载」指给用户。判定以服务端 runtime
      // 状态(host 探测 + managed 探测合并)为准,任一可用即不跳转。
      if (!coldStart.firstSettingsEvaluated) {
        coldStart.firstSettingsEvaluated = true
        const configured = msg.settings.agents.some((agent) => agent.id !== SHARED.SYSTEM_AGENT_ID)
        if (!configured) {
          settingsOpen.value = true
        } else if (
          allNpmManagedVendorsMissing(deriveVendorAvailability(msg.vendorRuntime, msg.hostStatus))
        ) {
          // 连 CLI 都没有时,先带用户去装 CLI;「新增工作区」引导让位,不叠加第二个模态。
          coldStart.runtimeMissing = true
          ctx.settingsTarget.value = { tab: 'runtime' }
          settingsOpen.value = true
        }
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
    model_provider_speed_test_result: (_ctx, msg) => {
      // 一次只观察一个 provider 的执行:accepted/progress/finished 更新运行态,
      // list/detail/history_providers 只更新报告面板,两组互不覆盖。
      const s = speedTest.value
      switch (msg.event) {
        case 'accepted':
        case 'progress':
          speedTest.value = { ...s, active: msg.run, error: null }
          return
        case 'active':
          // 重新进入时的复原点:没有在跑就是 null,绝不据此自动重发 start。
          // 未提交轮次(save_failed)也走这里,所以「重试保存」在重开对话框、
          // 刷新页面之后仍然找得回来。
          speedTest.value = { ...s, active: msg.run }
          return
        case 'finished':
          // 服务端只在事务提交后才发这一帧,所以「跑完了」与「存下了」是同一件事。
          speedTest.value = {
            ...s,
            active: null,
            lastResult: msg.detail,
            // 报告正开在同一个 provider 上时,让新纪录立刻可见。
            history:
              s.reportOpen && s.reportProviderId === msg.detail.run.providerId ? null : s.history,
          }
          if (s.reportOpen && s.reportProviderId === msg.detail.run.providerId) {
            ctx.speedTestAction({ action: 'list', providerId: s.reportProviderId })
          }
          return
        case 'list':
          speedTest.value = {
            ...s,
            loading: false,
            history:
              s.history && s.history.providerId === msg.page.providerId && s.history.runs.length > 0
                ? // 「加载更多」是追加而不是替换:上一页已经在屏幕上了。
                  { ...msg.page, runs: [...s.history.runs, ...msg.page.runs] }
                : msg.page,
          }
          return
        case 'detail':
          speedTest.value = { ...s, loading: false, detail: msg.detail }
          return
        case 'history_providers':
          speedTest.value = { ...s, historyProviders: msg.providers }
          return
        case 'error': {
          // save_failed 不是拒绝,而是「跑完了但没存下」:服务端仍持有这一轮,并把它的
          // 运行快照一并带回。照单收下它,对话框的「重试保存」就有了 runId;若只把它当作
          // 普通错误清掉 active,这批已经付过费的样本就再没有落库的入口。
          // 其余错误只是拒绝,既有的运行快照不动。
          const held = msg.code === 'save_failed' ? (msg.run ?? null) : s.active
          speedTest.value = { ...s, loading: false, error: msg.code, active: held }
          return
        }
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
    vendor_cli_sync_result: (_ctx, msg) => {
      // The button's in-flight flag clears no matter the outcome; the settings echo
      // that precedes this frame already refreshed the panel's row. The toast tells
      // apart "actually installed/upgraded" from "already latest" from "failed".
      vendorCliSyncing.value = vendorCliSyncing.value.filter((v) => v !== msg.vendor)
      if (msg.ok) {
        ctx.showToast(
          msg.installed
            ? t('settings.vendorCli.sync.installed')
            : t('settings.vendorCli.sync.alreadyLatest'),
        )
      } else {
        ctx.showToast(t('settings.vendorCli.sync.failed'))
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
