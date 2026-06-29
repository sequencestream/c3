/**
 * Request-side glue for session pagination (SR-R14): which `list_sessions`
 * query each action sends, and the optimistic local mutations for
 * delete/rename (the server no longer pushes a fresh list after those).
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, Discussion, Intent, SessionInfo } from '@ccc/shared/protocol'
import { installSessionActions } from './session-actions'
import type { AppCtx } from './types'
import { sessionCacheKey, type SessionPageKind } from './state'

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

function intent(id: string, extra: Partial<Intent> = {}): Intent {
  return { id, ...extra } as Intent
}

function discussion(id: string, extra: Partial<Discussion> = {}): Discussion {
  return { id, ...extra } as Discussion
}

const WS = '/ws'

function makeCtx(
  opts: {
    sessions?: Record<string, SessionInfo[]>
    paging?: Record<string, { hasMore: boolean; exhausted: boolean; loadingMore: boolean }>
    intents?: Record<string, Intent[]>
    activeKind?: SessionPageKind
  } = {},
) {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const sessionsByWorkspace = ref(opts.sessions ?? {})
  const sessionPagingByWorkspace = ref(opts.paging ?? {})
  const requestedIntentId = ref<string | null>(null)
  const requestedIntentSubTab = ref<'intentSession' | 'specSession' | null>(null)
  const openIntents = vi.fn()
  const openSpecSession = vi.fn()
  const openDiscussions = vi.fn()
  const openDiscussion = vi.fn()
  const ctx = {
    send,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    activeSessionKind: ref(opts.activeKind ?? 'work'),
    intents: ref(opts.intents ?? {}),
    discussions: ref({ [WS]: [discussion('discussion-1')] }),
    requestedIntentId,
    requestedIntentSubTab,
    openIntents,
    openSpecSession,
        openDiscussions,
        openDiscussion,
        openSchedules: vi.fn(),
        onSelectSchedule: vi.fn(),
        selectIntentSession: vi.fn(),
    consoleSession: ref(null),
    activeLinkedScheduleId: ref(null),
  } as unknown as AppCtx
  installSessionActions(ctx)
  return {
    ctx,
    send,
    sessionsByWorkspace,
    openIntents,
    openSpecSession,
    requestedIntentId,
    requestedIntentSubTab,
    openDiscussions,
    openDiscussion,
  }
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
    const { ctx, send } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300), s('b', 200)] },
    })
    ctx.refreshSessions(WS)
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.since).toBe(200)
    expect(msg.before).toBeUndefined()
  })
})

describe('tool session source jump', () => {
  it('routes tool rows with an intent owner without selecting the tool session', () => {
    const tool = {
      ...s('tool-1', 300),
      sessionKind: 'tool',
      ownerKind: 'intent',
      ownerId: 'intent-1',
      isToolSession: true,
    } satisfies SessionInfo
    const { ctx, send, openIntents, requestedIntentId, requestedIntentSubTab } = makeCtx()

    ctx.jumpSessionSource(WS, tool)

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBeNull()
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select_session', sessionId: 'tool-1' }),
    )
  })
})

describe('loadMoreSessions', () => {
  it('sends a keyset `before` cursor of the oldest loaded session', () => {
    const { ctx, send } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300), s('b', 200)] },
      paging: {
        [sessionCacheKey(WS, 'work')]: { hasMore: true, exhausted: false, loadingMore: false },
      },
    })
    ctx.loadMoreSessions(WS)
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.before).toEqual({ lastModified: 200, sessionId: 'b' })
  })

  it('no-ops when there is nothing more, or a load-more is already in flight', () => {
    const noMore = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300)] },
      paging: {
        [sessionCacheKey(WS, 'work')]: { hasMore: false, exhausted: false, loadingMore: false },
      },
    })
    noMore.ctx.loadMoreSessions(WS)
    expect(noMore.send).not.toHaveBeenCalled()

    const inFlight = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300)] },
      paging: {
        [sessionCacheKey(WS, 'work')]: { hasMore: true, exhausted: false, loadingMore: true },
      },
    })
    inFlight.ctx.loadMoreSessions(WS)
    expect(inFlight.send).not.toHaveBeenCalled()
  })
})

describe('optimistic delete / rename', () => {
  it('delete drops the row locally and sends delete_session', () => {
    const { ctx, send, sessionsByWorkspace } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300), s('b', 200)] },
    })
    ctx.deleteSession(WS, 'a')
    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'work')].map((x) => x.sessionId)).toEqual([
      'b',
    ])
    expect(send).toHaveBeenCalledWith({ type: 'delete_session', workspaceId: WS, sessionId: 'a' })
  })

  it('rename updates the title locally and sends rename_session', () => {
    const { ctx, send, sessionsByWorkspace } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'work')]: [s('a', 300)] },
    })
    ctx.renameSession(WS, 'a', 'New Title')
    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'work')][0].title).toBe('New Title')
    expect(send).toHaveBeenCalledWith({
      type: 'rename_session',
      workspaceId: WS,
      sessionId: 'a',
      title: 'New Title',
    })
  })
})

describe('spec session jump-back', () => {
  it('routes a spec projection row with an intent owner to the intent spec session tab', () => {
    const spec = {
      ...s('spec-1', 300),
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    } satisfies SessionInfo
    const { ctx, send, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } =
      makeCtx({
        sessions: { [sessionCacheKey(WS, 'spec')]: [spec] },
        intents: { [WS]: [intent('intent-1')] },
        activeKind: 'spec',
      })

    ctx.selectSession(WS, 'spec-1')

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    expect(openSpecSession).toHaveBeenCalledWith('intent-1')
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select_session', sessionId: 'spec-1' }),
    )
  })

  it('does not open a wrong spec session when the projected owner is missing from a loaded intent list', () => {
    const spec = {
      ...s('spec-1', 300),
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'missing-intent',
    } satisfies SessionInfo
    const { ctx, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } = makeCtx(
      {
        sessions: { [sessionCacheKey(WS, 'spec')]: [spec] },
        intents: { [WS]: [intent('intent-1')] },
        activeKind: 'spec',
      },
    )

    ctx.selectSession(WS, 'spec-1')

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(openSpecSession).not.toHaveBeenCalled()
    expect(requestedIntentId.value).toBeNull()
    expect(requestedIntentSubTab.value).toBeNull()
  })

  it('falls back to legacy specSessionId lookup when owner metadata is absent', () => {
    const spec = { ...s('spec-1', 300), sessionKind: 'spec' } satisfies SessionInfo
    const { ctx, openSpecSession, requestedIntentId, requestedIntentSubTab } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [spec] },
      intents: { [WS]: [intent('intent-1', { specSessionId: 'spec-1' })] },
      activeKind: 'spec',
    })

    ctx.selectSession(WS, 'spec-1')

    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    expect(openSpecSession).toHaveBeenCalledWith('intent-1')
  })
})

describe('discussion session jump-back', () => {
  it('routes a discussion projection row with a discussion owner to the discussion page', () => {
    const row = {
      ...s('discussion-agent-session', 300),
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'discussion-1',
    } satisfies SessionInfo
    const { ctx, send, openDiscussions, openDiscussion } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'discussion')]: [row] },
      activeKind: 'discussion',
    })

    ctx.selectSession(WS, 'discussion-agent-session')

    expect(openDiscussions).toHaveBeenCalledWith(WS)
    expect(openDiscussion).toHaveBeenCalledWith('discussion-1')
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select_session', sessionId: 'discussion-agent-session' }),
    )
  })

  it('does not open a wrong discussion when the projected owner is missing from a loaded list', () => {
    const row = {
      ...s('discussion-agent-session', 300),
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'missing-discussion',
    } satisfies SessionInfo
    const { ctx, openDiscussions, openDiscussion } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'discussion')]: [row] },
      activeKind: 'discussion',
    })

    ctx.selectSession(WS, 'discussion-agent-session')

    expect(openDiscussions).toHaveBeenCalledWith(WS)
    expect(openDiscussion).not.toHaveBeenCalled()
  })
})
