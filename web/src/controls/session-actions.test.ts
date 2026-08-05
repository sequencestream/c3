/**
 * Request-side glue for session pagination (SR-R14): which `list_sessions`
 * query each action sends, and the optimistic local mutations for
 * delete/rename (the server no longer pushes a fresh list after those).
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, Discussion, Intent, SessionInfo } from '@ccc/shared/protocol'
import { installIntentActions } from './intent-actions'
import { installSessionActions } from './session-actions'
import { resolveSessionSourceAction } from '@/lib/session-jump'
import type { PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
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
    /** Install the real intent actions so `openIntents` is the production entry. */
    wireIntents?: boolean
  } = {},
) {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const sessionsByWorkspace = ref(opts.sessions ?? {})
  const sessionPagingByWorkspace = ref(opts.paging ?? {})
  const requestedIntentId = ref<string | null>(null)
  const requestedIntentSubTab = ref<'intentSession' | 'specSession' | 'specReviewSession' | null>(
    null,
  )
  const requestedMergedTab = ref<'list' | 'sessions' | null>(null)
  const requestedIntentSessionId = ref<string | null>(null)
  const selectedIntentSessionId = ref<string | null>(null)
  const requestedWorkSessionId = ref<PendingWorkSessionSelectRequest | null>(null)
  const activeTab = ref('intents')
  const activeSession = ref<string | null>(null)
  const activeWorkspace = ref<string | null>(null)
  const consoleSession = ref<{ workspacePath: string; sessionId: string } | null>(null)
  const activeSessionSource = ref<ReturnType<typeof resolveSessionSourceAction>>(null)
  const openIntents = vi.fn()
  const openSpecSession = vi.fn()
  const openSpecReviewSession = vi.fn()
  const showToast = vi.fn()
  const activeSessionRealKind = ref<SessionInfo['sessionKind'] | null>(null)
  const openDiscussions = vi.fn()
  const openDiscussion = vi.fn()
  const openAutomations = vi.fn()
  const onSelectAutomation = vi.fn()
  const selectIntentSession = vi.fn()
  const persistViewMode = vi.fn()
  const persistCurrentWorkspace = vi.fn()
  const currentWorkspace = ref<string | null>(null)
  const intentsProject = ref<string | null>(null)
  const workspaceSettingOpen = ref(false)
  const currentWorkspaceSetting = ref<unknown>(null)
  const detectedMainBranch = ref<string | null>(null)
  const resolvedSpecRoot = ref<string | null>(null)
  const sysExtraMounts = ref<unknown[]>([])
  // Read-only observation refs the workspace switch / reconnect paths clear.
  const parkRecoveryStats = ref<import('@ccc/shared/protocol').ParkRecoveryStats | null>(null)
  const parkRecoveryError = ref<import('@ccc/shared/ui-codes').UiError | null>(null)
  const parkRecoveryLoading = ref(false)
  const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }
  const activeTitle = ref('')
  const activeVendor = ref<string | null>(null)
  const activeAgentSwitch = ref<{ current: string; candidates: string[] } | null>(null)
  const messages = ref<unknown[]>([])
  const counters = { nextId: 1, nextQueueId: 1 }
  const availableCommands = ref<unknown[]>([])
  const activity = ref<{ phase: string }>({ phase: 'idle' })
  const taskModel = ref<unknown>(null)
  const ctx = {
    send,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    activeSessionKind: ref(opts.activeKind ?? 'work'),
    intents: ref(opts.intents ?? {}),
    discussions: ref({ [WS]: [discussion('discussion-1')] }),
    requestedIntentId,
    requestedIntentSubTab,
    requestedMergedTab,
    requestedIntentSessionId,
    requestedWorkSessionId,
    activeTab,
    activeSession,
    activeWorkspace,
    consoleSession,
    activeSessionSource,
    activeTitle,
    activeVendor,
    activeAgentSwitch,
    messages,
    counters,
    availableCommands,
    activity,
    taskModel,
    selectedIntentSessionId,
    openIntents,
    openSpecSession,
    openSpecReviewSession,
    showToast,
    activeSessionRealKind,
    t: (key: string) => key,
    openDiscussions,
    openDiscussion,
    openAutomations,
    onSelectAutomation,
    selectIntentSession,
    persistViewMode,
    persistCurrentWorkspace,
    currentWorkspace,
    intentsProject,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    parkRecoveryStats,
    parkRecoveryError,
    parkRecoveryLoading,
    flags,
    currentSessions: ref([]),
  } as unknown as AppCtx
  installSessionActions(ctx)
  // The workspace switch lands on the intents tab through `openIntents`; wiring
  // the real intent actions keeps that hand-off under test instead of a stub.
  if (opts.wireIntents) installIntentActions(ctx)
  return {
    ctx,
    send,
    intentsProject,
    workspaceSettingOpen,
    persistViewMode,
    sessionsByWorkspace,
    activeTab,
    activeSession,
    activeWorkspace,
    consoleSession,
    activeSessionSource,
    openIntents,
    openSpecSession,
    openSpecReviewSession,
    showToast,
    activeSessionRealKind,
    requestedIntentId,
    requestedIntentSubTab,
    requestedMergedTab,
    requestedIntentSessionId,
    openDiscussions,
    openDiscussion,
    openAutomations,
    onSelectAutomation,
    selectIntentSession,
    persistCurrentWorkspace,
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

// Switching the current workspace lands on the intents tab: the user picks a
// work unit first, then decides which intent / session to enter.
describe('selectWorkspace', () => {
  const OTHER = '/ws-other'

  it('切到不同工作区 → 落意图 tab、意图指向新工作区、清理会话查看态并强制刷新会话列表', () => {
    const h = makeCtx({ wireIntents: true, activeKind: 'work' })
    h.ctx.currentWorkspace.value = WS
    h.activeTab.value = 'console'
    h.consoleSession.value = { workspacePath: WS, sessionId: 'work-1' }
    h.workspaceSettingOpen.value = true

    h.ctx.selectWorkspace(OTHER)

    expect(h.ctx.currentWorkspace.value).toBe(OTHER)
    expect(h.persistCurrentWorkspace).toHaveBeenCalled()
    expect(h.activeTab.value).toBe('intents')
    expect(h.intentsProject.value).toBe(OTHER)
    expect(h.persistViewMode).toHaveBeenCalled()
    // Workspace setting overlay + console pointer belong to the old workspace.
    expect(h.workspaceSettingOpen.value).toBe(false)
    expect(h.consoleSession.value).toBeNull()
    expect(h.ctx.flags.pendingConsoleBind).toBe(true)
    // Intents entry contract + the target workspace's forced session refresh.
    expect(h.send).toHaveBeenCalledWith({ type: 'open_intent_session', workspaceId: OTHER })
    expect(h.send).toHaveBeenCalledWith({ type: 'list_intent_sessions', workspaceId: OTHER })
    expect(h.send).toHaveBeenCalledWith({ type: 'load_workspace_setting', workspaceId: OTHER })
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list_sessions', workspaceId: OTHER }),
    )
  })

  it('从无当前工作区切入 → 同样落意图 tab', () => {
    const h = makeCtx({ wireIntents: true })
    h.activeTab.value = 'console'

    h.ctx.selectWorkspace(WS)

    expect(h.ctx.currentWorkspace.value).toBe(WS)
    expect(h.activeTab.value).toBe('intents')
    expect(h.intentsProject.value).toBe(WS)
  })

  it('重复选择当前工作区 → no-op:不切 tab、不改指针、不刷新、不持久化', () => {
    const h = makeCtx({ wireIntents: true })
    h.ctx.currentWorkspace.value = WS
    h.activeTab.value = 'console'
    h.consoleSession.value = { workspacePath: WS, sessionId: 'work-1' }

    h.ctx.selectWorkspace(WS)

    expect(h.activeTab.value).toBe('console')
    expect(h.intentsProject.value).toBeNull()
    expect(h.consoleSession.value).toEqual({ workspacePath: WS, sessionId: 'work-1' })
    expect(h.ctx.flags.pendingConsoleBind).toBe(false)
    expect(h.persistCurrentWorkspace).not.toHaveBeenCalled()
    expect(h.persistViewMode).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('selectSessionKind', () => {
  it('clears view + consoleSession, sets kind, flags pending bind, and refreshes list for the new kind', () => {
    const { ctx, send } = makeCtx({ activeKind: 'work' })
    ctx.currentWorkspace.value = WS
    // Prime sessions for the old kind to confirm the list_sessions is for the new kind.
    ctx.sessionsByWorkspace.value[sessionCacheKey(WS, 'work')] = [s('work-1', 400)]
    // Simulate a previously-viewed session that must be dropped.
    ctx.consoleSession.value = { workspacePath: WS, sessionId: 'work-1' }

    ctx.selectSessionKind('spec')

    expect(ctx.activeSessionKind.value).toBe('spec')
    expect(ctx.consoleSession.value).toBeNull()
    expect(ctx.activeSession.value).toBeNull()
    expect(ctx.activeWorkspace.value).toBeNull()
    expect(ctx.flags.pendingConsoleBind).toBe(true)
    // Should send list_sessions for the NEW kind, not the old work sessions.
    const msg = send.mock.calls[0][0] as Extract<ClientToServer, { type: 'list_sessions' }>
    expect(msg.sessionKind).toBe('spec')
    expect(msg.workspaceId).toBe(WS)
  })

  it('does not crash when currentWorkspace is null (no list to refresh)', () => {
    const { ctx } = makeCtx({ activeKind: 'work' })
    ctx.consoleSession.value = { workspacePath: WS, sessionId: 'work-1' }

    // currentWorkspace is null, so refreshSessions returns early — should not throw.
    ctx.selectSessionKind('tool')

    expect(ctx.activeSessionKind.value).toBe('tool')
    expect(ctx.consoleSession.value).toBeNull()
    expect(ctx.activeSession.value).toBeNull()
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

// A row click is now always "view this session in the right column" — no
// business-page jump branch for any session kind. The source jump moved to the
// title-bar button (see `jumpActiveSessionSource` below).
describe('selectSession shows the session in the chat column', () => {
  it.each([
    ['spec', 'spec', 'intent', 'intent-1'],
    ['discussion', 'discussion', 'discussion', 'discussion-1'],
    ['automation', 'automation', 'automation', 'automation-1'],
    ['intent', 'intent', 'intent', 'intent-1'],
  ] as const)(
    'enters the console and selects a %s owner row instead of opening its business page',
    (kind, sessionKind, ownerKind, ownerId) => {
      const row = {
        ...s(`${kind}-1`, 300),
        sessionKind,
        ownerKind,
        ownerId,
      } satisfies SessionInfo
      const {
        ctx,
        send,
        activeTab,
        consoleSession,
        openIntents,
        openDiscussions,
        openAutomations,
      } = makeCtx({
        sessions: { [sessionCacheKey(WS, kind)]: [row] },
        intents: { [WS]: [intent('intent-1')] },
        activeKind: kind,
      })

      ctx.selectSession(WS, `${kind}-1`)

      expect(activeTab.value).toBe('console')
      expect(consoleSession.value).toEqual({ workspacePath: WS, sessionId: `${kind}-1` })
      expect(send).toHaveBeenCalledWith({
        type: 'select_session',
        workspaceId: WS,
        sessionId: `${kind}-1`,
      })
      expect(openIntents).not.toHaveBeenCalled()
      expect(openDiscussions).not.toHaveBeenCalled()
      expect(openAutomations).not.toHaveBeenCalled()
    },
  )

  it('does not re-send select_session when the row is already the active session', () => {
    const row = { ...s('spec-1', 300), sessionKind: 'spec' } satisfies SessionInfo
    const { ctx, send, activeSession, consoleSession } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [row] },
      activeKind: 'spec',
    })
    activeSession.value = 'spec-1'

    ctx.selectSession(WS, 'spec-1')

    // Console pointer still pinned, but no redundant select_session round-trip.
    expect(consoleSession.value).toEqual({ workspacePath: WS, sessionId: 'spec-1' })
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select_session', sessionId: 'spec-1' }),
    )
  })
})

describe('openWorkcenterSession', () => {
  it('switches to the source session kind, appends a missing target row, and selects it', () => {
    const { ctx, send, sessionsByWorkspace, consoleSession, persistCurrentWorkspace } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [s('visible-1', 300)] },
      activeKind: 'work',
    })

    ctx.openWorkcenterSession({
      workspaceId: WS,
      sessionKind: 'spec',
      sessionId: 'deep-spec',
      title: 'Spec gate',
      updatedAt: 123,
    })

    expect(ctx.currentWorkspace.value).toBe(WS)
    expect(persistCurrentWorkspace).toHaveBeenCalled()
    expect(ctx.activeSessionKind.value).toBe('spec')
    expect(ctx.flags.pendingConsoleBind).toBe(false)
    expect(ctx.activeTab.value).toBe('console')
    expect(consoleSession.value).toEqual({ workspacePath: WS, sessionId: 'deep-spec' })
    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')].map((x) => x.sessionId)).toEqual([
      'visible-1',
      'deep-spec',
    ])
    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')][1]).toMatchObject({
      sessionId: 'deep-spec',
      title: 'Spec gate',
      lastModified: 123,
      sessionKind: 'spec',
      ownerKind: 'intent',
      state: 'stale',
    })
    expect(send).toHaveBeenCalledWith({
      type: 'list_sessions',
      workspaceId: WS,
      sessionKind: 'spec',
      limit: expect.any(Number),
    })
    expect(send).toHaveBeenCalledWith({
      type: 'select_session',
      workspaceId: WS,
      sessionId: 'deep-spec',
    })
  })

  it('does not duplicate a target already present in the left list', () => {
    const { ctx, sessionsByWorkspace } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'intent')]: [s('intent-1', 300)] },
      activeKind: 'work',
    })

    ctx.openWorkcenterSession({
      workspaceId: WS,
      sessionKind: 'intent',
      sessionId: 'intent-1',
      title: 'Ignored',
      updatedAt: 123,
    })

    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'intent')]).toHaveLength(1)
  })

  it('maps consensus events to the tool session list', () => {
    const { ctx, send, sessionsByWorkspace } = makeCtx({ activeKind: 'work' })

    ctx.openWorkcenterSession({
      workspaceId: WS,
      sessionKind: 'consensus',
      sessionId: 'consensus-1',
      title: 'Consensus',
      updatedAt: 10,
    })

    expect(ctx.activeSessionKind.value).toBe('tool')
    expect(sessionsByWorkspace.value[sessionCacheKey(WS, 'tool')][0]).toMatchObject({
      sessionId: 'consensus-1',
      sessionKind: 'tool',
      isToolSession: true,
    })
    expect(send).toHaveBeenCalledWith({
      type: 'list_sessions',
      workspaceId: WS,
      sessionKind: 'tool',
      limit: expect.any(Number),
    })
  })

  it('clears the chat column when the WorkCenter event has no session id', () => {
    const { ctx, send, consoleSession } = makeCtx({ activeKind: 'work' })
    ctx.activeSession.value = 'old'
    ctx.activeWorkspace.value = WS

    ctx.openWorkcenterSession({
      workspaceId: WS,
      sessionKind: 'discussion',
      sessionId: null,
    })

    expect(ctx.activeSessionKind.value).toBe('discussion')
    expect(consoleSession.value).toBeNull()
    expect(ctx.activeSession.value).toBeNull()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select_session' }))
  })
})

// The title-bar source button reuses the same resolver-driven open logic that the
// (legacy) row jump used, but reads the active session's derived source target.
describe('jumpActiveSessionSource — title-bar source button', () => {
  function setup(
    sessionKind: SessionInfo['sessionKind'],
    ownerKind: SessionInfo['ownerKind'],
    ownerId: string,
    sessionId: string,
  ) {
    const ctxBag = makeCtx({ intents: { [WS]: [intent(ownerId)] } })
    ctxBag.activeWorkspace.value = WS
    ctxBag.activeSession.value = sessionId
    ctxBag.activeSessionSource.value = resolveSessionSourceAction({
      sessionKind,
      ownerKind,
      ownerId,
    })
    return ctxBag
  }

  it('routes a spec session to the intent spec session tab', () => {
    const { ctx, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } = setup(
      'spec',
      'intent',
      'intent-1',
      'spec-1',
    )

    ctx.jumpActiveSessionSource()

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    expect(openSpecSession).toHaveBeenCalledWith('intent-1')
  })

  it('routes an owned intent comm session to its intent detail session tab', () => {
    const {
      ctx,
      openIntents,
      requestedIntentId,
      requestedIntentSubTab,
      requestedMergedTab,
      selectIntentSession,
    } = setup('intent', 'intent', 'intent-1', 'intent-session-1')

    ctx.jumpActiveSessionSource()

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBe('intentSession')
    expect(requestedMergedTab.value).toBeNull()
    expect(selectIntentSession).not.toHaveBeenCalled()
  })

  it('shows no source button for a standalone intent (chat) session with no owning intent', () => {
    const { ctx, openIntents, selectIntentSession, activeSessionSource } = setup(
      'intent',
      null,
      '',
      'standalone-chat-1',
    )

    // No owning intent ⇒ no resolved source ⇒ button hidden and jump is a no-op.
    expect(activeSessionSource.value).toBeNull()
    ctx.jumpActiveSessionSource()

    expect(openIntents).not.toHaveBeenCalled()
    expect(selectIntentSession).not.toHaveBeenCalled()
  })

  it('routes a discussion session to the discussion page', () => {
    const { ctx, openDiscussions, openDiscussion } = setup(
      'discussion',
      'discussion',
      'discussion-1',
      'discussion-session-1',
    )

    ctx.jumpActiveSessionSource()

    expect(openDiscussions).toHaveBeenCalledWith(WS)
    expect(openDiscussion).toHaveBeenCalledWith('discussion-1')
  })

  it('routes a automation session to the automations page', () => {
    const { ctx, openAutomations, onSelectAutomation } = setup(
      'automation',
      'automation',
      'automation-1',
      'automation-session-1',
    )

    ctx.jumpActiveSessionSource()

    expect(openAutomations).toHaveBeenCalledWith(WS)
    expect(onSelectAutomation).toHaveBeenCalledWith('automation-1')
  })

  it('routes a work/tool owner via the resolver target (generic trace)', () => {
    const { ctx, openIntents, requestedIntentId } = setup('work', 'intent', 'intent-1', 'work-1')

    ctx.jumpActiveSessionSource()

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
  })

  it('no-ops when the active session has no resolvable source', () => {
    const { ctx, openIntents, openDiscussions, openAutomations } = setup(
      'work',
      null,
      '',
      'plain-1',
    )

    ctx.jumpActiveSessionSource()

    expect(openIntents).not.toHaveBeenCalled()
    expect(openDiscussions).not.toHaveBeenCalled()
    expect(openAutomations).not.toHaveBeenCalled()
  })
})

// A spec_review row is listed under the aggregated「规范」entry but must never be
// restored through the generic `select_session` (whose cold path builds a writable
// `work` runtime). It routes to the intent-resolved review open, or is refused.
describe('selectSession — spec_review rows', () => {
  function reviewRow(extra: Partial<SessionInfo> = {}): SessionInfo {
    return {
      ...s('rev-1', 300),
      sessionKind: 'spec_review',
      ownerKind: 'intent',
      ownerId: 'intent-1',
      ...extra,
    } as SessionInfo
  }

  it('sends open_spec_review_session with the row owner, never select_session', () => {
    const { ctx, send, openSpecReviewSession, activeTab, consoleSession } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [reviewRow()] },
      activeKind: 'spec',
    })

    ctx.selectSession(WS, 'rev-1', reviewRow())

    expect(openSpecReviewSession).toHaveBeenCalledWith('intent-1', WS)
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select_session' }))
    // 仍留在会话页并绑定右栏控制台指针。
    expect(activeTab.value).toBe('console')
    expect(consoleSession.value).toEqual({ workspacePath: WS, sessionId: 'rev-1' })
  })

  it('routes by the row even when the caller passes only an id (deep link / pending select)', () => {
    const { ctx, send, openSpecReviewSession } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [reviewRow()] },
      activeKind: 'spec',
    })

    ctx.selectSession(WS, 'rev-1')

    expect(openSpecReviewSession).toHaveBeenCalledWith('intent-1', WS)
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select_session' }))
  })

  it.each([
    ['missing owner id', { ownerId: null }],
    ['non-intent owner', { ownerKind: 'discussion' as const, ownerId: 'd-1' }],
  ])('refuses an unattributable review row (%s) without falling back', (_label, extra) => {
    const { ctx, send, openSpecReviewSession, showToast, consoleSession } = makeCtx({
      activeKind: 'spec',
    })

    ctx.selectSession(WS, 'rev-1', reviewRow(extra))

    expect(openSpecReviewSession).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select_session' }))
    expect(showToast).toHaveBeenCalledTimes(1)
    // 失败不改变当前活动会话 / 控制台指针。
    expect(consoleSession.value).toBeNull()
  })

  it('leaves a spec authoring row on the generic select path', () => {
    const specRow = { ...s('spec-1', 300), sessionKind: 'spec' } as SessionInfo
    const { ctx, send, openSpecReviewSession } = makeCtx({
      sessions: { [sessionCacheKey(WS, 'spec')]: [specRow] },
      activeKind: 'spec',
    })

    ctx.selectSession(WS, 'spec-1', specRow)

    expect(openSpecReviewSession).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      type: 'select_session',
      workspaceId: WS,
      sessionId: 'spec-1',
    })
  })
})

describe('jump-to-source — spec_review', () => {
  it('routes a review row to its intent detail review tab and opens it', () => {
    const { ctx, openIntents, openSpecReviewSession, requestedIntentId, requestedIntentSubTab } =
      makeCtx({ intents: { [WS]: [intent('intent-1')] } })

    ctx.jumpSessionSource(WS, {
      ...s('rev-1', 300),
      sessionKind: 'spec_review',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    } as SessionInfo)

    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(requestedIntentSubTab.value).toBe('specReviewSession')
    expect(openSpecReviewSession).toHaveBeenCalledWith('intent-1', WS)
  })

  it('routes the active review session title bar to the same target', () => {
    const bag = makeCtx({ intents: { [WS]: [intent('intent-1')] } })
    bag.activeWorkspace.value = WS
    bag.activeSession.value = 'rev-1'
    bag.activeSessionSource.value = resolveSessionSourceAction({
      sessionKind: 'spec_review',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    })

    bag.ctx.jumpActiveSessionSource()

    expect(bag.requestedIntentSubTab.value).toBe('specReviewSession')
    expect(bag.openSpecReviewSession).toHaveBeenCalledWith('intent-1', WS)
    expect(bag.openSpecSession).not.toHaveBeenCalled()
  })
})
