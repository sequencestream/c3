import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'
import type { SessionInfo } from '@ccc/shared/protocol'
import * as SHARED from './shared'
import { resolveCurrentWorkspace } from '@/lib/current-workspace'
import { activeSessionTitleFromSessions } from '@/lib/session-title-sync'
import { mergeSessionPage, type SessionWindow } from '@/lib/session-page'
import { advanceOnFailure, resolveAgentIndex } from '@/lib/agent-prefix'
import { resolveSessionSourceAction } from '@/lib/session-jump'
import { applyTaskEvent, emptyTaskModel } from '@/lib/task-list'
import {
  runningSessionsFingerprint,
  runningSessionsFingerprintOf,
  sessionCacheKey,
  type SessionPageKind,
} from '../state/types'
import { transcriptToChat } from '../transcript'

export function buildSessionHandlers(
  ctx: AppCtx,
  locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'ready'
  | 'session_status'
  | 'sessions'
  | 'session_counts'
  | 'session_selected'
  | 'session_started'
  | 'session_agent_changed'
  | 'mode_changed'
  | 'commands'
  | 'user_text'
  | 'assistant_text'
  | 'notice'
  | 'tool_use'
  | 'tool_result'
  | 'task_list'
  | 'task_created'
  | 'task_updated'
  | 'task_deleted'
  | 'permission_request'
  | 'consensus_auto'
  | 'turn_end'
  | 'team_upgraded'
  | 'agent_failed'
  | 'all_agents_failed'
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
    ready: (_ctx, msg) => {
      // Refresh admin authorization for this connection (ADR-0023 authz) — drives
      // the console disabling system-config controls for non-admins.
      auth.setIsAdmin(msg.isAdmin)
      // The signed-in subject for the top-bar account menu (null = no one signed in).
      auth.setSubject(msg.subject)
      // Resolve the display language for THIS identity. A login reconnects, so this
      // is also where an account adopts its stored language — and where an account
      // without a record yet gets seeded from this browser's value.
      ctx.fetchPersonalizedSettings()
      // Seed the header upgrade hint from the handshake snapshot (refreshed later
      // by `update_status`).
      ctx.updateStatus.value = msg.updateStatus
      // Seed the self-update pipeline too, so a download already running — or a
      // package waiting for a restart — is visible the moment the console loads.
      ctx.selfUpdate.value = msg.selfUpdate
      workspaces.value = msg.workspaces
      // 冷启动引导的工作区侧输入:权威快照是否为空 + 本连接是否管理员。
      coldStart.workspacesEmpty = msg.workspaces.length === 0
      coldStart.isAdmin = msg.isAdmin
      evaluateWorkspaceOnboarding()
      // Close workspace setting on reconnect — workspace may have changed.
      workspaceSettingOpen.value = false
      currentWorkspaceSetting.value = null
      detectedMainBranch.value = null
      resolvedSpecRoot.value = null
      sysExtraMounts.value = []
      ctx.parkRecoveryStats.value = null
      ctx.parkRecoveryError.value = null
      ctx.parkRecoveryLoading.value = false
      ctx.workspaceMemories.value = null
      ctx.workspaceMemoriesError.value = null
      ctx.workspaceMemoriesLoading.value = false
      ctx.deletingMemoryIds.value = []
      workspaceAccessors.value = null
      // Every per-identity roster goes on a (re)connect, because `ready` is also
      // where a login lands: keeping the previous identity's keys — let alone a
      // still-revealed plaintext — on screen would attribute one account's
      // credential to another. The plaintext is unrecoverable by design, so
      // dropping it here costs nothing that was not already promised.
      myMcpApiKeys.value = []
      myMcpApiKeyCreated.value = null
      myImIdentity.value = null
      imIdentityChallengeCreated.value = null
      imIdentityBindings.value = []
      imGroupWorkspaceScopes.value = []
      imGroupScopeChatId.value = ''
      userWorkspaceAccess.value = null
      ctx.applyStatuses(msg.statuses)

      // ---- Deep-link consumption (takes priority over localStorage restore) ----
      // Consumed = workspace validated + dispatched by kind; fulfillment is
      // monitored asynchronously via server replies + a bounded timeout.
      // When consumed, the maybeRestore* block below is skipped.
      var deepLinkConsumed = false // eslint-disable-line no-var
      {
        const dl = pendingDeepLink.value
        if (dl) {
          const wsExists = msg.workspaces.some((w) => w.name === dl.workspaceName)
          if (wsExists) {
            deepLinkConsumed = true
            // Align the global workspace to the deep link's workspace.
            currentWorkspace.value = dl.workspaceName
            ctx.persistCurrentWorkspace()
            ctx.ensureSessions(currentWorkspace.value)

            // Dispatch by kind — each path marks fulfillment on the matching reply.
            if (dl.kind === 'session') {
              ctx.selectSession(dl.workspaceName, dl.id)
            } else if (dl.kind === 'intent') {
              ctx.openIntents(dl.workspaceName)
              ctx.requestedIntentId.value = dl.id
            } else if (dl.kind === 'discussion') {
              ctx.openDiscussions(dl.workspaceName)
              ctx.openDiscussion(dl.id)
            }

            // Start the fulfillment timeout. Cleared when the matching server
            // reply (session_selected / discussion_detail / requested-intent-consumed)
            // arrives or when the link is cleared by another path.
            deepLinkTimers.timeout = setTimeout(() => {
              if (pendingDeepLink.value && !deepLinkFulfilled.value.has(pendingDeepLink.value.id)) {
                ctx.clearPendingDeepLink()
                activeTab.value = 'console'
                ctx.showToast(t('deepLink.notFound'))
              }
            }, SHARED.DEEP_LINK_TIMEOUT_MS)
          } else {
            // Workspace not in this instance → unreachable.
            ctx.clearPendingDeepLink()
            ctx.showToast(t('deepLink.notFound'))
          }
        }
      }

      if (!deepLinkConsumed) {
        // Normal: restore the persisted current workspace (or fall back to most-recent),
        // then load its sessions for the sidebar.
        currentWorkspace.value = resolveCurrentWorkspace(ctx.readStoredWorkspace(), msg.workspaces)
        ctx.persistCurrentWorkspace()
        ctx.ensureSessions(currentWorkspace.value)
      }

      // Pull settings up front so the new-session agent picker has the agent list +
      // per-vendor host-CLI status ready before the user clicks "+".
      send({ type: 'get_settings' })

      if (!deepLinkConsumed) {
        // Restore the intent / discussion / automations view if a hard refresh left us in it.
        ctx.maybeRestoreIntents(msg.workspaces)
        ctx.maybeRestoreDiscussions(msg.workspaces)
        ctx.maybeRestoreAutomations(msg.workspaces)
        ctx.maybeRestoreFiles(msg.workspaces)
        // No persisted restorable page: enter the safe default through the
        // normal action so project selection, requests, and persistence align.
        if (activeTab.value === 'intents' && !ctx.intentsProject.value && currentWorkspace.value) {
          ctx.openIntents(currentWorkspace.value)
        }
      }
    },
    session_status: (_ctx, msg) => {
      // 运行集合真的变了(有会话开始/结束执行)才回一次权威计数,顶部三个条目角标
      // 与「会话」角标据此无刷新收敛;纯重播同一快照不触发请求。
      const changed =
        runningSessionsFingerprintOf(msg.statuses) !==
        runningSessionsFingerprint(sessionStatus.value)
      ctx.applyStatuses(msg.statuses)
      if (changed && currentWorkspace.value) {
        send({ type: 'get_session_counts', workspaceName: currentWorkspace.value })
      }
    },
    sessions: (_ctx, msg) => {
      const path = msg.workspaceName
      const sessionKind = (msg.sessionKind ?? 'work') as SessionPageKind
      const cacheKey = sessionCacheKey(path, sessionKind)
      const kind = msg.page?.kind ?? 'first'
      const hasMore = msg.page?.hasMore ?? false
      const prevPaging = sessionPagingByWorkspace.value[cacheKey]
      const prevList = sessionsByWorkspace.value[cacheKey]
      const prevWindow: SessionWindow | undefined = prevList
        ? {
            sessions: prevList,
            hasMore: prevPaging?.hasMore ?? false,
            exhausted: prevPaging?.exhausted ?? false,
          }
        : undefined
      // For a `window` refresh, the boundary to keep loaded-more rows below is
      // the `since` we recorded when sending it (SR-R14).
      const since = kind === 'window' ? prevPaging?.pendingSince : undefined
      const merged = mergeSessionPage(prevWindow, msg.sessions, { kind, hasMore, since })
      // `merged` is undefined only for a `live` push into a not-yet-loaded
      // workspace — ignore it (the list loads on demand).
      if (merged) {
        const sessions = appendPinnedConsoleSessionIfMissing({
          workspaceName: path,
          sessionKind,
          sessions: merged.sessions,
        })
        sessionsByWorkspace.value = { ...sessionsByWorkspace.value, [cacheKey]: sessions }
        sessionPagingByWorkspace.value = {
          ...sessionPagingByWorkspace.value,
          [cacheKey]: {
            hasMore: merged.hasMore,
            exhausted: merged.exhausted,
            loadingMore: false,
            pendingSince: undefined,
          },
        }
        activeTitle.value =
          activeSessionTitleFromSessions({
            activeWorkspace: activeWorkspace.value,
            activeSession: activeSession.value,
            workspaceName: path,
            sessions: merged.sessions,
          }) ?? activeTitle.value
      }
      // A workspace switch or session-kind switch cleared the chat column and
      // flagged a pending re-bind. Bind the first session once the matching
      // workspace + kind list response lands — but not on a `live` fan-out push
      // (it may precede the full first page).
      if (
        kind !== 'live' &&
        ctx.flags.pendingConsoleBind &&
        path === currentWorkspace.value &&
        sessionKind === ctx.activeSessionKind.value
      ) {
        ctx.flags.pendingConsoleBind = false
        // Suppress auto-bind when a post-Start-Dev pending jump is staged:
        // the jump's consumePendingWorkSessionSelect will select the right
        // session once its row lands. Without this gate, the kind-switch
        // would grab the first historical work session instead of waiting.
        if (activeTab.value === 'console' && ctx.requestedWorkSessionId.value === null) {
          ctx.bindConsoleSession()
        }
      }
      // The post-Start-Dev jump may be waiting for its target session to land.
      ctx.consumePendingWorkSessionSelect()
    },
    session_counts: (_ctx, msg) => {
      // 切换 workspace 后到达的旧响应会带着上一个工作区的数字,直接丢弃 —— 角标只反映
      // 当前工作区。旧服务端不带 ownerCounts 时保留上一次快照,不从前端列表推算。
      if (msg.workspaceName !== currentWorkspace.value) return
      sessionCounts.value = { ...sessionCounts.value, ...msg.counts }
      if (msg.ownerCounts) ownerRunningCounts.value = { ...msg.ownerCounts }
    },
    session_selected: (_ctx, msg) => {
      if (specLaunch.value) {
        ctx.dispatchSpecLaunch({
          kind: 'ready',
          intentId: specLaunch.value.intentId,
          now: Date.now(),
        })
      }
      activeWorkspace.value = msg.workspaceName
      activeSession.value = msg.sessionId
      activeTitle.value = msg.title
      // The resolved agent vendor for the title dot (absent on comm sessions).
      activeVendor.value = msg.vendor ?? null
      // The same-vendor agent switcher data (absent ⇒ no switcher).
      activeAgentSwitch.value = msg.agentSwitch ?? null
      // The title-bar source action for this session (jump target + label).
      // `session_selected`'s projection lookup is unreliable for spec/intent
      // sessions (its c3-id probe can miss, dropping sessionKind/ownerKind/
      // ownerId), whereas the list row the user clicked always carries them — so
      // prefer the row's owner metadata, falling back to the message, plus the
      // work-session `linkedIntentId` compat field. Refreshed/cleared on every
      // (re)select so a plain session never inherits the previous source.
      {
        const row = findSessionRow(msg.sessionId)
        const realKind = row?.sessionKind ?? msg.sessionKind ?? null
        activeSessionSource.value = resolveSessionSourceAction({
          sessionKind: realKind,
          ownerKind: row?.ownerKind ?? msg.ownerKind,
          ownerId: row?.ownerId ?? msg.ownerId,
          linkedIntentId: msg.linkedIntentId,
        })
        // The session's own kind — NOT the list's display category (「规范」covers
        // both spec and spec_review). The read-only chat column keys on this, so a
        // spec authoring session stays writable while a review session next to it
        // in the same list does not.
        ctx.activeSessionRealKind.value = realKind
      }
      mode.value = msg.mode
      codexPolicy.value = msg.codexPolicy ?? null
      // Remember this as the console tab's own session ONLY when the selection
      // originated on the console tab.
      if (activeTab.value === 'console') {
        ctx.consoleSession.value = { workspaceName: msg.workspaceName, sessionId: msg.sessionId }
      }
      messages.value = []
      counters.nextId = 1
      // Commands are per-cwd; drop the old set so the next `/` refetches.
      availableCommands.value = []
      // Seed this session's live status from the authoritative snapshot.
      sessionStatus.value = { ...sessionStatus.value, [msg.sessionId]: msg.status }
      activity.value = { phase: 'idle' }
      // Clear any stale danger flag on (re)select.
      clearSideEffectPending(msg.sessionId)
      // Resolve the agent prefix from the session's bound agent.
      currentAgentIndexBySession.value = {
        ...currentAgentIndexBySession.value,
        [msg.sessionId]: resolveAgentIndex(
          serverSettings.value,
          msg.agentSwitch?.current.id,
          msg.agentSwitch?.current.id,
        ),
      }
      // Reset the task panel on every (re)select; the server re-sends the derived
      // `task_list` right after this message.
      taskModel.value = emptyTaskModel()
      selectedIntentSessionId.value = null
      for (const item of msg.history) {
        add(transcriptToChat(item))
      }
      // When on the intents tab, keep the middle-column selection in sync.
      if (activeTab.value === 'intents') {
        selectedIntentSessionId.value = msg.sessionId
      }
      // Check for deep-link fulfillment: the target session landed.
      if (pendingDeepLink.value?.kind === 'session' && msg.sessionId === pendingDeepLink.value.id) {
        deepLinkFulfilled.value = new Set(deepLinkFulfilled.value).add(msg.sessionId)
        ctx.clearPendingDeepLink()
      }
    },
    session_started: (_ctx, msg) => {
      if (activeSession.value === msg.clientId) {
        activeAgentSwitch.value = msg.agentSwitch ?? null
        activeSession.value = msg.sessionId
        // Complete the pending -> real re-key for the console pointer too.
        // Any synthetic/cached pending row is obsolete once the server binds
        // the real id and must not survive later pagination merges.
        const pinned = ctx.consoleSession.value
        if (pinned?.sessionId === msg.clientId) {
          ctx.consoleSession.value = { ...pinned, sessionId: msg.sessionId }
        }
        const cleaned: Record<string, SessionInfo[]> = {}
        for (const [key, sessions] of Object.entries(sessionsByWorkspace.value)) {
          cleaned[key] = sessions.filter((session) => session.sessionId !== msg.clientId)
        }
        sessionsByWorkspace.value = cleaned
        // Carry the agent degradation index from the pending clientId to the real
        // sessionId.
        const prevIdx = currentAgentIndexBySession.value[msg.clientId] ?? 0
        const resolved = resolveAgentIndex(
          serverSettings.value,
          msg.agentSwitch?.current.id,
          msg.agentSwitch?.current.id,
        )
        currentAgentIndexBySession.value = {
          ...currentAgentIndexBySession.value,
          [msg.sessionId]: Math.max(prevIdx, resolved),
        }
        delete currentAgentIndexBySession.value[msg.clientId]
        send({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId })
      }
    },
    session_agent_changed: (_ctx, msg) => {
      if (msg.sessionId !== activeSession.value) return
      if (!msg.ok) {
        // Cross-vendor rejection — vendor is frozen (AC-R17).
        ctx.showToast(t('session.titleBar.agent.changeFailed'))
        return
      }
      // Re-target succeeded: rebuild the switcher locally.
      const s = activeAgentSwitch.value
      if (s) {
        const all = [s.current, ...s.candidates]
        const picked = all.find((c) => c.id === msg.agentId)
        if (picked) {
          activeAgentSwitch.value = {
            current: picked,
            candidates: all.filter((c) => c.id !== msg.agentId),
            currentUnavailable: false,
          }
          currentAgentIndexBySession.value = {
            ...currentAgentIndexBySession.value,
            [msg.sessionId]: resolveAgentIndex(serverSettings.value, msg.agentId, msg.agentId),
          }
        }
      }
    },
    mode_changed: (_ctx, msg) => {
      mode.value = msg.mode
      codexPolicy.value = msg.codexPolicy ?? null
    },
    commands: (_ctx, msg) => {
      availableCommands.value = msg.commands
    },
    user_text: (_ctx, msg) => {
      add({ kind: 'user', text: msg.text })
      activity.value = { phase: 'thinking' }
    },
    assistant_text: (_ctx, msg) => {
      add({ kind: 'assistant', text: msg.text })
      activity.value = { phase: 'thinking' }
    },
    notice: (_ctx, msg) => {
      // A turn that produced no visible output (thinking-only).
      add({ kind: 'system', text: msg.text })
    },
    tool_use: (_ctx, msg) => {
      add({
        kind: 'tool-use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        input: msg.input,
        // Audit hint from the driver path: vendor rule engine auto-allowed this tool.
        ...(msg.preApproved ? { preApproved: true } : {}),
        // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      activity.value = { phase: 'tool', toolName: msg.toolName }
    },
    tool_result: (_ctx, msg) => {
      add({
        kind: 'tool-result',
        toolUseId: msg.toolUseId,
        content: msg.content,
        isError: msg.isError,
        // Carry the user-interaction flag from the matched tool-use
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      // Tool returned — the model is now deciding the next step.
      activity.value = { phase: 'thinking' }
    },
    task_list: (_ctx, msg) => {
      taskModel.value = applyTaskEvent(taskModel.value, msg)
    },
    task_created: (_ctx, msg) => {
      taskModel.value = applyTaskEvent(taskModel.value, msg)
    },
    task_updated: (_ctx, msg) => {
      taskModel.value = applyTaskEvent(taskModel.value, msg)
    },
    task_deleted: (_ctx, msg) => {
      taskModel.value = applyTaskEvent(taskModel.value, msg)
    },
    permission_request: (_ctx, msg) => {
      add({
        kind: 'permission',
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        decision: null,
        consensus: msg.consensus,
        // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      activity.value = { phase: 'awaiting' }
    },
    consensus_auto: (_ctx, msg) => {
      add({
        kind: 'consensus',
        toolName: msg.toolName,
        input: msg.input,
        outcome: msg.outcome,
      })
      activity.value = { phase: 'thinking' }
    },
    turn_end: (_ctx, msg) => {
      // A turn finished — the session stays active for the next prompt.
      if (msg.reason === 'error') {
        add({
          kind: 'system',
          text: t('session.turn.error', { error: msg.error ?? t('common.unknown.label') }),
        })
        activity.value = { phase: 'error', message: msg.error ?? 'unknown' }
        // Danger state (AS-R19): the side-effect gate refused auto-resume.
        if (msg.side_effect_pending && activeSession.value) {
          sideEffectPendingBySession.value = {
            ...sideEffectPendingBySession.value,
            [activeSession.value]: true,
          }
        }
      } else {
        activity.value = { phase: 'idle' }
      }
    },
    team_upgraded: (_ctx, msg) => {
      // The viewed session became a persistent agent team.
      if (activeSession.value) {
        teamSessions.value = new Set(teamSessions.value).add(activeSession.value)
      }
      add({ kind: 'system', text: t('session.team.upgraded') })
    },
    agent_failed: (_ctx, msg) => {
      // The current agent hit a rate-limit/auth/connection error.
      add({
        kind: 'system',
        text: t('session.agent.failed', { agentName: msg.agentName, error: msg.error }),
      })
      // The failed agent is handing off to the next in the chain.
      if (activeSession.value) {
        const sid = activeSession.value
        currentAgentIndexBySession.value = {
          ...currentAgentIndexBySession.value,
          [sid]: advanceOnFailure(
            serverSettings.value,
            activeAgentSwitch.value?.current.id,
            currentAgentIndexBySession.value[sid] ?? 0,
            msg.agentId,
          ),
        }
      }
    },
    all_agents_failed: (_ctx, msg) => {
      // Every agent in the degradation chain failed. The turn ends with error.
      add({ kind: 'system', text: `— ${msg.message} —` })
      // Honestly note any cross-vendor fallback that was skipped.
      if (msg.crossVendorSkipped && msg.crossVendorSkipped.length > 0) {
        add({
          kind: 'system',
          text: t('session.agent.crossVendorSkipped', {
            count: msg.crossVendorSkipped.length,
            agents: msg.crossVendorSkipped.map((a) => a.agentName).join(', '),
          }),
        })
      }
    },
  }
}
