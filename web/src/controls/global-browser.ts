import { computed, onUnmounted, ref, watch } from 'vue'
import type { Automation, SessionInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

export interface GlobalSessionRow extends SessionInfo {
  workspaceName: string
}

export function sortGlobalSessions(rows: GlobalSessionRow[]): GlobalSessionRow[] {
  return [...rows].sort(
    (a, b) =>
      b.lastModified - a.lastModified ||
      (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0) ||
      (a.workspaceName < b.workspaceName ? -1 : a.workspaceName > b.workspaceName ? 1 : 0),
  )
}

export function useGlobalBrowser(ctx: AppCtx) {
  const page = ctx.globalPage
  const sessions = ref<GlobalSessionRow[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const failed = ref(false)
  let sequence = 0
  let append = false
  let pageSize = 20
  let timer: ReturnType<typeof setTimeout> | undefined
  const automations = computed(() =>
    ctx.workspaces.value.flatMap((ws) => ctx.automations.value[ws.name] ?? []),
  )

  function requestSessions(more = false): void {
    if (loading.value || (more && !hasMore.value)) return
    append = more
    pageSize = more ? 10 : 20
    failed.value = false
    ctx.globalSessionPages.value = {}
    ctx.globalSessionRequestId.value = `global-${++sequence}`
    const workspaces = ctx.workspaces.value
    if (!workspaces.length) {
      sessions.value = []
      hasMore.value = false
      return
    }
    loading.value = true
    const oldest = more ? sessions.value.at(-1) : undefined
    for (const ws of workspaces) {
      ctx.send({
        type: 'list_sessions',
        workspaceName: ws.name,
        globalRequestId: ctx.globalSessionRequestId.value,
        limit: pageSize,
        before: oldest
          ? {
              lastModified: oldest.lastModified,
              sessionId: oldest.sessionId,
              workspaceName: oldest.workspaceName,
            }
          : undefined,
      })
    }
    timer = setTimeout(() => {
      loading.value = false
      failed.value = true
      ctx.globalSessionRequestId.value = null
    }, 15000)
  }

  watch(ctx.globalSessionPages, (pages) => {
    if (!loading.value || ctx.workspaces.value.some((ws) => !pages[ws.name])) return
    clearTimeout(timer)
    const rows = sortGlobalSessions(
      ctx.workspaces.value.flatMap((ws) =>
        pages[ws.name].sessions.map((row) => ({ ...row, workspaceName: ws.name })),
      ),
    )
    hasMore.value = rows.length > pageSize || Object.values(pages).some((p) => p.hasMore)
    const next = rows.slice(0, pageSize)
    sessions.value = append
      ? [
          ...sessions.value,
          ...next.filter(
            (row) =>
              !sessions.value.some(
                (old) => old.sessionId === row.sessionId && old.workspaceName === row.workspaceName,
              ),
          ),
        ]
      : next
    loading.value = false
  })

  function open(kind: 'sessions' | 'automations'): void {
    clearTimeout(timer)
    loading.value = false
    ctx.globalSessionRequestId.value = null
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
        clearTimeout(timer)
        loading.value = false
        requestSessions()
      }
      if (page.value === 'automations')
        for (const ws of ctx.workspaces.value)
          ctx.send({ type: 'list_automations', workspaceName: ws.name })
    },
  )
  watch(ctx.status, (status) => {
    if (status === 'open' && page.value === 'sessions') {
      clearTimeout(timer)
      loading.value = false
      requestSessions()
    }
  })
  function leave(): void {
    if (!page.value) return
    page.value = null
    clearTimeout(timer)
    loading.value = false
    ctx.globalSessionRequestId.value = null
    ctx.clearViewedSession()
    ctx.onSelectTab('intents')
  }
  onUnmounted(() => clearTimeout(timer))
  return {
    page,
    leave,
    sessions,
    automations,
    loading,
    failed,
    hasMore,
    open,
    requestSessions,
    selectSession,
    selectAutomation,
  }
}
