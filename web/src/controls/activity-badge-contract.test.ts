/**
 * 前端活动角标口径契约:冻结当前消费方式,并用预期失败用例表达已知缺陷。
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ServerToClient, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { createState, type StateDeps } from './state'
import { installMessageHandler } from './message-handler'
import type { AppCtx } from './types'

function makeState() {
  const deps = {
    t: (key: string) => key,
    modeLabel: (code: string) => code,
    auth: { status: ref('unknown') },
  } as unknown as StateDeps
  return createState(deps)
}

function todoEvent(id: string, workspaceName = 'ws-a'): WaitUserInvolveEvent {
  return {
    id,
    workspaceName,
    sessionKind: 'work',
    sessionId: null,
    title: id,
    requestId: null,
    toolName: null,
    toolInput: null,
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeHandlerCtx() {
  const state = makeState()
  const send = vi.fn()
  const ctx = {
    ...state,
    send,
    add: vi.fn(),
    maybeRefreshDashboard: vi.fn(),
    flushIfReady: vi.fn(),
    notifyAwaitingPermission: vi.fn(),
    fetchPersonalizedSettings: vi.fn(),
  } as unknown as AppCtx
  installMessageHandler(ctx)
  return { ctx, state, send }
}

describe('workcenterPendingCount — 权威 todoCount', () => {
  it('角标等于当前工作区的权威 todoCount,done 不计', () => {
    const s = makeState()
    s.currentWorkspace.value = 'ws-a'
    s.workcenterEvents.value = [
      todoEvent('t1'),
      { ...todoEvent('d1'), status: 'done' },
      todoEvent('t2'),
    ]
    s.workcenterTodoCounts.value = { 'ws-a': 2 }
    expect(s.workcenterPendingCount.value).toBe(2)
  })

  it('超过一页 todo 时待处理角标仍为权威总数', () => {
    const s = makeState()
    s.currentWorkspace.value = 'ws-a'
    s.workcenterEvents.value = Array.from({ length: 20 }, (_, i) => todoEvent(`t-${i}`))
    s.workcenterHasMore.value = true
    s.workcenterTodoCounts.value = { 'ws-a': 25 }
    expect(s.workcenterPendingCount.value).toBe(25)
  })

  it('角标读当前工作区的权威计数,不扫描已加载列表', () => {
    const s = makeState()
    s.currentWorkspace.value = 'ws-b'
    s.workcenterEvents.value = Array.from({ length: 20 }, (_, i) => todoEvent(`t-${i}`, 'ws-a'))
    s.workcenterTodoCounts.value = { 'ws-a': 20, 'ws-b': 3 }
    expect(s.workcenterPendingCount.value).toBe(3)
  })
})

describe('wait_user_events — 工作区身份与权威计数', () => {
  it('当前工作区的分页回包写入列表与 todoCount', () => {
    const { ctx, state } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-a'
    ctx.handleMessage({
      type: 'wait_user_events',
      workspaceName: 'ws-a',
      items: Array.from({ length: 20 }, (_, i) => todoEvent(`t-${i}`)),
      hasMore: true,
      todoCount: 25,
    } as ServerToClient)
    expect(state.workcenterEvents.value).toHaveLength(20)
    expect(state.workcenterHasMore.value).toBe(true)
    expect(state.workcenterPendingCount.value).toBe(25)
  })

  it('非当前工作区的广播只更新该工作区计数,不污染当前列表', () => {
    const { ctx, state } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-b'
    state.workcenterEvents.value = [todoEvent('keep', 'ws-b')]
    state.workcenterTodoCounts.value = { 'ws-b': 1 }
    ctx.handleMessage({
      type: 'wait_user_events',
      workspaceName: 'ws-a',
      items: [todoEvent('t-new', 'ws-a')],
      todoCount: 4,
    } as ServerToClient)
    expect(state.workcenterEvents.value.map((event) => event.id)).toEqual(['keep'])
    expect(state.workcenterTodoCounts.value).toEqual({ 'ws-a': 4, 'ws-b': 1 })
    expect(state.workcenterPendingCount.value).toBe(1)
  })
})

describe('已知缺陷 — 目标口径(当前失败)', () => {
  it.fails('非当前 workspace 的 session_counts 仍写入竖条映射', () => {
    const { ctx, state } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-b'
    ctx.handleMessage({
      type: 'session_counts',
      workspaceName: 'ws-a',
      counts: {
        work: 0,
        intent: 0,
        spec: 0,
        spec_review: 0,
        discussion: 0,
        automation: 0,
        tool: 0,
      },
      ownerCounts: { intent: 0, discussion: 0, automation: 0 },
      runningSessionCount: 3,
    } as ServerToClient)
    expect(state.workspaceRunningSessionCounts.value['ws-a']).toBe(3)
  })

  it.fails('运行集合变化时为所有已登记 workspace 重取计数', () => {
    const { ctx, state, send } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-b'
    state.workspaces.value = [
      { name: 'ws-a', path: '/ws/a', lastAccessed: 2 },
      { name: 'ws-b', path: '/ws/b', lastAccessed: 1 },
    ]
    ctx.handleMessage({
      type: 'session_status',
      statuses: [{ sessionId: 's-a', status: 'running' }],
    } as ServerToClient)
    expect(send).toHaveBeenCalledWith({ type: 'get_session_counts', workspaceName: 'ws-a' })
    expect(send).toHaveBeenCalledWith({ type: 'get_session_counts', workspaceName: 'ws-b' })
  })
})
