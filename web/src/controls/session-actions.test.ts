/**
 * Request-side glue for session pagination (SR-R14): which `list_sessions`
 * query each action sends, and the optimistic local mutations for
 * delete/rename (the server no longer pushes a fresh list after those).
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, SessionInfo } from '@ccc/shared/protocol'
import { installSessionActions } from './session-actions'
import type { AppCtx } from './types'

function s(id: string, lastModified: number): SessionInfo {
  return {
    sessionId: id,
    title: id,
    lastModified,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  }
}

const WS = '/ws'

function makeCtx(opts: {
  sessions?: Record<string, SessionInfo[]>
  paging?: Record<string, { hasMore: boolean; exhausted: boolean; loadingMore: boolean }>
}) {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const sessionsByWorkspace = ref(opts.sessions ?? {})
  const sessionPagingByWorkspace = ref(opts.paging ?? {})
  const ctx = {
    send,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    consoleSession: ref(null),
  } as unknown as AppCtx
  installSessionActions(ctx)
  return { ctx, send, sessionsByWorkspace }
}

describe('refreshSessions', () => {
  it('first page (limit) when the workspace is not yet loaded', () => {
    const { ctx, send } = makeCtx({})
    ctx.refreshSessions(WS)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list_sessions', workspaceId: WS }),
    )
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.before).toBeUndefined()
    expect(msg.since).toBeUndefined()
    expect(typeof msg.limit).toBe('number')
  })

  it('window refresh (since = oldest loaded) when a window is loaded', () => {
    const { ctx, send } = makeCtx({ sessions: { [WS]: [s('a', 300), s('b', 200)] } })
    ctx.refreshSessions(WS)
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.since).toBe(200)
    expect(msg.before).toBeUndefined()
  })
})

describe('loadMoreSessions', () => {
  it('sends a keyset `before` cursor of the oldest loaded session', () => {
    const { ctx, send } = makeCtx({
      sessions: { [WS]: [s('a', 300), s('b', 200)] },
      paging: { [WS]: { hasMore: true, exhausted: false, loadingMore: false } },
    })
    ctx.loadMoreSessions(WS)
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.before).toEqual({ lastModified: 200, sessionId: 'b' })
  })

  it('no-ops when there is nothing more, or a load-more is already in flight', () => {
    const noMore = makeCtx({
      sessions: { [WS]: [s('a', 300)] },
      paging: { [WS]: { hasMore: false, exhausted: false, loadingMore: false } },
    })
    noMore.ctx.loadMoreSessions(WS)
    expect(noMore.send).not.toHaveBeenCalled()

    const inFlight = makeCtx({
      sessions: { [WS]: [s('a', 300)] },
      paging: { [WS]: { hasMore: true, exhausted: false, loadingMore: true } },
    })
    inFlight.ctx.loadMoreSessions(WS)
    expect(inFlight.send).not.toHaveBeenCalled()
  })
})

describe('optimistic delete / rename', () => {
  it('delete drops the row locally and sends delete_session', () => {
    const { ctx, send, sessionsByWorkspace } = makeCtx({
      sessions: { [WS]: [s('a', 300), s('b', 200)] },
    })
    ctx.deleteSession(WS, 'a')
    expect(sessionsByWorkspace.value[WS].map((x) => x.sessionId)).toEqual(['b'])
    expect(send).toHaveBeenCalledWith({ type: 'delete_session', workspaceId: WS, sessionId: 'a' })
  })

  it('rename updates the title locally and sends rename_session', () => {
    const { ctx, send, sessionsByWorkspace } = makeCtx({
      sessions: { [WS]: [s('a', 300)] },
    })
    ctx.renameSession(WS, 'a', 'New Title')
    expect(sessionsByWorkspace.value[WS][0].title).toBe('New Title')
    expect(send).toHaveBeenCalledWith({
      type: 'rename_session',
      workspaceId: WS,
      sessionId: 'a',
      title: 'New Title',
    })
  })
})
