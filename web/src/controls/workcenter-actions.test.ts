/**
 * WorkCenter `jumpToSource` — the per-sessionKind workspace + sessionId routing contract.
 *
 * Pins that each `sessionKind` lands on the unified session page using the
 * event's opaque `workspaceId`. WorkCenter never opens the business pages
 * directly; `sessionKind` only chooses the session-page left-list kind.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { installWorkcenterActions } from './workcenter-actions'
import type { AppCtx } from './types'

const WS = 'ws-1'

function event(over: Partial<WaitUserInvolveEvent>): WaitUserInvolveEvent {
  return {
    id: 'e1',
    workspaceId: WS,
    sessionKind: 'work',
    sessionId: null,
    title: null,
    requestId: null,
    toolName: null,
    toolInput: null,
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as WaitUserInvolveEvent
}

function makeCtx() {
  const spies = {
    send: vi.fn(),
    setViewMode: vi.fn(),
    openWorkcenterSession: vi.fn(),
    openIntents: vi.fn(),
  }
  const requestedIntentId = ref<string | null>(null)
  const ctx = {
    ...spies,
    client: {} as never,
    currentWorkspace: ref<string | null>(WS),
    requestedIntentId,
    workcenterEvents: ref<WaitUserInvolveEvent[]>([]),
    workcenterLoading: ref(false),
    workcenterAppendNext: ref(false),
    workcenterHasMore: ref(true),
  } as unknown as AppCtx
  installWorkcenterActions(ctx)
  return { ctx, ...spies, requestedIntentId }
}

describe('WorkCenter list actions', () => {
  it('reloads all statuses when no status filter is provided', () => {
    const { ctx, send } = makeCtx()
    ctx.reloadWorkcenter()
    expect(send).toHaveBeenCalledWith({
      type: 'list_wait_user_events',
      workspaceId: WS,
      status: undefined,
      limit: 20,
    })
  })

  it('loads more with the current status filter, including All as undefined', () => {
    const { ctx, send } = makeCtx()
    ctx.loadMoreWorkcenter(undefined, 100, 'e1')
    expect(send).toHaveBeenCalledWith({
      type: 'list_wait_user_events',
      workspaceId: WS,
      status: undefined,
      cursorTime: 100,
      cursorExcludeId: 'e1',
      limit: 20,
    })
  })

  it('markDoneWorkcenter updates event status in place instead of removing the row', () => {
    const { ctx, send } = makeCtx()
    ctx.workcenterEvents.value = [
      event({ id: 'e1', status: 'todo' }),
      event({ id: 'e2', status: 'todo' }),
    ]

    ctx.markDoneWorkcenter('e1')

    expect(send).toHaveBeenCalledWith({ type: 'update_wait_user_event', id: 'e1', status: 'done' })
    expect(ctx.workcenterEvents.value.map((item) => [item.id, item.status])).toEqual([
      ['e1', 'done'],
      ['e2', 'todo'],
    ])
  })
})

describe('jumpToSource', () => {
  it('switches to workspace view mode before navigating (was missing — bug fix)', () => {
    const { ctx, setViewMode } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: 's1' }))
    expect(setViewMode).toHaveBeenCalledWith('workspace')
  })

  it.each([
    ['work', 's1'],
    ['intent', 'sess-1'],
    ['spec', 'spec-1'],
    ['discussion', 'disc-1'],
    ['schedule', 'exec-sess-1'],
    ['tool', 'tool-1'],
    ['consensus', 'consensus-1'],
  ])('%s + sessionId → unified session page jump', (sessionKind, sessionId) => {
    const { ctx, openWorkcenterSession } = makeCtx()
    ctx.jumpToSource(event({ sessionKind, sessionId, title: 'Need review', updatedAt: 10 }))
    expect(openWorkcenterSession).toHaveBeenCalledWith({
      workspaceId: WS,
      sessionKind,
      sessionId,
      title: 'Need review',
      updatedAt: 10,
    })
  })

  it('without sessionId → switches to that session kind without selecting a session', () => {
    const { ctx, openWorkcenterSession } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: null }))
    expect(openWorkcenterSession).toHaveBeenCalledWith({
      workspaceId: WS,
      sessionKind: 'intent',
      sessionId: null,
      title: null,
      updatedAt: 1,
    })
  })

  it('falls back to currentWorkspace when the event carries no workspaceId', () => {
    const { ctx, openWorkcenterSession } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: 's1', workspaceId: '' }))
    expect(openWorkcenterSession).toHaveBeenCalledWith({
      workspaceId: WS,
      sessionKind: 'work',
      sessionId: 's1',
      title: null,
      updatedAt: 1,
    })
  })

  it('intentLevel + intentId → routes to intent detail page (not openWorkcenterSession)', () => {
    const { ctx, openIntents, requestedIntentId, openWorkcenterSession } = makeCtx()
    ctx.jumpToSource(
      event({
        sessionKind: 'intent',
        sessionId: 'intent-self-id',
        intentId: 'intent-self-id',
        intentLevel: true,
      }),
    )
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId!.value).toBe('intent-self-id')
    expect(openWorkcenterSession).not.toHaveBeenCalled()
  })

  it('intentLevel without intentId → falls through to openWorkcenterSession', () => {
    const { ctx, openWorkcenterSession } = makeCtx()
    ctx.jumpToSource(
      event({ sessionKind: 'intent', sessionId: null, intentLevel: true, intentId: null }),
    )
    expect(openWorkcenterSession).toHaveBeenCalled()
  })
})
