import type {
  ServerToClient,
  SessionInfo,
  SessionRunStatus,
  SessionStatus,
  WorkspaceDashboardRow,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX, SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { resolveCurrentWorkspace } from '@/lib/current-workspace'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  reconcileRunState,
  reconcileResearchState,
  researchMessageToChat,
  applyDispatchStatus,
  clearDispatchAgent,
} from '@/lib/discussion-view'
import { applyTaskEvent, emptyTaskModel } from '@/lib/task-list'
import { advanceOnFailure, resolveAgentIndex } from '@/lib/agent-prefix'
import { activeSessionTitleFromSessions } from '@/lib/session-title-sync'
import { mergeSessionPage, type SessionWindow } from '@/lib/session-page'
import { applyLocale, i18n } from '@/i18n'
import { normalizePersonalized, writeLocalPersonalized } from '@/lib/personalized-settings'
import { applyTheme } from '@/lib/theme'
import { applyFontScale } from '@/lib/font-scale'
import { translateUiError } from '@/i18n/errors'
import { normalizeGuidance } from '@/lib/git-failure-guidance'
import { gateEscapeFor } from '@/lib/gate-escape'
import { defaultDeliveryBranchName } from '@/lib/delivery-view'
import { transcriptToChat } from './transcript'
import type { AppCtx } from './types'
import {
  runningSessionsFingerprint,
  runningSessionsFingerprintOf,
  sessionCacheKey,
  VIEW_MODE_KEY,
  type SessionPageKind,
} from './state'
import { resolveSessionSourceAction } from '@/lib/session-jump'

/** 深链兑现超时:10 秒,足够服务端回包,但不至于在慢网下过多等待。 */
const DEEP_LINK_TIMEOUT_MS = 10_000

/**
 * 每一种 `create_intent` 拒绝码 —— 收到任一都要释放「增加意图」的在途守卫,
 * 否则入口与新增弹窗的提交按钮会一直禁用到页面状态重建。跨 `workspace.` /
 * `intent.` / `delivery.` 三个前缀,因此显式列举而非前缀判断。
 */
const CREATE_INTENT_REFUSAL_CODES = new Set<string>([
  'workspace.unknown',
  'intent.dbUnavailable',
  'intent.createFailed',
  'intent.baseBranchRequired',
  'intent.deliveryContextUnknown',
  'delivery.guard.branchNotReady',
])

/**
 * Explicit errors that mean the post-create owner-session bind will not complete
 * on this connection. Clearing the awaiting-bind flag on these restores
 * `firstIntentTurn` so the user can retry; a mid-bind `intents` snapshot that
 * merely lists the id without `intentSessionId` is NOT a clear signal.
 */
const INTENT_SESSION_BIND_FAIL_CODES = new Set<string>([
  'intent.startSessionFailed',
  'intent.worktreeCreateFailed',
  'intent.worktreeBaseMismatch',
  'intent.worktreeBaseMismatchDirty',
  'intent.worktreeDirty',
  'intent.worktreeRepairFailed',
])

// Broadcast types that can change a Dashboard count (session/intent/discussion/
// automation surfaces). While the Dashboard is the active view, each triggers one
// coalesced snapshot refresh (dedup handled in `loadDashboard`).
const DASHBOARD_REFRESH_TYPES = new Set<ServerToClient['type']>([
  'sessions',
  'session_status',
  'intents',
  'discussions',
  'automations',
])

/** Drop in-flight toggle flags for workspaces no longer present in the snapshot. */
function pruneDashboardPending(ctx: AppCtx, rows: WorkspaceDashboardRow[]): void {
  const ids = new Set(rows.map((row) => row.workspaceName))
  ctx.dashboardPending.value = new Set([...ctx.dashboardPending.value].filter((id) => ids.has(id)))
}

// Install the WebSocket message router (`handleMessage`) plus its status helpers
// onto the shared ctx. The router is the app's single inbound switch: it folds
// every `ServerToClient` event into reactive state. It reads cross-domain
// methods (restore/refresh/notify/flush) off the ctx via late binding.
export function installMessageHandler(ctx: AppCtx): void {
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
    userWorkspaceAccess,
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
    executionTranscripts,
    codesProject,
    codesDirs,
    codesLoadingDirs,
    codesTabs,
    codesSearchMode,
    codesSearchResult,
    codesSearchLoading,
    activeTab,
    workcenterEvents,
    intentActionErrorSeq,
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

  // 首屏引导的一次性守卫:只有本处理器收到的**第一条** settings 才参与判定。
  // 保存在客户端内存里,不持久化 —— 重连、切换工作空间、保存设置都不会再次弹窗,
  // 整页刷新则视为新会话重新判定一次。
  let firstSettingsEvaluated = false

  // 工作区冷启动引导的两个输入:`ready` 给出权威工作区快照与本连接的管理员身份,
  // 首条 `settings` 给出「是否已有真实 agent」。生产握手恒为 ready → settings;
  // 判定按「两个输入都已知」触发,故测试里反序注入同样成立,但绝不等 `workspaces`
  // 广播 —— 那是后续的增删播报,不是冷启动前提。
  let coldStartWorkspacesEmpty: boolean | null = null
  let coldStartIsAdmin = false
  let coldStartAgentsConfigured: boolean | null = null
  let workspaceOnboardingEvaluated = false

  // 无工作区时的冷启动引导:agent 已配置好而注册表还空着,直接打开「新增工作区」,
  // 把新用户带到唯一的创建入口。三种结果(弹出 / 已有工作区 / 无真实 agent)都消费
  // 掉这次判定:此后的设置推送、workspaces 广播、重连 ready、工作区增删都不再判定,
  // 用户关掉也不重弹;整页刷新是新的客户端会话,重新判定一次。
  function evaluateWorkspaceOnboarding(): void {
    if (workspaceOnboardingEvaluated) return
    if (coldStartWorkspacesEmpty === null || coldStartAgentsConfigured === null) return
    workspaceOnboardingEvaluated = true
    // 非管理员既没有「+」入口,服务端也会拒绝 add_workspace(AUTH-R10),因此不为其
    // 弹出一个注定被拒的弹框。
    if (coldStartWorkspacesEmpty && coldStartAgentsConfigured && coldStartIsAdmin) {
      addWorkspaceOpen.value = true
    }
  }

  // Find a loaded session-list row by id across all workspace/kind buckets. The
  // list rows carry reliable `sessionKind/ownerKind/ownerId` (unlike the
  // `session_selected` projection lookup), so the title-bar source button reads
  // owner metadata from here. `sessionId` is globally unique, so the first match
  // across buckets is correct.
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

  // The kind a synthesized placeholder row should claim. The list's display
  // category is only a fallback: it can cover more than one real kind (「规范」
  // lists spec authoring AND spec review), and a placeholder that under-reports
  // `spec_review` as `spec` would route a later click to the generic
  // `select_session` — i.e. restore a read-only review session as a writable work
  // runtime. When the pinned session IS the active one, its real kind is known.
  function placeholderKindFor(
    pinnedSessionId: string,
    displayKind: SessionPageKind,
  ): SessionPageKind {
    if (activeSession.value !== pinnedSessionId) return displayKind
    const real = ctx.activeSessionRealKind.value
    return real && real !== 'consensus' ? real : displayKind
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
    // Pending sessions already have a dedicated active row in WorkSessionList.
    // They are intentionally absent from list_sessions until their first run
    // binds a real vendor session id, so synthesizing another row here would
    // duplicate "New session" at the bottom as a stale entry.
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

  ctx.handleMessage = (msg: ServerToClient): void => {
    switch (msg.type) {
      case 'login_result':
        auth.handleLoginResult(msg.result)
        // Login minted a token but this socket is still unauthenticated — force a
        // fresh handshake so `buildUrl()` carries the `?token=` and the server
        // admits us + emits `ready` (with the workspaces snapshot).
        if (msg.result.ok) ctx.reconnect()
        break
      case 'admin_password_result':
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
        break
      case 'account_op_result':
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
        break
      case 'unauthenticated': {
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
        break
      }
      case 'ready':
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
        coldStartWorkspacesEmpty = msg.workspaces.length === 0
        coldStartIsAdmin = msg.isAdmin
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
        workspaceAccessors.value = null
        // Every per-identity roster goes on a (re)connect, because `ready` is also
        // where a login lands: keeping the previous identity's keys — let alone a
        // still-revealed plaintext — on screen would attribute one account's
        // credential to another. The plaintext is unrecoverable by design, so
        // dropping it here costs nothing that was not already promised.
        myMcpApiKeys.value = []
        myMcpApiKeyCreated.value = null
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
                if (
                  pendingDeepLink.value &&
                  !deepLinkFulfilled.value.has(pendingDeepLink.value.id)
                ) {
                  ctx.clearPendingDeepLink()
                  activeTab.value = 'console'
                  ctx.showToast(t('deepLink.notFound'))
                }
              }, DEEP_LINK_TIMEOUT_MS)
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
          currentWorkspace.value = resolveCurrentWorkspace(
            ctx.readStoredWorkspace(),
            msg.workspaces,
          )
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
          ctx.maybeRestoreCodes(msg.workspaces)
          // No persisted restorable page: enter the safe default through the
          // normal action so project selection, requests, and persistence align.
          if (
            activeTab.value === 'intents' &&
            !ctx.intentsProject.value &&
            currentWorkspace.value
          ) {
            ctx.openIntents(currentWorkspace.value)
          }
        }
        break
      case 'workspaces': {
        workspaces.value = msg.workspaces
        // If the current workspace was removed, fall back to the most-recent one.
        const resolved = resolveCurrentWorkspace(currentWorkspace.value, msg.workspaces)
        if (resolved !== currentWorkspace.value) {
          currentWorkspace.value = resolved
          ctx.persistCurrentWorkspace()
          ctx.ensureSessions(resolved)
        }
        break
      }
      case 'session_status': {
        // 运行集合真的变了(有会话开始/结束执行)才回一次权威计数,顶部三个条目角标
        // 与「会话」角标据此无刷新收敛;纯重播同一快照不触发请求。
        const changed =
          runningSessionsFingerprintOf(msg.statuses) !==
          runningSessionsFingerprint(sessionStatus.value)
        ctx.applyStatuses(msg.statuses)
        if (changed && currentWorkspace.value) {
          send({ type: 'get_session_counts', workspaceName: currentWorkspace.value })
        }
        break
      }
      case 'sessions': {
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
        break
      }
      case 'session_counts':
        // 切换 workspace 后到达的旧响应会带着上一个工作区的数字,直接丢弃 —— 角标只反映
        // 当前工作区。旧服务端不带 ownerCounts 时保留上一次快照,不从前端列表推算。
        if (msg.workspaceName !== currentWorkspace.value) break
        sessionCounts.value = { ...sessionCounts.value, ...msg.counts }
        if (msg.ownerCounts) ownerRunningCounts.value = { ...msg.ownerCounts }
        break
      case 'session_selected':
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
        if (
          pendingDeepLink.value?.kind === 'session' &&
          msg.sessionId === pendingDeepLink.value.id
        ) {
          deepLinkFulfilled.value = new Set(deepLinkFulfilled.value).add(msg.sessionId)
          ctx.clearPendingDeepLink()
        }
        break
      case 'session_started':
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
        break
      case 'session_agent_changed': {
        if (msg.sessionId !== activeSession.value) break
        if (!msg.ok) {
          // Cross-vendor rejection — vendor is frozen (AC-R17).
          ctx.showToast(t('session.titleBar.agent.changeFailed'))
          break
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
        break
      }
      case 'sync_intent_pr_status_response': {
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
        break
      }
      case 'mode_changed':
        mode.value = msg.mode
        codexPolicy.value = msg.codexPolicy ?? null
        break
      case 'commands':
        availableCommands.value = msg.commands
        break
      case 'workspace_setting':
        currentWorkspaceSetting.value = msg.config
        detectedMainBranch.value = msg.detectedMainBranch ?? null
        resolvedSpecRoot.value = msg.resolvedSpecRoot ?? null
        sysExtraMounts.value = msg.sysExtraMounts ?? []
        // The automations view keeps its own gate snapshot, bound to
        // `automationsProject`. Adopt only a reply whose workspace matches, so a
        // late reply for a previous workspace never updates the current toggle.
        // The matching echo (initial load or the save round-trip) is the source of
        // truth: it reconciles the gate value and clears any pending-save flag.
        if (msg.workspaceName === automationsProject.value) {
          automationWorkspaceSetting.value = msg.config
          automationWorkspaceSettingId.value = msg.workspaceName
          automationEnabledSaving.value = false
          automationSettingBeforeSave.value = null
        }
        break
      case 'park_recovery_stats':
        // Adopt only a reply for the workspace still on screen: a late answer for
        // one the user has left must be dropped, never shown under the new name.
        if (msg.workspaceName === currentWorkspace.value) {
          ctx.parkRecoveryLoading.value = false
          ctx.parkRecoveryStats.value = msg.stats ?? null
          ctx.parkRecoveryError.value = msg.error ?? null
        }
        break
      case 'settings':
        var firstSettingsReply = serverSettings.value === null // eslint-disable-line no-var
        serverSettings.value = msg.settings
        if (msg.settings.showSessionsPage === true) {
          if (firstSettingsReply) {
            try {
              if (localStorage.getItem(VIEW_MODE_KEY) === 'console') ctx.switchToConsoleTab()
            } catch {
              /* localStorage unavailable — retain the safe intents default */
            }
          }
        } else if (!(firstSettingsReply && pendingDeepLink.value?.kind === 'session')) {
          if (ctx.savedTab.value === 'console') ctx.savedTab.value = 'intents'
          if (activeTab.value === 'console') ctx.onSelectTab('intents')
          try {
            if (localStorage.getItem(VIEW_MODE_KEY) === 'console') {
              localStorage.setItem(VIEW_MODE_KEY, 'intents')
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
        if (!firstSettingsEvaluated) {
          firstSettingsEvaluated = true
          const configured = msg.settings.agents.some((agent) => agent.id !== SYSTEM_AGENT_ID)
          if (!configured) settingsOpen.value = true
          // agent 未配置好时不排队、不叠加「新增工作区」:本次会话只留 agent 引导一个
          // 模态,用户配好 agent 后走手动「+」或下一次整页加载的重新判定。
          coldStartAgentsConfigured = configured
          evaluateWorkspaceOnboarding()
        }
        break
      case 'auto_configure_agents_result': {
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
        break
      }
      case 'mcp_api_keys':
        // The workspace-addressed roster. Still on the wire for older clients,
        // but no first-party page administers keys by workspace any more — a key
        // belongs to its owner, so the console reads `my_mcp_api_keys` instead.
        break
      case 'my_mcp_api_keys':
        // Authoritative for THIS identity: the reply replaces the snapshot whole,
        // so a revoked key cannot linger in the list.
        myMcpApiKeys.value = msg.keys
        // `created` rides only on a successful create or reset. A plain roster
        // refresh must NOT clear an open reveal — the user may still be copying —
        // but a roster that arrives with no `created` after one did is the next
        // operation's answer, so the previous plaintext goes.
        myMcpApiKeyCreated.value = msg.created ?? null
        break
      case 'user_workspace_access':
        userWorkspaceAccess.value = { workspaces: msg.workspaces, accounts: msg.accounts }
        break
      case 'workspace_accessors':
        // Scoped to one workspace, like the key roster: a reply that raced with a
        // workspace switch must not describe the page now showing another one.
        if (msg.workspaceName !== currentWorkspace.value) break
        workspaceAccessors.value = msg.subjects
        break
      case 'personalized_settings': {
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
        break
      }
      case 'skill_link_status':
        // Only adopt statuses for the workspace currently being edited.
        if (msg.workspaceName === currentWorkspace.value) {
          skillLinkStatuses.value = msg.statuses
        }
        break
      case 'skill_install_result':
        // Clear the row's busy flag, then re-fetch link status.
        installingSkillIds.value = installingSkillIds.value.filter((id) => id !== msg.skillId)
        if (msg.workspaceName === currentWorkspace.value) ctx.querySkillLinkStatus()
        break
      case 'skill_load_approval_request':
        skillApprovalRequest.value = {
          requestId: msg.requestId,
          kind: msg.kind,
          id: msg.id,
          vendor: msg.vendor,
          repo: msg.repo,
          ref: msg.ref,
          detail: msg.detail,
        }
        break
      case 'intents': {
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
        if (
          awaitingBind &&
          msg.items.some((it) => it.id === awaitingBind && !!it.intentSessionId)
        ) {
          awaitingIntentSessionBindId.value = null
        }
        break
      }
      case 'create_intent_result':
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
        break
      case 'dev_launch_progress':
        // Advance the overlay's coarse phase; a `failed` stage closes it with an
        // error toast (the reducer + dispatch handle the side-effects).
        ctx.dispatchDevLaunch({
          kind: 'stage',
          intentId: msg.intentId,
          stage: msg.stage,
          now: Date.now(),
        })
        break
      case 'create_pr_progress':
        // Advance the create-PR overlay's stage; the reducer ignores a repeat, a
        // back-step, another intent's frame or another run's token.
        ctx.dispatchCreatePr({
          kind: 'stage',
          intentId: msg.intentId,
          stage: msg.stage,
          requestId: msg.requestId,
          now: Date.now(),
        })
        break
      case 'create_pr_response':
        // Success terminal: the PR link arrives with the intents broadcast, so the
        // overlay just closes (after its minimum dwell) — but only for the run it
        // belongs to; a reply outliving its overlay is dropped by the reducer.
        ctx.dispatchCreatePr({ kind: 'done', requestId: msg.requestId, now: Date.now() })
        break
      case 'spec_launch_progress':
        ctx.dispatchSpecLaunch({
          kind: 'stage',
          intentId: msg.intentId,
          stage: msg.stage,
          now: Date.now(),
        })
        break
      case 'intent_logs_list':
        // Cache per intent id; the changelog tab renders straight from this map.
        intentLogsById.value = { ...intentLogsById.value, [msg.intentId]: msg.items }
        intentLogsLoading.value = false
        break
      case 'intent_worktree_baseline_notice':
        // 会话已经起来了 —— 这条只是说它跑在一个落后于基准分支的目录里。存起来由
        // 意图详情常驻提示,不弹窗、不打断,修复与否是用户的事。
        ctx.noteWorktreeBaseline(msg)
        break
      case 'intent_worktree_repair_result':
        // 修完了(重建或合入),那条提示的前提已不复存在,立刻撤掉。
        ctx.clearWorktreeBaselineNotice(msg.intentId)
        ctx.showToast(
          msg.mode === 'rebuild'
            ? t('intent.worktreeBaseline.rebuilt')
            : t('intent.worktreeBaseline.merged'),
        )
        break
      case 'intent_sessions':
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
        break
      case 'workflow_status':
        automation.value = { ...automation.value, [msg.status.workspaceName]: msg.status }
        break
      case 'queue_detail':
        queueDetail.value = { ...queueDetail.value, [msg.detail.workspaceName]: msg.detail }
        break
      case 'deliveries':
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
        break
      case 'create_delivery_result': {
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
        break
      }
      case 'delivery_detail':
        activeDelivery.value = msg.delivery
        activeDeliveryId.value = msg.delivery.id
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
        break
      case 'delivery_transition_failed':
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
        break
      case 'delivery_sync_mainline_progress':
        if (msg.deliveryId === activeDeliveryId.value) {
          activeDeliverySyncPhase.value = msg.phase
        }
        break
      case 'delivery_sync_mainline_result':
        activeDeliverySyncPhase.value = null
        // `ahead: 0` is a success, not a no-op error: mainline held nothing the
        // delivery branch did not, so there was genuinely nothing to sync.
        ctx.showToast(
          msg.ahead === 0
            ? t('delivery.syncMainline.upToDate.label')
            : t('delivery.syncMainline.done.label', { count: msg.ahead }),
        )
        send({ type: 'get_delivery_detail', deliveryId: msg.deliveryId })
        break
      case 'delivery_branch_init_progress':
        // Advance the in-flight init phase. The action seeded it optimistically
        // as `fetching`; a bind / orphan-idempotent path reports a single
        // `binding`. Ignore a frame for a different delivery (superseded retry).
        if (msg.deliveryId === activeDeliveryBranchInit.value?.deliveryId) {
          activeDeliveryBranchInit.value = { deliveryId: msg.deliveryId, phase: msg.phase }
        }
        break
      case 'delivery_branch_init_result': {
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
        break
      }
      case 'discussions': {
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
        break
      }
      case 'automations':
        automations.value = { ...automations.value, [msg.workspaceName]: msg.items }
        // A automation create/update round-trip completed — release the saving overlay.
        if (automationSaving.value) automationSaving.value = false
        // After a run completes the server re-broadcasts the list; refresh the open
        // automation's execution logs so history stays current.
        if (
          activeTab.value === 'automations' &&
          automationsProject.value === msg.workspaceName &&
          selectedAutomationId.value
        ) {
          send({ type: 'get_automation_detail', automationId: selectedAutomationId.value })
        }
        break
      case 'automation_detail':
        automationLogs.value = { ...automationLogs.value, [msg.automation.id]: msg.logs }
        break
      case 'automation_tool_manifest':
        automationToolManifest.value = { ...automationToolManifest.value, [msg.vendor]: msg.tools }
        automationToolManifestLoading.value = false
        automationToolManifestError.value = null
        break
      case 'execution_transcript':
        executionTranscripts.value = {
          ...executionTranscripts.value,
          [msg.executionId]: msg.items,
        }
        break
      case 'discussion_detail': {
        activeDiscussion.value = msg.discussion
        activeDiscussionId.value = msg.discussion.id
        // Render the persisted history as read-only chat bubbles (own id space).
        const agents = serverSettings.value?.agents ?? []
        const defaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
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
        break
      }
      case 'discussion_message': {
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
          const liveDefaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
          discussionMessages.value.push({
            ...discussionMessageToChat(msg.message, liveAgents, liveDefaultAgentId, t),
            id: discussionMessages.value.length + 1,
          })
        }
        break
      }
      case 'discussion_dispatch_status': {
        // Transient in-flight/failed status of dispatched agents.
        discussionDispatch.value = {
          ...discussionDispatch.value,
          [msg.discussionId]: applyDispatchStatus(discussionDispatch.value[msg.discussionId], msg),
        }
        break
      }
      case 'discussion_run_status': {
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
        break
      }
      case 'research_message': {
        // Live append of a research turn while the read-only research agent works.
        if (
          msg.discussionId === activeDiscussionId.value &&
          msg.message.seq > researchMaxSeq.value
        ) {
          researchMaxSeq.value = msg.message.seq
          researchMessages.value.push({
            ...researchMessageToChat(msg.message, {
              researcher: t('discussion.speaker.researcher'),
            }),
            id: researchMessages.value.length + 1,
          })
        }
        break
      }
      case 'research_run_status': {
        // Track research liveness; `ended` drops the entry.
        const next = { ...researchState.value }
        if (msg.state === 'ended') delete next[msg.discussionId]
        else next[msg.discussionId] = 'running'
        researchState.value = next
        break
      }
      case 'user_text':
        add({ kind: 'user', text: msg.text })
        activity.value = { phase: 'thinking' }
        break
      case 'assistant_text':
        add({ kind: 'assistant', text: msg.text })
        activity.value = { phase: 'thinking' }
        break
      case 'notice':
        // A turn that produced no visible output (thinking-only).
        add({ kind: 'system', text: msg.text })
        break
      case 'tool_use':
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
        break
      case 'tool_result':
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
        break
      // Task-list wire path (2026-06-07-009): server-derived.
      case 'task_list':
      case 'task_created':
      case 'task_updated':
      case 'task_deleted':
        taskModel.value = applyTaskEvent(taskModel.value, msg)
        break
      case 'permission_request':
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
        break
      case 'consensus_auto':
        add({
          kind: 'consensus',
          toolName: msg.toolName,
          input: msg.input,
          outcome: msg.outcome,
        })
        activity.value = { phase: 'thinking' }
        break
      case 'turn_end':
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
        break
      case 'team_upgraded':
        // The viewed session became a persistent agent team.
        if (activeSession.value) {
          teamSessions.value = new Set(teamSessions.value).add(activeSession.value)
        }
        add({ kind: 'system', text: t('session.team.upgraded') })
        break
      case 'agent_failed':
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
        break
      case 'all_agents_failed':
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
        break
      case 'error':
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
          break
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
          break
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
          break
        }
        // A create_pr run has no error code of its own — its gates report
        // `intent.prCreate*` and `workspace.unknown` — so the failure terminal is
        // recognised by the echoed `requestId` instead. Errors from any other
        // request on this connection carry no token (or an older one) and leave
        // the overlay alone, which then converges on its safety timeout. The
        // reason is shown by the dialog / chat line below, never in the overlay.
        if (createPrProgress.value)
          ctx.dispatchCreatePr({ kind: 'failed', requestId: msg.requestId, now: Date.now() })
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
        if (createIntentPending.value && CREATE_INTENT_REFUSAL_CODES.has(msg.error.code)) {
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
          break
        }
        // Post-create owner-session bind failed: drop the in-page loading gate so
        // firstIntentTurn / start_intent_session retry is available again.
        if (INTENT_SESSION_BIND_FAIL_CODES.has(msg.error.code)) {
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
            break
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
          break
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
          break
        }
        add({ kind: 'system', text: `— ${translateUiError(msg.error)} —` })
        break
      case 'wait_user_events':
        if (msg.hasMore === undefined) {
          const nonTodo = workcenterEvents.value.filter((event) => event.status !== 'todo')
          workcenterEvents.value = [...msg.items, ...nonTodo]
        } else if (ctx.workcenterAppendNext.value) {
          const seen = new Set(workcenterEvents.value.map((event) => event.id))
          workcenterEvents.value = [
            ...workcenterEvents.value,
            ...msg.items.filter((event) => !seen.has(event.id)),
          ]
          ctx.workcenterHasMore.value = msg.hasMore
          ctx.workcenterAppendNext.value = false
          ctx.workcenterLoading.value = false
        } else {
          workcenterEvents.value = msg.items
          ctx.workcenterHasMore.value = msg.hasMore
          ctx.workcenterLoading.value = false
        }
        break
      case 'workspace_dashboard':
        ctx.dashboardLoading.value = false
        if (msg.error) {
          // Whole-snapshot failure: keep the last good rows, surface the error.
          ctx.dashboardError.value = msg.error
        } else {
          ctx.dashboardError.value = null
          ctx.dashboardRows.value = msg.rows
          pruneDashboardPending(ctx, msg.rows)
        }
        // A refresh requested while this one was in flight — run exactly one more.
        if (ctx.dashboardRefreshPending.value) {
          ctx.dashboardRefreshPending.value = false
          ctx.loadDashboard()
        }
        break
      case 'workspaces_automation_result': {
        // Clear the in-flight flag for exactly the rows this reply settled (concurrent
        // per-row toggles each get their own reply; never wipe another row's pending).
        const settled = new Set(msg.results.map((r) => r.workspaceName))
        ctx.dashboardPending.value = new Set(
          [...ctx.dashboardPending.value].filter((id) => !settled.has(id)),
        )
        if (msg.dashboardError) {
          // The post-op snapshot failed; keep settled results and re-request once.
          ctx.dashboardError.value = msg.dashboardError
          ctx.loadDashboard()
        } else {
          ctx.dashboardError.value = null
          ctx.dashboardRows.value = msg.dashboard
          pruneDashboardPending(ctx, msg.dashboard)
        }
        // A successful toggle is visible (the switch flips to the snapshot state); only
        // surface failures, where the switch reverts and the reason is otherwise silent.
        const failCount = msg.results.filter((r) => !r.ok).length
        if (failCount > 0) ctx.showToast(ctx.t('dashboard.toggleFailed', { count: failCount }))
        break
      }
      case 'dir_listed': {
        // Adopt the listing only for the workspace currently being browsed.
        if (msg.workspaceName !== codesProject.value) break
        codesDirs.value = { ...codesDirs.value, [msg.rel]: msg.entries }
        if (codesLoadingDirs.value.has(msg.rel)) {
          const next = new Set(codesLoadingDirs.value)
          next.delete(msg.rel)
          codesLoadingDirs.value = next
        }
        break
      }
      case 'code_git_status': {
        // Authoritative workspace Git-status snapshot; the action guards workspace
        // isolation and the in-flight/merge bookkeeping.
        ctx.applyCodeGitStatus(msg.workspaceName, msg.files)
        break
      }
      case 'file_read': {
        // Intent-detail `spec` tab: adopt the reply only for the rel we are
        // awaiting, so a concurrent codes read never overwrites the spec view.
        if (
          msg.workspaceName === intentsProject.value &&
          pendingSpecRel.value !== null &&
          msg.file.path === pendingSpecRel.value
        ) {
          intentSpecContent.value = msg.file.content ?? ''
          intentSpecLoading.value = false
          pendingSpecRel.value = null
        }
        // Codes page: fill the matching tab's content (opened optimistically).
        if (msg.workspaceName === codesProject.value) {
          codesTabs.value = codesTabs.value.map((tab) =>
            tab.path === msg.file.path ? { ...tab, file: msg.file, loading: false } : tab,
          )
        }
        break
      }
      case 'codes_searched': {
        if (msg.workspaceName !== codesProject.value) break
        // Ignore a stale reply if the user switched modes mid-flight.
        if (msg.mode !== codesSearchMode.value) break
        codesSearchResult.value = {
          query: msg.query,
          mode: msg.mode,
          hits: msg.hits,
          truncated: msg.truncated,
          timedOut: msg.timedOut,
        }
        codesSearchLoading.value = false
        break
      }
      case 'update_status':
        // Refreshed "is a newer c3 release available?" snapshot. Drives the header
        // upgrade hint; fail-soft on the server means this only moves toward known.
        ctx.updateStatus.value = msg.updateStatus
        break
      case 'self_update_state':
        // Download progress / staged / failed. The server is the only authority
        // here, so the snapshot is adopted wholesale.
        ctx.selfUpdate.value = msg.selfUpdate
        break
    }
    // A count-affecting broadcast while the Dashboard is active → one coalesced refresh.
    if (DASHBOARD_REFRESH_TYPES.has(msg.type)) ctx.maybeRefreshDashboard()
  }

  // Replace the status map and fire a notification when a *background* session
  // newly enters `awaiting_permission` (one you're not currently looking at).
  ctx.applyStatuses = (statuses: SessionRunStatus[]): void => {
    const prev = sessionStatus.value
    for (const s of statuses) {
      if (
        s.status === 'awaiting_permission' &&
        prev[s.sessionId] !== 'awaiting_permission' &&
        s.sessionId !== activeSession.value
      ) {
        ctx.notifyAwaitingPermission(s.sessionId)
      }
    }
    const next: Record<string, SessionStatus> = {}
    for (const s of statuses) next[s.sessionId] = s.status
    sessionStatus.value = next
    // A team session that drops to idle (or vanishes) has ended — clear its flag.
    if (teamSessions.value.size) {
      const live = new Set(
        [...teamSessions.value].filter((id) => {
          const st = next[id]
          return st === 'team' || st === 'running' || st === 'awaiting_permission'
        }),
      )
      if (live.size !== teamSessions.value.size) teamSessions.value = live
    }
    // Level-triggered flush backstop.
    ctx.flushIfReady()
  }

  // Browser notification for a background session needing approval.
  ctx.notifyAwaitingPermission = (id: string): void => {
    if (typeof Notification === 'undefined') return
    const show = (): Notification =>
      new Notification(t('permission.notification.title'), {
        body: t('permission.notification.body', { title: ctx.sessionTitleById(id) }),
      })
    if (Notification.permission === 'granted') show()
    else if (Notification.permission !== 'denied')
      Notification.requestPermission().then((p) => {
        if (p === 'granted') show()
      })
  }
}
