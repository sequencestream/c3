import { computed, onUnmounted, ref, watch } from 'vue'
import type { Automation, SessionInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

export interface GlobalSessionRow extends SessionInfo {
  workspaceName: string
}

export interface GlobalWorkspacePage {
  hasMore: boolean
  loading: boolean
  failed: boolean
}

export function useGlobalBrowser(ctx: AppCtx) {
  const page = ctx.globalPage
  const sessions = ref<GlobalSessionRow[]>([])
  const paging = ref<Record<string, GlobalWorkspacePage>>({})
  const loading = computed(() => Object.values(paging.value).some((group) => group.loading))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, boolean>()
  let sequence = 0
  const automations = computed(() =>
    ctx.workspaces.value.flatMap((ws) => ctx.automations.value[ws.name] ?? []),
  )

  function cancelRequests(): void {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    pending.clear()
    ctx.globalSessionRequestIds.value = {}
  }

  function requestSessions(more = false, workspaceName?: string): void {
    if (more && !workspaceName) return
    if (!workspaceName) {
      cancelRequests()
      sessions.value = []
      paging.value = {}
      ctx.globalSessionPages.value = {}
    }
    const workspaces = ctx.workspaces.value.filter(
      (ws) => !workspaceName || ws.name === workspaceName,
    )
    for (const ws of workspaces) {
      const previous = paging.value[ws.name]
      if (previous?.loading || (more && previous && !previous.hasMore && !previous.failed)) continue
      const rows = sessions.value.filter((row) => row.workspaceName === ws.name)
      const oldest = more ? rows.at(-1) : undefined
      const requestId = `global-${++sequence}`
      ctx.globalSessionRequestIds.value[ws.name] = requestId
      const pages = { ...ctx.globalSessionPages.value }
      delete pages[ws.name]
      ctx.globalSessionPages.value = pages
      pending.set(ws.name, more)
      paging.value = {
        ...paging.value,
        [ws.name]: { hasMore: previous?.hasMore ?? true, loading: true, failed: false },
      }
      timers.set(
        ws.name,
        setTimeout(() => {
          pending.delete(ws.name)
          timers.delete(ws.name)
          delete ctx.globalSessionRequestIds.value[ws.name]
          paging.value = {
            ...paging.value,
            [ws.name]: { ...paging.value[ws.name], loading: false, failed: true },
          }
        }, 15000),
      )
      ctx.send({
        type: 'list_sessions',
        workspaceName: ws.name,
        globalRequestId: requestId,
        limit: 5,
        before: oldest
          ? {
              lastModified: oldest.lastModified,
              sessionId: oldest.sessionId,
              workspaceName: ws.name,
            }
          : undefined,
      })
    }
  }

  watch(ctx.globalSessionPages, (pages) => {
    for (const [workspaceName, append] of pending) {
      const result = pages[workspaceName]
      if (!result) continue
      clearTimeout(timers.get(workspaceName))
      timers.delete(workspaceName)
      pending.delete(workspaceName)
      delete ctx.globalSessionRequestIds.value[workspaceName]
      const previous = append
        ? sessions.value.filter((row) => row.workspaceName === workspaceName)
        : []
      const next = result.sessions
        .filter((row) => !previous.some((old) => old.sessionId === row.sessionId))
        .map((row) => ({ ...row, workspaceName }))
      sessions.value = [
        ...sessions.value.filter((row) => row.workspaceName !== workspaceName),
        ...previous,
        ...next,
      ]
      paging.value = {
        ...paging.value,
        [workspaceName]: { hasMore: result.hasMore, loading: false, failed: false },
      }
    }
  })

  function open(kind: 'sessions' | 'automations'): void {
    cancelRequests()
    ctx.closeSettings()
    ctx.personalizedSettingOpen.value = false
    ctx.workspaceSettingOpen.value = false
    ctx.setViewMode('workspace')
    page.value = kind
    ctx.globalSessionSelection.value = null
    ctx.flags.pendingConsoleBind = false
    ctx.clearViewedSession()
    if (kind === 'sessions') {
      ctx.activeTab.value = 'console'
      requestSessions()
    } else {
      ctx.activeTab.value = 'automations'
      ctx.selectedAutomationId.value = null
      ctx.selectedExecutionId.value = null
      ctx.automationsProject.value = null
      for (const ws of ctx.workspaces.value)
        ctx.send({ type: 'list_automations', workspaceName: ws.name })
      ctx.send({ type: 'get_settings' })
    }
  }

  function selectSession(row: GlobalSessionRow): void {
    ctx.globalSessionSelection.value = { workspaceName: row.workspaceName, row }
    ctx.activeSessionKind.value =
      row.sessionKind === 'consensus' || row.sessionKind === 'robot'
        ? 'tool'
        : (row.sessionKind ?? 'work')
    ctx.selectSession(row.workspaceName, row.sessionId, row)
  }

  function selectAutomation(id: string): void {
    const row = automations.value.find((item: Automation) => item.id === id)
    if (!row) return
    if (ctx.automationsProject.value !== row.workspaceName) ctx.openAutomations(row.workspaceName)
    ctx.onSelectAutomation(id)
    ctx.automationToolManifest.value = {}
  }

  watch([ctx.viewMode, ctx.activeTab], ([mode, tab]) => {
    if (
      page.value &&
      (mode !== 'workspace' || tab !== (page.value === 'sessions' ? 'console' : 'automations'))
    )
      page.value = null
  })
  watch(
    () =>
      ctx.workspaces.value
        .map((ws) => ws.name)
        .sort()
        .join('\0'),
    () => {
      const names = new Set(ctx.workspaces.value.map((ws) => ws.name))
      sessions.value = sessions.value.filter((row) => names.has(row.workspaceName))
      if (ctx.activeWorkspace.value && !names.has(ctx.activeWorkspace.value))
        ctx.clearViewedSession()
      if (ctx.automationsProject.value && !names.has(ctx.automationsProject.value)) {
        ctx.selectedAutomationId.value = null
        ctx.selectedExecutionId.value = null
        ctx.automationsProject.value = null
        ctx.automationFormOpen.value = false
      }
      if (page.value === 'sessions') {
        requestSessions()
      }
      if (page.value === 'automations')
        for (const ws of ctx.workspaces.value)
          ctx.send({ type: 'list_automations', workspaceName: ws.name })
    },
  )
  watch(ctx.status, (status) => {
    if (status === 'open' && page.value === 'sessions') {
      requestSessions()
    }
  })
  function leave(): void {
    if (!page.value) return
    page.value = null
    cancelRequests()
    ctx.clearViewedSession()
    ctx.onSelectTab('intents')
  }
  onUnmounted(cancelRequests)
  return {
    page,
    leave,
    sessions,
    automations,
    loading,
    paging,
    open,
    requestSessions,
    selectSession,
    selectAutomation,
  }
}
