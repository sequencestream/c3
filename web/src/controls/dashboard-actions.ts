import type { AppCtx } from './types'

// Install Workcenter Dashboard actions (cross-workspace snapshot + bulk automation
// gate) onto the ctx. The snapshot is a single server aggregation; loads are
// coalesced (one in flight + at most one pending) so bursty domain broadcasts can
// only ever trigger one extra refresh.
export function installDashboardActions(ctx: AppCtx): void {
  const send = ctx.send

  ctx.setWorkcenterPage = (page: 'dashboard' | 'notifications'): void => {
    if (ctx.workcenterPage.value === page) return
    ctx.workcenterPage.value = page
    if (page === 'dashboard') ctx.loadDashboard()
    else ctx.reloadWorkcenter()
  }

  ctx.loadDashboard = (): void => {
    if (!ctx.client) return
    // A snapshot is already in flight — record a single pending refresh and let the
    // reply re-fetch once (event-loop coalescing; never a per-workspace fan-out).
    if (ctx.dashboardLoading.value) {
      ctx.dashboardRefreshPending.value = true
      return
    }
    ctx.dashboardLoading.value = true
    send({ type: 'get_workspace_dashboard' })
  }

  // Domain-broadcast hook: refresh only while the Dashboard is the active view.
  ctx.maybeRefreshDashboard = (): void => {
    if (ctx.viewMode.value !== 'workcenter' || ctx.workcenterPage.value !== 'dashboard') return
    ctx.loadDashboard()
  }

  ctx.toggleDashboardWorkspace = (workspaceId: string): void => {
    const next = new Set(ctx.dashboardSelected.value)
    if (next.has(workspaceId)) next.delete(workspaceId)
    else next.add(workspaceId)
    ctx.dashboardSelected.value = next
  }

  ctx.toggleAllDashboard = (): void => {
    const rows = ctx.dashboardRows.value
    const allSelected = rows.length > 0 && ctx.dashboardSelected.value.size === rows.length
    ctx.dashboardSelected.value = allSelected
      ? new Set()
      : new Set(rows.map((row) => row.workspaceId))
  }

  ctx.setWorkspacesAutomation = (enabled: boolean): void => {
    // Non-admins never see the control, but guard the write path too.
    if (!ctx.auth.isAdmin.value || !ctx.client) return
    const ids = [...ctx.dashboardSelected.value]
    // No selection ⇒ never a batch; a bulk request already in flight ⇒ no re-entry.
    if (ids.length === 0 || ctx.dashboardBusy.value) return
    ctx.dashboardBusy.value = true
    send({ type: 'set_workspaces_automation_enabled', workspaceIds: ids, enabled })
  }
}
