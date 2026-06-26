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
  listEvents: vi.fn(),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: vi.fn((id: string) => h.roots.get(id) ?? null),
}))

vi.mock('./store.js', () => ({
  isStoreAvailable: () => h.storeAvailable,
  listEvents: h.listEvents,
}))

import { listWaitUserEvents } from './index.js'

beforeEach(() => {
  h.roots.clear()
  h.roots.set('ws-1', '/abs/project-a')
  h.storeAvailable = true
  h.listEvents.mockReset()
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

const KCTX = {} as never

describe('listWaitUserEvents', () => {
  it('resolves the opaque workspaceId to a path before querying the store', () => {
    const events: WaitUserInvolveEvent[] = [
      {
        id: 'e1',
        workspaceId: 'ws-1',
        source: 'work',
        sourceId: 's1',
        title: null,
        requestId: null,
        toolName: null,
        toolInput: null,
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    h.listEvents.mockReturnValue(events)
    const { conn, sent } = capture()

    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ws-1' })

    // Queried by the RESOLVED path, not the wire id.
    expect(h.listEvents).toHaveBeenCalledWith('/abs/project-a', undefined)
    expect(sent).toEqual([{ type: 'wait_user_events', items: events }])
  })

  it('forwards the optional status filter to the store', () => {
    h.listEvents.mockReturnValue([])
    const { conn } = capture()
    listWaitUserEvents(KCTX, conn, {
      type: 'list_wait_user_events',
      workspaceId: 'ws-1',
      status: 'auto',
    })
    expect(h.listEvents).toHaveBeenCalledWith('/abs/project-a', 'auto')
  })

  it('degrades an unregistered workspaceId to an explicit empty snapshot (no id-as-path query)', () => {
    const { conn, sent } = capture()
    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ghost' })
    expect(h.listEvents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'wait_user_events', items: [] }])
  })

  it('reports an error when the store is unavailable', () => {
    h.storeAvailable = false
    const { conn, sent } = capture()
    listWaitUserEvents(KCTX, conn, { type: 'list_wait_user_events', workspaceId: 'ws-1' })
    expect(sent).toEqual([{ type: 'error', error: { code: 'waitUserInvolve.dbUnavailable' } }])
    expect(h.listEvents).not.toHaveBeenCalled()
  })
})
