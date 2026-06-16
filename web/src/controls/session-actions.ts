import { consoleEntryTarget, consoleTabEntryEffects, workspaceSwitchEffects } from '@/lib/tab-view'
import { emptyTaskModel } from '@/lib/task-list'
import type { AppCtx } from './types'

// Install workspace / session / top-bar-tab navigation actions onto the ctx.
export function installSessionActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    currentWorkspace,
    sessionsByWorkspace,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
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
    messages,
    counters,
    availableCommands,
    activity,
    taskModel,
    selectedIntentSessionId,
    intentsProject,
  } = ctx

  // Force a fresh `list_sessions` for a workspace, bypassing `ensureSessions`.
  ctx.refreshSessions = (path: string | null): void => {
    if (path) send({ type: 'list_sessions', workspaceId: path })
  }

  // Lazily fetch a workspace's session list (once) for the sidebar.
  ctx.ensureSessions = (path: string | null): void => {
    if (path && !sessionsByWorkspace.value[path]) ctx.refreshSessions(path)
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
    send({ type: 'delete_session', workspaceId: path, sessionId })
  }

  ctx.renameSession = (path: string, sessionId: string, title: string): void => {
    send({ type: 'rename_session', workspaceId: path, sessionId, title })
  }

  ctx.openDevSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    ctx.enterConsole()
    consoleSession.value = { workspacePath: intentsProject.value, sessionId }
    send({ type: 'select_session', workspaceId: intentsProject.value, sessionId })
  }
}
