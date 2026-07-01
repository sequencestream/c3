import { consoleEntryTarget, consoleTabEntryEffects, workspaceSwitchEffects } from '@/lib/tab-view'
import { emptyTaskModel } from '@/lib/task-list'
import { SESSION_PAGE_SIZE } from '@/lib/session-page'
import { resolveSessionJumpTarget, type SessionJumpTarget } from '@/lib/session-jump'
import type { SessionInfo, SessionKind } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { sessionCacheKey, type SessionPageKind } from './state'

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
      kind === 'discussion' ||
      kind === 'schedule' ||
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
    if (kind === 'intent' || kind === 'spec') return 'intent'
    if (kind === 'discussion') return 'discussion'
    if (kind === 'schedule') return 'schedule'
    return null
  }

  function appendWorkcenterSessionIfMissing(input: {
    workspaceId: string
    sessionKind: SessionPageKind
    sourceKind: string | null | undefined
    sessionId: string
    title?: string | null
    updatedAt?: number | null
  }): void {
    const key = keyFor(input.workspaceId, input.sessionKind)
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
      workspaceId: path,
      sessionKind: kind,
      limit: SESSION_PAGE_SIZE,
    })
    send({ type: 'get_session_counts', workspaceId: path })
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
        workspaceId: path,
        sessionKind: activeSessionKind.value,
        since,
      })
    } else {
      send({
        type: 'list_sessions',
        workspaceId: path,
        sessionKind: activeSessionKind.value,
        limit: SESSION_PAGE_SIZE,
      })
    }
    send({ type: 'get_session_counts', workspaceId: path })
  }

  // Lazily fetch a workspace's first session page (once) for the sidebar.
  ctx.ensureSessions = (path: string | null): void => {
    if (path && !sessionsByWorkspace.value[activeKey(path)]) {
      send({
        type: 'list_sessions',
        workspaceId: path,
        sessionKind: activeSessionKind.value,
        limit: SESSION_PAGE_SIZE,
      })
      send({ type: 'get_session_counts', workspaceId: path })
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
      workspaceId: path,
      sessionKind: activeSessionKind.value,
      before: { lastModified: oldest.lastModified, sessionId: oldest.sessionId },
      limit: SESSION_PAGE_SIZE,
    })
  }

  // Switch the global current workspace. The view always lands on the console tab.
  ctx.selectWorkspace = (path: string): void => {
    const fx = workspaceSwitchEffects(path, currentWorkspace.value)
    if (fx.noop) return
    currentWorkspace.value = path
    ctx.persistCurrentWorkspace()
    workspaceSettingOpen.value = false
    currentWorkspaceSetting.value = null
    detectedMainBranch.value = null
    resolvedSpecRoot.value = null
    // The console tab's remembered session belonged to the previous workspace —
    // drop it and clear the chat column so it can't keep showing stale content.
    // The new workspace's first session is bound once its `list_sessions` reply
    // lands (see `pendingConsoleBind` in the `sessions` handler).
    consoleSession.value = null
    ctx.clearViewedSession()
    ctx.flags.pendingConsoleBind = true
    if (fx.enterConsole) ctx.enterConsole()
    if (fx.refreshSessions) ctx.refreshSessions(path)
  }

  ctx.addWorkspace = (path: string): void => {
    send({ type: 'add_workspace', path })
  }

  ctx.removeWorkspace = (path: string): void => {
    send({ type: 'remove_workspace', path })
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
      workspaceId: path,
      ...(agentId ? { agentId } : {}),
    })
  }

  // The picker's "binary not in PATH → go to detection" link.
  ctx.openSettingsFromPicker = (): void => {
    newSessionOpen.value = false
    ctx.openSettings()
  }

  // A list row click means "view this session" — no business-page jump branches.
  // Every non-orphaned row enters the console tab and binds the chat column; the
  // source jump now lives on the title-bar button (see `jumpActiveSessionSource`).
  ctx.selectSession = (path: string, sessionId: string): void => {
    ctx.requestedWorkSessionId.value = null
    ctx.enterConsole()
    // Pin the console tab's pointer up front.
    consoleSession.value = { workspacePath: path, sessionId }
    if (sessionId === activeSession.value) return
    send({ type: 'select_session', workspaceId: path, sessionId })
  }

  ctx.openWorkcenterSession = (input): void => {
    const path = input.workspaceId
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
      workspaceId: path,
      sessionKind: kind,
      sourceKind: input.sessionKind,
      sessionId: input.sessionId,
      title: input.title,
      updatedAt: input.updatedAt,
    })
    consoleSession.value = { workspacePath: path, sessionId: input.sessionId }
    if (input.sessionId === activeSession.value && path === activeWorkspace.value) return
    send({ type: 'select_session', workspaceId: path, sessionId: input.sessionId })
  }

  // Open the page the given jump target points at (intent detail / intent
  // sessions / discussion / schedule). The one place title-bar and (legacy) row
  // source jumps both route through; jump semantics come only from
  // `resolveSessionJumpTarget` upstream.
  function openSourceTarget(path: string, target: SessionJumpTarget, sessionId: string): void {
    if (target.kind === 'intentDetail') {
      ctx.openIntents(path)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = target.tab ?? null
      if (target.tab === 'specSession') ctx.openSpecSession(target.intentId)
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
    ctx.openSchedules(path)
    ctx.onSelectSchedule(target.scheduleId)
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
    if (key === 'discussion') {
      if (currentWorkspace.value) ctx.openDiscussions(currentWorkspace.value)
      return
    }
    if (key === 'schedules') {
      if (currentWorkspace.value) ctx.openSchedules(currentWorkspace.value)
      return
    }
    if (key === 'codes') {
      if (currentWorkspace.value) ctx.openCodes(currentWorkspace.value)
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
    if (activeSession.value === ref.sessionId && activeWorkspace.value === ref.workspacePath) return
    send({
      type: 'select_session',
      workspaceId: ref.workspacePath,
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
    send({ type: 'delete_session', workspaceId: path, sessionId })
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
    send({ type: 'rename_session', workspaceId: path, sessionId, title })
  }

  ctx.openDevSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    ctx.enterConsole()
    consoleSession.value = { workspacePath: intentsProject.value, sessionId }
    send({ type: 'select_session', workspaceId: intentsProject.value, sessionId })
  }
}
