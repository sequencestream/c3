import { consoleEntryTarget, consoleTabEntryEffects, workspaceSwitchEffects } from '@/lib/tab-view'
import { emptyTaskModel } from '@/lib/task-list'
import { SESSION_PAGE_SIZE } from '@/lib/session-page'
import { resolveSessionJumpTarget, type SessionJumpTarget } from '@/lib/session-jump'
import type { SessionInfo, SessionKind } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { emptyDirectoryPicker, sessionCacheKey, type SessionPageKind } from './state'
import { watch } from 'vue'

/** 目录选择请求 id 的单调后缀,保证同一毫秒内的两次点击也不撞号。 */
let workspaceDirectorySeq = 0

// Install workspace / session / top-bar-tab navigation actions onto the ctx.
export function installSessionActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    currentWorkspace,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    activeSessionKind,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    newSessionWorkspace,
    newSessionOpen,
    activeTab,
    consoleSession,
    currentSessions,
    activeSession,
    activeWorkspace,
    activeTitle,
    activeVendor,
    activeAgentSwitch,
    activeSessionSource,
    messages,
    counters,
    availableCommands,
    activity,
    taskModel,
    selectedIntentSessionId,
    intentsProject,
  } = ctx

  // Merge-patch a workspace's pagination state (SR-R14).
  const patchPaging = (
    key: string,
    patch: Partial<{
      hasMore: boolean
      exhausted: boolean
      loadingMore: boolean
      pendingSince: number | undefined
    }>,
  ): void => {
    const cur = sessionPagingByWorkspace.value[key] ?? {
      hasMore: false,
      exhausted: false,
      loadingMore: false,
    }
    sessionPagingByWorkspace.value = {
      ...sessionPagingByWorkspace.value,
      [key]: { ...cur, ...patch },
    }
  }

  function activeKey(path: string): string {
    return sessionCacheKey(path, activeSessionKind.value)
  }

  function keyFor(path: string, kind: SessionPageKind): string {
    return sessionCacheKey(path, kind)
  }

  function sessionPageKindFromSource(kind: string | null | undefined): SessionPageKind {
    if (
      kind === 'work' ||
      kind === 'intent' ||
      kind === 'spec' ||
      kind === 'spec_review' ||
      kind === 'discussion' ||
      kind === 'automation' ||
      kind === 'tool'
    ) {
      return kind
    }
    if (kind === 'consensus') return 'tool'
    return 'work'
  }

  function ownerKindForSessionKind(
    kind: SessionPageKind,
  ): NonNullable<SessionInfo['ownerKind']> | null {
    if (kind === 'intent' || kind === 'spec' || kind === 'spec_review') return 'intent'
    if (kind === 'discussion') return 'discussion'
    if (kind === 'automation') return 'automation'
    return null
  }

  function appendWorkcenterSessionIfMissing(input: {
    workspaceName: string
    sessionKind: SessionPageKind
    sourceKind: string | null | undefined
    sessionId: string
    title?: string | null
    updatedAt?: number | null
  }): void {
    const key = keyFor(input.workspaceName, input.sessionKind)
    const list = sessionsByWorkspace.value[key] ?? []
    if (list.some((s) => s.sessionId === input.sessionId)) return
    const placeholder: SessionInfo = {
      sessionId: input.sessionId,
      title: input.title?.trim() || input.sessionId,
      lastModified: input.updatedAt ?? 0,
      mode: 'default',
      isToolSession: input.sessionKind === 'tool',
      vendor: 'claude',
      state: 'stale',
      sessionKind:
        input.sourceKind === 'consensus'
          ? ('tool' satisfies SessionKind)
          : (input.sessionKind satisfies SessionKind),
      ownerKind: ownerKindForSessionKind(input.sessionKind),
      ownerId: null,
    }
    sessionsByWorkspace.value = { ...sessionsByWorkspace.value, [key]: [...list, placeholder] }
  }

  function requestFirstSessionPage(path: string, kind: SessionPageKind): void {
    send({
      type: 'list_sessions',
      workspaceName: path,
      sessionKind: kind,
      limit: SESSION_PAGE_SIZE,
    })
    send({ type: 'get_session_counts', workspaceName: path })
  }

  // Refresh a workspace's session list (SR-R14): when a window is already
  // loaded, ask only for the displayed range (`since` = oldest loaded), so the
  // reply updates what's shown without re-pulling earlier, unloaded sessions;
  // otherwise pull the first (newest) page.
  ctx.refreshSessions = (path: string | null): void => {
    if (!path) return
    const key = activeKey(path)
    const list = sessionsByWorkspace.value[key]
    if (list && list.length) {
      const since = list[list.length - 1].lastModified
      patchPaging(key, { pendingSince: since })
      send({
        type: 'list_sessions',
        workspaceName: path,
        sessionKind: activeSessionKind.value,
        since,
      })
    } else {
      send({
        type: 'list_sessions',
        workspaceName: path,
        sessionKind: activeSessionKind.value,
        limit: SESSION_PAGE_SIZE,
      })
    }
    send({ type: 'get_session_counts', workspaceName: path })
  }

  // Lazily fetch a workspace's first session page (once) for the sidebar.
  ctx.ensureSessions = (path: string | null): void => {
    if (path && !sessionsByWorkspace.value[activeKey(path)]) {
      send({
        type: 'list_sessions',
        workspaceName: path,
        sessionKind: activeSessionKind.value,
        limit: SESSION_PAGE_SIZE,
      })
      send({ type: 'get_session_counts', workspaceName: path })
    }
  }

  ctx.selectSessionKind = (kind: SessionPageKind): void => {
    activeSessionKind.value = kind
    // Drop the remembered session — it belonged to the previous kind. The new
    // kind's first session is bound once its `list_sessions` reply lands.
    consoleSession.value = null
    ctx.clearViewedSession()
    // Flag a pending bind so that when the new kind's list reply lands, the first
    // visible session is automatically selected (keeps the right column in sync).
    ctx.flags.pendingConsoleBind = true
    ctx.refreshSessions(currentWorkspace.value)
  }

  // "Load more": fetch the next page strictly older than the oldest loaded
  // session, keyed on `(lastModified, sessionId)` so same-timestamp rows are
  // never skipped or duplicated (SR-R14).
  ctx.loadMoreSessions = (path: string | null): void => {
    if (!path) return
    const key = activeKey(path)
    const list = sessionsByWorkspace.value[key]
    const paging = sessionPagingByWorkspace.value[key]
    if (!list || !list.length || !paging?.hasMore || paging.loadingMore) return
    const oldest = list[list.length - 1]
    patchPaging(key, { loadingMore: true })
    send({
      type: 'list_sessions',
      workspaceName: path,
      sessionKind: activeSessionKind.value,
      before: { lastModified: oldest.lastModified, sessionId: oldest.sessionId },
      limit: SESSION_PAGE_SIZE,
    })
  }

  // Switch the global current workspace. The view always lands on the intents tab.
  ctx.selectWorkspace = (path: string): void => {
    const fx = workspaceSwitchEffects(path, currentWorkspace.value)
    if (fx.noop) return
    currentWorkspace.value = path
    ctx.persistCurrentWorkspace()
    workspaceSettingOpen.value = false
    currentWorkspaceSetting.value = null
    detectedMainBranch.value = null
    resolvedSpecRoot.value = null
    sysExtraMounts.value = []
    // The observation counts belong to the workspace we just left; drop them so a
    // reopen cannot show one workspace's numbers under another's name.
    ctx.parkRecoveryStats.value = null
    ctx.parkRecoveryError.value = null
    ctx.parkRecoveryLoading.value = false
    // The console tab's remembered session belonged to the previous workspace —
    // drop it and clear the chat column so it can't keep showing stale content.
    // The chat column stays empty while the view sits on the intents tab; the
    // console binds its session when the user enters that tab (the `sessions`
    // handler only consumes `pendingConsoleBind` there).
    consoleSession.value = null
    ctx.clearViewedSession()
    ctx.flags.pendingConsoleBind = true
    // Land on the intents tab through the standard intents entry, so the tab
    // flip and the target workspace's intent data arrive together.
    if (fx.enterIntents) ctx.openIntents(path)
    if (fx.refreshSessions) ctx.refreshSessions(path)
  }

  ctx.addWorkspace = (payload: { workspaceName: string; path: string }): void => {
    send({ type: 'add_workspace', ...payload })
  }

  // 让服务端在自己所在主机弹一次原生目录对话框。每次点击都换新的 requestId:
  // 旧请求就此失效,迟到的回复由 message-handler 按 requestId 丢弃;服务端那边
  // 也会中止上一次仍开着的对话框,所以重复点击不会被「上一个还开着」卡住。
  ctx.selectWorkspaceDirectory = (): void => {
    const requestId = `ws-dir-${Date.now()}-${++workspaceDirectorySeq}`
    // 保留上次选中的路径:重新选择期间弹框里的内容不该被清空。
    ctx.workspaceDirectoryPicker.value = {
      requestId,
      pending: true,
      error: null,
      selection: ctx.workspaceDirectoryPicker.value.selection,
    }
    send({ type: 'select_workspace_directory', requestId })
  }

  // 弹框开合都把这次选择归零。关闭时若还有未决请求,告知服务端可以中止那个原生
  // 对话框并释放槽位 —— 否则用户在主机上不理它,下次打开就得等一个没人要的结果。
  watch(ctx.addWorkspaceOpen, () => {
    const { requestId } = ctx.workspaceDirectoryPicker.value
    if (requestId) send({ type: 'cancel_workspace_directory_selection', requestId })
    ctx.workspaceDirectoryPicker.value = emptyDirectoryPicker()
  })

  ctx.removeWorkspace = (workspaceName: string): void => {
    send({ type: 'remove_workspace', workspaceName })
  }

  // The "+" opens the agent picker instead of creating immediately.
  ctx.openNewSession = (path: string): void => {
    newSessionWorkspace.value = path
    newSessionOpen.value = true
    send({ type: 'get_settings' })
  }

  // Confirm the picker: create the session, optionally carrying the chosen agent.
  ctx.confirmNewSession = (agentId: string | null): void => {
    const path = newSessionWorkspace.value
    newSessionOpen.value = false
    if (!path) return
    ctx.enterConsole()
    send({
      type: 'create_session',
      workspaceName: path,
      ...(agentId ? { agentId } : {}),
    })
  }

  // The picker's "binary not in PATH → go to detection" link.
  ctx.openSettingsFromPicker = (): void => {
    newSessionOpen.value = false
    ctx.openSettings()
  }

  // Find a loaded session-list row by id across all workspace/kind buckets. Rows
  // carry the trustworthy `sessionKind/ownerKind/ownerId` projection fields; ids
  // are globally unique, so the first match is the right one.
  function findLoadedSessionRow(sessionId: string): SessionInfo | undefined {
    for (const list of Object.values(sessionsByWorkspace.value)) {
      const row = list.find((s) => s.sessionId === sessionId)
      if (row) return row
    }
    return undefined
  }

  // A list row click means "view this session" — no business-page jump branches.
  // Every non-orphaned row enters the console tab and binds the chat column; the
  // source jump now lives on the title-bar button (see `jumpActiveSessionSource`).
  //
  // One exception, and it is a security boundary, not a convenience: a
  // `spec_review` row must NOT go through the generic `select_session`, whose cold
  // restore would rebuild it as a writable `work` runtime. It is routed to
  // `open_spec_review_session` with the row's owning intent, and the server
  // re-validates that intent's current review session. `row` is the clicked
  // projection row when the caller has one (the list); otherwise it is looked up
  // among the loaded rows, so id-only entries (deep link, post-Start-Work select)
  // get the same routing. Fail closed: an unattributable review row is refused with
  // a toast and no fallback — the active session simply stays where it was.
  ctx.selectSession = (path: string, sessionId: string, row?: SessionInfo): void => {
    const projection = row ?? findLoadedSessionRow(sessionId)
    if (projection?.sessionKind === 'spec_review') {
      if (projection.ownerKind !== 'intent' || !projection.ownerId) {
        ctx.showToast(ctx.t('session.review.ownerUnresolved'))
        return
      }
      ctx.requestedWorkSessionId.value = null
      ctx.enterConsole()
      consoleSession.value = { workspaceName: path, sessionId }
      if (sessionId === activeSession.value) return
      ctx.openSpecReviewSession(projection.ownerId, path)
      return
    }
    ctx.requestedWorkSessionId.value = null
    ctx.enterConsole()
    // Pin the console tab's pointer up front.
    consoleSession.value = { workspaceName: path, sessionId }
    if (sessionId === activeSession.value) return
    send({ type: 'select_session', workspaceName: path, sessionId })
  }

  ctx.openWorkcenterSession = (input): void => {
    const path = input.workspaceName
    const kind = sessionPageKindFromSource(input.sessionKind)
    currentWorkspace.value = path
    ctx.persistCurrentWorkspace()
    activeSessionKind.value = kind
    ctx.flags.pendingConsoleBind = false
    ctx.enterConsole()
    requestFirstSessionPage(path, kind)
    if (!input.sessionId) {
      consoleSession.value = null
      ctx.clearViewedSession()
      return
    }
    appendWorkcenterSessionIfMissing({
      workspaceName: path,
      sessionKind: kind,
      sourceKind: input.sessionKind,
      sessionId: input.sessionId,
      title: input.title,
      updatedAt: input.updatedAt,
    })
    consoleSession.value = { workspaceName: path, sessionId: input.sessionId }
    if (input.sessionId === activeSession.value && path === activeWorkspace.value) return
    send({ type: 'select_session', workspaceName: path, sessionId: input.sessionId })
  }

  // Open the page the given jump target points at (intent detail / intent
  // sessions / discussion / automation). The one place title-bar and (legacy) row
  // source jumps both route through; jump semantics come only from
  // `resolveSessionJumpTarget` upstream.
  function openSourceTarget(path: string, target: SessionJumpTarget, sessionId: string): void {
    if (target.kind === 'intentDetail') {
      ctx.openIntents(path)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = target.tab ?? null
      if (target.tab === 'specSession') ctx.openSpecSession(target.intentId)
      // The review tab replays a read-only session; open it through the same
      // intent-resolved path the tab itself uses (the detail's tab machine skips a
      // duplicate open once the active session is already aligned).
      if (target.tab === 'specReviewSession') ctx.openSpecReviewSession(target.intentId, path)
      return
    }
    if (target.kind === 'intentSessions') {
      ctx.openIntents(path)
      ctx.requestedIntentSubTab.value = null
      if (target.intentId) {
        // Legacy owned intent session target: select its owning intent detail.
        ctx.requestedIntentId.value = target.intentId
      } else {
        // Standalone chat with no owning intent: open it in the right-column chat.
        ctx.requestedIntentSessionId.value = sessionId
        ctx.selectIntentSession(sessionId)
      }
      return
    }
    if (target.kind === 'discussion') {
      ctx.openDiscussions(path)
      ctx.openDiscussion(target.discussionId)
      return
    }
    ctx.openAutomations(path)
    ctx.onSelectAutomation(target.automationId)
  }

  ctx.jumpSessionSource = (path: string, row: SessionInfo): void => {
    const target = resolveSessionJumpTarget({
      sessionKind: row.sessionKind,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
    })
    if (!target) return
    openSourceTarget(path, target, row.sessionId)
  }

  // Title-bar source button: jump to the active session's resolved source,
  // reusing `openSourceTarget`. No-op when there's no source or no active session.
  ctx.jumpActiveSessionSource = (): void => {
    const target = activeSessionSource.value?.target
    const path = activeWorkspace.value
    const sessionId = activeSession.value
    if (!target || !path || !sessionId) return
    openSourceTarget(path, target, sessionId)
  }

  // Top-bar tab click.
  ctx.onSelectTab = (key: string): void => {
    if (key === 'intents') {
      if (currentWorkspace.value) ctx.openIntents(currentWorkspace.value)
      return
    }
    if (key === 'deliveries') {
      if (currentWorkspace.value) ctx.openDeliveries(currentWorkspace.value)
      return
    }
    if (key === 'discussion') {
      if (currentWorkspace.value) ctx.openDiscussions(currentWorkspace.value)
      return
    }
    if (key === 'automations') {
      if (currentWorkspace.value) ctx.openAutomations(currentWorkspace.value)
      return
    }
    if (key === 'files') {
      if (currentWorkspace.value) ctx.openFiles(currentWorkspace.value)
      return
    }
    ctx.switchToConsoleTab()
  }

  // Flip to the console tab WITHOUT re-binding a session.
  ctx.enterConsole = (): void => {
    if (activeTab.value !== 'console') {
      activeTab.value = 'console'
      ctx.persistViewMode()
    }
  }

  // Top-bar 「会话」tab click: flip to the console tab AND re-bind the chat column.
  ctx.switchToConsoleTab = (): void => {
    const fx = consoleTabEntryEffects(activeTab.value !== 'console')
    ctx.enterConsole()
    if (fx.rebind) ctx.bindConsoleSession()
    if (fx.refreshSessions) ctx.refreshSessions(currentWorkspace.value)
  }

  // Resolve and apply the console tab's session on (re)entry.
  ctx.bindConsoleSession = (): void => {
    const target = consoleEntryTarget(
      consoleSession.value,
      currentWorkspace.value,
      currentSessions.value,
    )
    if (target.kind === 'empty') {
      ctx.clearViewedSession()
      return
    }
    const ref = target.ref
    // Already viewing it — nothing to re-fetch.
    if (activeSession.value === ref.sessionId && activeWorkspace.value === ref.workspaceName) return
    send({
      type: 'select_session',
      workspaceName: ref.workspaceName,
      sessionId: ref.sessionId,
    })
  }

  // Reset the viewed chat column to the empty state (no session).
  ctx.clearViewedSession = (): void => {
    activeWorkspace.value = null
    activeSession.value = null
    activeTitle.value = ''
    activeVendor.value = null
    activeAgentSwitch.value = null
    activeSessionSource.value = null
    ctx.activeSessionRealKind.value = null
    messages.value = []
    counters.nextId = 1
    availableCommands.value = []
    activity.value = { phase: 'idle' }
    taskModel.value = emptyTaskModel()
    selectedIntentSessionId.value = null
  }

  ctx.deleteSession = (path: string, sessionId: string): void => {
    // Drop the console pointer if it referenced the deleted session.
    if (consoleSession.value?.sessionId === sessionId) consoleSession.value = null
    // Optimistically drop the row (SR-R14): the server no longer pushes a fresh
    // list after delete (a `first`-page push would clobber a loaded-more window).
    const list = sessionsByWorkspace.value[activeKey(path)]
    if (list) {
      sessionsByWorkspace.value = {
        ...sessionsByWorkspace.value,
        [activeKey(path)]: list.filter((s) => s.sessionId !== sessionId),
      }
    }
    send({ type: 'delete_session', workspaceName: path, sessionId })
  }

  ctx.renameSession = (path: string, sessionId: string, title: string): void => {
    // Optimistically update the title in place (SR-R14); the server pushes no
    // list after rename. Other clients reconcile on their next window refresh.
    const list = sessionsByWorkspace.value[activeKey(path)]
    if (list) {
      sessionsByWorkspace.value = {
        ...sessionsByWorkspace.value,
        [activeKey(path)]: list.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)),
      }
    }
    send({ type: 'rename_session', workspaceName: path, sessionId, title })
  }

  ctx.openDevSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    ctx.enterConsole()
    consoleSession.value = { workspaceName: intentsProject.value, sessionId }
    send({ type: 'select_session', workspaceName: intentsProject.value, sessionId })
  }

  // Inline work-session select for IntentDetail's work-session tab: fill the global
  // active session so the embedded ChatColumn binds, but stay on the intents page —
  // no `enterConsole`, no console-session pin. `openDevSession` above keeps the old
  // jump-to-works behaviour for external entry points.
  ctx.selectWorkSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    send({ type: 'select_session', workspaceName: intentsProject.value, sessionId })
  }
}
