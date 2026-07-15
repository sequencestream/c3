/**
 * Workcenter Dashboard control layer: the actions (`installDashboardActions`) and
 * the two inbound cases (`installMessageHandler`) that apply the snapshot and the
 * per-row gate result. A focused ctx of plain refs is enough — only the dashboard
 * refs + a captured `send` are exercised.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, WorkspaceDashboardRow } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { installDashboardActions } from './dashboard-actions'
import { installMessageHandler } from './message-handler'

function row(id: string, over: Partial<WorkspaceDashboardRow> = {}): WorkspaceDashboardRow {
  return {
    workspaceId: id,
    name: id,
    path: `/abs/${id}`,
    sessions: { running: 0, total: 0 },
    intents: { total: 0 },
    discussions: { total: 0 },
    automations: { total: 0 },
    automationEnabled: true,
    ...over,
  }
}

function makeCtx(opts: { isAdmin?: boolean } = {}) {
  const send = vi.fn()
  const showToast = vi.fn()
  const reloadWorkcenter = vi.fn()
  const ctx = {
    client: {} as never,
    send,
    showToast,
    reloadWorkcenter,
    t: (key: string) => key,
    auth: { isAdmin: ref(opts.isAdmin ?? true) },
    viewMode: ref<'workspace' | 'workcenter'>('workcenter'),
    workcenterPage: ref<'dashboard' | 'notifications'>('dashboard'),
    dashboardRows: ref<WorkspaceDashboardRow[]>([]),
    dashboardLoading: ref(false),
    dashboardError: ref<{ code: string } | null>(null),
    dashboardPending: ref<Set<string>>(new Set()),
    dashboardRefreshPending: ref(false),
  } as unknown as AppCtx
  installDashboardActions(ctx)
  installMessageHandler(ctx)
  return { ctx, send, showToast, reloadWorkcenter }
}

function lastSent(send: ReturnType<typeof vi.fn>): ClientToServer | undefined {
  const call = send.mock.calls.at(-1)
  return call?.[0]
}

describe('dashboard actions — load + coalesce', () => {
  it('loadDashboard sends the snapshot request and marks loading', () => {
    const { ctx, send } = makeCtx()
    ctx.loadDashboard()
    expect(ctx.dashboardLoading.value).toBe(true)
    expect(lastSent(send)).toEqual({ type: 'get_workspace_dashboard' })
  })

  it('coalesces a concurrent load into a single pending refresh', () => {
    const { ctx, send } = makeCtx()
    ctx.loadDashboard()
    send.mockClear()
    ctx.loadDashboard() // already loading
    expect(send).not.toHaveBeenCalled()
    expect(ctx.dashboardRefreshPending.value).toBe(true)
  })

  it('maybeRefreshDashboard only fires on the active Dashboard view', () => {
    const { ctx, send } = makeCtx()
    ctx.workcenterPage.value = 'notifications'
    ctx.maybeRefreshDashboard()
    expect(send).not.toHaveBeenCalled()
    ctx.workcenterPage.value = 'dashboard'
    ctx.viewMode.value = 'workspace'
    ctx.maybeRefreshDashboard()
    expect(send).not.toHaveBeenCalled()
    ctx.viewMode.value = 'workcenter'
    ctx.maybeRefreshDashboard()
    expect(lastSent(send)).toEqual({ type: 'get_workspace_dashboard' })
  })
})

describe('dashboard actions — per-row gate guards', () => {
  it('does not send for a non-admin', () => {
    const { ctx, send } = makeCtx({ isAdmin: false })
    ctx.toggleWorkspaceAutomation('a', true)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not re-enter while that row toggle is in flight', () => {
    const { ctx, send } = makeCtx()
    ctx.dashboardPending.value = new Set(['a'])
    ctx.toggleWorkspaceAutomation('a', false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the single-workspace target and marks the row pending', () => {
    const { ctx, send } = makeCtx()
    ctx.toggleWorkspaceAutomation('a', false)
    expect([...ctx.dashboardPending.value]).toEqual(['a'])
    expect(lastSent(send)).toEqual({
      type: 'set_workspaces_automation_enabled',
      workspaceIds: ['a'],
      enabled: false,
    })
  })

  it('leaves other in-flight rows pending when a new row toggles', () => {
    const { ctx } = makeCtx()
    ctx.dashboardPending.value = new Set(['a'])
    ctx.toggleWorkspaceAutomation('b', true)
    expect([...ctx.dashboardPending.value].sort()).toEqual(['a', 'b'])
  })
})

describe('dashboard actions — page nav', () => {
  it('switching to notifications reloads the event list', () => {
    const { ctx, reloadWorkcenter } = makeCtx()
    ctx.setWorkcenterPage('notifications')
    expect(ctx.workcenterPage.value).toBe('notifications')
    expect(reloadWorkcenter).toHaveBeenCalledTimes(1)
  })

  it('switching back to dashboard reloads the snapshot', () => {
    const { ctx, send } = makeCtx()
    ctx.workcenterPage.value = 'notifications'
    send.mockClear()
    ctx.setWorkcenterPage('dashboard')
    expect(lastSent(send)).toEqual({ type: 'get_workspace_dashboard' })
  })
})

describe('dashboard message handling — snapshot', () => {
  it('applies rows, clears error, prunes pending to existing ids', () => {
    const { ctx } = makeCtx()
    ctx.dashboardLoading.value = true
    ctx.dashboardError.value = { code: 'dashboard.loadFailed' }
    ctx.dashboardPending.value = new Set(['a', 'gone'])
    ctx.handleMessage({ type: 'workspace_dashboard', rows: [row('a'), row('b')] })
    expect(ctx.dashboardLoading.value).toBe(false)
    expect(ctx.dashboardError.value).toBeNull()
    expect(ctx.dashboardRows.value.map((r) => r.workspaceId)).toEqual(['a', 'b'])
    expect([...ctx.dashboardPending.value]).toEqual(['a']) // 'gone' pruned
  })

  it('keeps the previous rows and surfaces the error on a failed snapshot', () => {
    const { ctx } = makeCtx()
    ctx.dashboardRows.value = [row('a')]
    ctx.dashboardLoading.value = true
    ctx.handleMessage({
      type: 'workspace_dashboard',
      rows: [],
      error: { code: 'dashboard.loadFailed' },
    })
    expect(ctx.dashboardRows.value.map((r) => r.workspaceId)).toEqual(['a']) // kept
    expect(ctx.dashboardError.value).toEqual({ code: 'dashboard.loadFailed' })
    expect(ctx.dashboardLoading.value).toBe(false)
  })

  it('runs exactly one more fetch when a refresh was pending', () => {
    const { ctx, send } = makeCtx()
    ctx.dashboardLoading.value = true
    ctx.dashboardRefreshPending.value = true
    send.mockClear()
    ctx.handleMessage({ type: 'workspace_dashboard', rows: [] })
    expect(ctx.dashboardRefreshPending.value).toBe(false)
    expect(send).toHaveBeenCalledWith({ type: 'get_workspace_dashboard' })
  })
})

describe('dashboard message handling — per-row gate result', () => {
  it('success clears the row pending flag, adopts snapshot, no toast', () => {
    const { ctx, showToast } = makeCtx()
    ctx.dashboardPending.value = new Set(['a', 'b'])
    ctx.handleMessage({
      type: 'workspaces_automation_result',
      results: [{ workspaceId: 'a', ok: true }],
      dashboard: [row('a', { automationEnabled: false }), row('b')],
    })
    expect([...ctx.dashboardPending.value]).toEqual(['b']) // only 'a' settled
    expect(ctx.dashboardRows.value[0].automationEnabled).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('failure clears the row pending flag and toasts the failure', () => {
    const { ctx, showToast } = makeCtx()
    ctx.dashboardPending.value = new Set(['a'])
    ctx.handleMessage({
      type: 'workspaces_automation_result',
      results: [{ workspaceId: 'a', ok: false, error: { code: 'dashboard.gateSaveFailed' } }],
      dashboard: [row('a')],
    })
    expect(ctx.dashboardPending.value.size).toBe(0)
    expect(showToast).toHaveBeenCalledWith('dashboard.toggleFailed')
  })

  it('re-requests a snapshot when the post-op snapshot itself failed', () => {
    const { ctx, send } = makeCtx()
    ctx.dashboardPending.value = new Set(['a'])
    send.mockClear()
    ctx.handleMessage({
      type: 'workspaces_automation_result',
      results: [{ workspaceId: 'a', ok: true }],
      dashboard: [],
      dashboardError: { code: 'dashboard.loadFailed' },
    })
    expect(ctx.dashboardError.value).toEqual({ code: 'dashboard.loadFailed' })
    expect(send).toHaveBeenCalledWith({ type: 'get_workspace_dashboard' })
  })
})
