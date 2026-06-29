import { consoleEntryTarget, consoleTabEntryEffects, workspaceSwitchEffects } from '@/lib/tab-view'
import { emptyTaskModel } from '@/lib/task-list'
import { SESSION_PAGE_SIZE } from '@/lib/session-page'
import { resolveSessionJumpTarget } from '@/lib/session-jump'
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
    activeLinkedScheduleId,
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
    ctx.clearViewedSession()
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

  ctx.selectSession = (path: string, sessionId: string): void => {
    const row = sessionsByWorkspace.value[activeKey(path)]?.find((s) => s.sessionId === sessionId)
    if (row?.sessionKind === 'spec') {
      const target = resolveSessionJumpTarget({
        sessionKind: row.sessionKind,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
      })
      if (target?.kind === 'intentDetail' && target.tab === 'specSession') {
        ctx.openIntents(path)
        const hasLoadedIntents = Object.prototype.hasOwnProperty.call(ctx.intents.value, path)
        const ownerExists = ctx.intents.value[path]?.some((intent) => intent.id === target.intentId)
        if (!hasLoadedIntents || ownerExists) {
          ctx.requestedIntentId.value = target.intentId
          ctx.requestedIntentSubTab.value = 'specSession'
          ctx.openSpecSession(target.intentId)
        }
        return
      }
      const intents = ctx.intents.value[path] ?? []
      const legacyIntent = intents.find((intent) => intent.specSessionId === sessionId)
      if (legacyIntent) {
        ctx.openIntents(path)
        ctx.requestedIntentId.value = legacyIntent.id
        ctx.requestedIntentSubTab.value = 'specSession'
        ctx.openSpecSession(legacyIntent.id)
        return
      }
      ctx.openIntents(path)
      return
    }
    ctx.enterConsole()
    // Pin the console tab's pointer up front.
    consoleSession.value = { workspacePath: path, sessionId }
    if (sessionId === activeSession.value) return
    send({ type: 'select_session', workspaceId: path, sessionId })
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
    activeLinkedScheduleId.value = null
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
