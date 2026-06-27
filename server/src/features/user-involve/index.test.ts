/**
 * `list_wait_user_events` handler — the READ side's workspace-id contract.
 *
 * The wire carries an opaque `workspaceId`; the store keys events by the resolved
 * absolute path. These tests pin that the handler resolves the id → path FIRST
 * (so a real workspace returns its events) and degrades an unregistered id to an
 * explicit empty snapshot instead of querying `workspace_path = <id>` (the silent
 * WorkCenter history / auto re-fetch bug this fixes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

const h = vi.hoisted(() => ({
  roots: new Map<string, string>(),
  storeAvailable: true,
  listEventsPage: vi.fn(),
  getEvent: vi.fn(),
  updateStatus: vi.fn(),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: vi.fn((id: string) => h.roots.get(id) ?? null),
}))

vi.mock('./store.js', () => ({
  isStoreAvailable: () => h.storeAvailable,
  listEventsPage: h.listEventsPage,
  getEvent: h.getEvent,
  updateStatus: h.updateStatus,
}))

import { listWaitUserEvents, updateWaitUserEvent } from './index.js'

const broadcastWaitUserEvents = vi.fn<(workspacePath: string) => void>()

beforeEach(() => {
  h.roots.clear()
  h.roots.set('ws-1', '/abs/project-a')
  h.storeAvailable = true
  h.listEventsPage.mockReset()
  h.getEvent.mockReset()
  h.updateStatus.mockReset()
  broadcastWaitUserEvents.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function capture(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m) => sent.push(m),
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      viewing: null,
      authed: true,
      authToken: 'tok',
      subject: null,
    },
  }
}

const KCTX = { broadcastWaitUserEvents } as never

describe('listWaitUserEvents', () => {
  it('resolves the opaque workspaceId to a path before querying the store', () => {
    const events: WaitUserInvolveEvent[] = [
      {
        id: 'e1',
        workspaceId: 'ws-1',
        sessionKind: 'work',
        sessionId: 's1',
        title: null,
        requestId: null,
        toolName: null,
        toolInput: null,
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    h.listEventsPage.mockReturnValue({ items: events, hasMore: false })
    const { conn, sent } = capture()

    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ws-1' })

    // Queried by the RESOLVED path, not the wire id.
    expect(h.listEventsPage).toHaveBeenCalledWith(
      '/abs/project-a',
      undefined,
      undefined,
      undefined,
      undefined,
    )
    expect(sent).toEqual([{ type: 'wait_user_events', items: events, hasMore: false }])
  })

  it('forwards paging inputs to the store', () => {
    h.listEventsPage.mockReturnValue({ items: [], hasMore: true })
    const { conn } = capture()
    listWaitUserEvents(KCTX, conn, {
      type: 'list_wait_user_events',
      workspaceId: 'ws-1',
      status: 'auto',
      cursorTime: 123,
      cursorExcludeId: 'e1',
      limit: 20,
    })
    expect(h.listEventsPage).toHaveBeenCalledWith('/abs/project-a', 'auto', 123, 'e1', 20)
  })

  it('degrades an unregistered workspaceId to an explicit empty snapshot (no id-as-path query)', () => {
    const { conn, sent } = capture()
    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ghost' })
    expect(h.listEventsPage).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'wait_user_events', items: [], hasMore: false }])
  })

  it('reports an error when the store is unavailable', () => {
    h.storeAvailable = false
    const { conn, sent } = capture()
    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ws-1' })
    expect(sent).toEqual([{ type: 'error', error: { code: 'waitUserInvolve.dbUnavailable' } }])
    expect(h.listEventsPage).not.toHaveBeenCalled()
  })
})

describe('updateWaitUserEvent', () => {
  it('marks a todo event done and broadcasts the refreshed todo list', () => {
    h.getEvent.mockReturnValue({
      id: 'e1',
      workspaceId: 'ws-1',
      sessionKind: 'work',
      sessionId: 's1',
      title: null,
      requestId: null,
      toolName: null,
      toolInput: null,
      status: 'todo',
      createdAt: 1,
      updatedAt: 1,
    } satisfies WaitUserInvolveEvent)
    const { conn, sent } = capture()

    updateWaitUserEvent(KCTX, conn, { type: 'update_wait_user_event', id: 'e1', status: 'done' })

    expect(h.updateStatus).toHaveBeenCalledWith('e1', 'done')
    expect(broadcastWaitUserEvents).toHaveBeenCalledWith('/abs/project-a')
    expect(sent).toEqual([])
  })

  it('rejects non-todo transitions', () => {
    h.getEvent.mockReturnValue({
      id: 'e1',
      workspaceId: 'ws-1',
      sessionKind: 'work',
      sessionId: 's1',
      title: null,
      requestId: null,
      toolName: null,
      toolInput: null,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    } satisfies WaitUserInvolveEvent)
    const { conn, sent } = capture()

    updateWaitUserEvent(KCTX, conn, { type: 'update_wait_user_event', id: 'e1', status: 'todo' })

    expect(h.updateStatus).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { type: 'error', error: { code: 'waitUserInvolve.invalidStatusTransition' } },
    ])
  })
})
