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

describe('activity_snapshot / activity_delta — 全工作区权威角标', () => {
  it('snapshot 写入全部工作区竖条,不要求当前工作区', () => {
    const { ctx, state } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-b'
    ctx.handleMessage({
      type: 'activity_snapshot',
      revision: 1,
      workspaces: {
        'ws-a': {
          runningSessions: 3,
          runningSessionsByKind: { work: 3 },
          activeOwners: { intents: 0, discussions: 0, automations: 0 },
          attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
        },
        'ws-b': {
          runningSessions: 1,
          runningSessionsByKind: { work: 1 },
          activeOwners: { intents: 2, discussions: 0, automations: 0 },
          attention: { awaitingPermission: 0, pendingUserTasks: 4, actionableDeliveries: 1 },
        },
      },
    } as ServerToClient)
    expect(state.workspaceRunningSessionCounts.value['ws-a']).toBe(3)
    expect(state.workspaceRunningSessionCounts.value['ws-b']).toBe(1)
    expect(state.ownerRunningCounts.value.intent).toBe(2)
    expect(state.workcenterPendingCount.value).toBe(4)
    expect(state.HEADER_TABS.value.find((tab) => tab.key === 'deliveries')?.badgeCount).toBe(1)
  })

  it('delta 更新非当前工作区竖条,不请求 get_session_counts', () => {
    const { ctx, state, send } = makeHandlerCtx()
    state.currentWorkspace.value = 'ws-b'
    ctx.handleMessage({
      type: 'activity_snapshot',
      revision: 1,
      workspaces: {
        'ws-a': {
          runningSessions: 0,
          runningSessionsByKind: {},
          activeOwners: { intents: 0, discussions: 0, automations: 0 },
          attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
        },
        'ws-b': {
          runningSessions: 0,
          runningSessionsByKind: {},
          activeOwners: { intents: 0, discussions: 0, automations: 0 },
          attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
        },
      },
    } as ServerToClient)
    send.mockClear()
    ctx.handleMessage({
      type: 'activity_delta',
      revision: 2,
      changedWorkspaces: {
        'ws-a': {
          runningSessions: 3,
          runningSessionsByKind: { work: 3 },
          activeOwners: { intents: 0, discussions: 0, automations: 0 },
          attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
        },
      },
    } as ServerToClient)
    expect(state.workspaceRunningSessionCounts.value['ws-a']).toBe(3)
    expect(send).not.toHaveBeenCalled()
  })

  it('revision 跳跃时请求完整 snapshot', () => {
    const { ctx, send } = makeHandlerCtx()
    ctx.handleMessage({
      type: 'activity_snapshot',
      revision: 1,
      workspaces: {},
    } as ServerToClient)
    send.mockClear()
    ctx.handleMessage({
      type: 'activity_delta',
      revision: 4,
      changedWorkspaces: {},
    } as ServerToClient)
    expect(send).toHaveBeenCalledWith({ type: 'request_activity_snapshot' })
  })
})

describe('idle 不点查角标', () => {
  it('revision 连续的 delta 不触发 snapshot 或 get_session_counts', () => {
    const { ctx, send } = makeHandlerCtx()
    ctx.handleMessage({
      type: 'activity_snapshot',
      revision: 1,
      workspaces: {},
    } as ServerToClient)
    send.mockClear()
    ctx.handleMessage({
      type: 'activity_delta',
      revision: 2,
      changedWorkspaces: {},
    } as ServerToClient)
    expect(send).not.toHaveBeenCalled()
  })
})
