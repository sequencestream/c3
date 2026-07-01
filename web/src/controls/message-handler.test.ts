import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Discussion, ResearchMessage, ServerToClient } from '@ccc/shared/protocol'
import type { SessionInfo } from '@ccc/shared/protocol'
import { installMessageHandler } from './message-handler'
import type { ChatMsg } from '@/lib/chat-types'
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

function error(code: string): ServerToClient {
  return { type: 'error', error: { code, params: {} } } as unknown as ServerToClient
}

function makeCtx() {
  const toast = ref<string | null>(null)
  const intentActionError = ref<string | null>(null)
  const intentActionErrorSeq = ref(0)
  const devLaunch = ref({})
  const specLaunch = ref({})
  const closeDevLaunch = vi.fn()
  const dispatchSpecLaunch = vi.fn()
  const showToast = vi.fn((text: string) => (toast.value = text))
  const showIntentActionError = vi.fn((text: string) => (intentActionError.value = text))
  const scheduleSaving = ref(false)
  const schedules = ref({})
  const schedulesProject = ref<string | null>(null)
  const activeTab = ref<string>('console')
  const selectedScheduleId = ref<string | null>(null)
  // Discussion / research refs touched by discussion_detail + research_message.
  const serverSettings = ref(null)
  const activeDiscussion = ref<Discussion | null>(null)
  const activeDiscussionId = ref<string | null>(null)
  const discussionMessages = ref<ChatMsg[]>([])
  const discussionMaxSeq = ref(0)
  const researchMessages = ref<ChatMsg[]>([])
  const researchMaxSeq = ref(0)
  const persistViewMode = vi.fn()
  const ctx = {
    toast,
    intentActionError,
    intentActionErrorSeq,
    devLaunch,
    specLaunch,
    closeDevLaunch,
    dispatchSpecLaunch,
    showToast,
    showIntentActionError,
    scheduleSaving,
    schedules,
    schedulesProject,
    activeTab,
    selectedScheduleId,
    serverSettings,
    activeDiscussion,
    activeDiscussionId,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    persistViewMode,
    // The handler reads `ctx.t` at install time; a passthrough is enough here.
    t: (key: string) => key,
    add: vi.fn(),
  } as unknown as AppCtx
  installMessageHandler(ctx)
  return {
    ctx,
    toast,
    intentActionError,
    intentActionErrorSeq,
    closeDevLaunch,
    dispatchSpecLaunch,
    showToast,
    showIntentActionError,
    scheduleSaving,
    schedules,
    schedulesProject,
    researchMessages,
    researchMaxSeq,
  }
}

describe('intent action errors', () => {
  it('uses persistent error-dialog state instead of the toast and releases in-flight UI', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('intent.specNotWritten'))

    expect(result.intentActionError.value).toBe(
      'The spec has not been written yet; author it before approving.',
    )
    expect(result.toast.value).toBeNull()
    expect(result.showIntentActionError).toHaveBeenCalledOnce()
    expect(result.showToast).not.toHaveBeenCalled()
    expect(result.intentActionErrorSeq.value).toBe(1)
    expect(result.closeDevLaunch).toHaveBeenCalledOnce()
    expect(result.dispatchSpecLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed' }),
    )
  })

  it('keeps non-intent errors out of the persistent error-dialog state', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('workspace.unknown'))

    expect(result.intentActionError.value).toBeNull()
    expect(result.showIntentActionError).not.toHaveBeenCalled()
    expect(result.intentActionErrorSeq.value).toBe(0)
  })
})

describe('schedule save overlay message handler', () => {
  it('clears scheduleSaving on schedules broadcast', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage({
      type: 'schedules',
      workspaceId: 'ws1',
      items: [],
    } as unknown as ServerToClient)

    expect(result.scheduleSaving.value).toBe(false)
  })

  it('clears scheduleSaving on schedule error', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage(error('schedule.agentRequired'))

    expect(result.scheduleSaving.value).toBe(false)
  })

  it('clears scheduleSaving on generic error', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage(error('workspace.unknown'))

    expect(result.scheduleSaving.value).toBe(false)
  })
})

describe('sessions handler — kind-switch pendingConsoleBind', () => {
  const WS = '/ws'

  function makeSessionsCtx() {
    const bindConsoleSession = vi.fn()
    const clearViewedSession = vi.fn()
    const consumePendingWorkSessionSelect = vi.fn()
    const activeSession = ref<string | null>(null)
    const activeWorkspace = ref<string | null>(null)
    const activeTitle = ref('')
    const activeVendor = ref<'claude' | 'codex' | null>(null)
    const activity = ref({ phase: 'idle' } as { phase: string })
    const currentWorkspace = ref<string | null>(null)
    const consoleSession = ref<{ workspacePath: string; sessionId: string } | null>(null)
    const activeSessionKind = ref<SessionPageKind>('work')
    const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
    const sessionPagingByWorkspace = ref<
      Record<
        string,
        { hasMore: boolean; exhausted: boolean; loadingMore: boolean; pendingSince?: number }
      >
    >({})
    const sessionCounts = ref<Record<string, number>>({})
    const activeTab = ref<string>('console')
    const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }
    const send = vi.fn()
    const ctx = {
      toast: ref<string | null>(null),
      intentActionError: ref<string | null>(null),
      intentActionErrorSeq: ref(0),
      devLaunch: ref({}),
      specLaunch: ref({}),
      closeDevLaunch: vi.fn(),
      dispatchSpecLaunch: vi.fn(),
      showToast: vi.fn(),
      showIntentActionError: vi.fn(),
      scheduleSaving: ref(false),
      schedules: ref({}),
      schedulesProject: ref<string | null>(null),
      activeTab,
      selectedScheduleId: ref<string | null>(null),
      serverSettings: ref(null),
      activeDiscussion: ref(null),
      activeDiscussionId: ref<string | null>(null),
      discussionMessages: ref<ChatMsg[]>([]),
      discussionMaxSeq: ref(0),
      researchMessages: ref<ChatMsg[]>([]),
      researchMaxSeq: ref(0),
      persistViewMode: vi.fn(),
      t: (key: string) => key,
      add: vi.fn(),
      // Session state
      currentWorkspace,
      sessionsByWorkspace,
      sessionPagingByWorkspace,
      sessionCounts,
      activeSessionKind,
      activeWorkspace,
      activeSession,
      activeTitle,
      activeVendor,
      consoleSession,
      activity,
      flags,
      send,
      bindConsoleSession,
      clearViewedSession,
      consumePendingWorkSessionSelect,
    } as unknown as AppCtx
    installMessageHandler(ctx)
    return {
      ctx,
      bindConsoleSession,
      clearViewedSession,
      consumePendingWorkSessionSelect,
      activeSession,
      activeTitle,
      activeVendor,
      currentWorkspace,
      consoleSession,
      activeSessionKind,
      sessionsByWorkspace,
      flags,
    }
  }

  it('selects the first session after a kind switch when the list is non-empty', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'spec',
      sessions: [s('spec-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('keeps right column empty when the new kind list is empty', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'intent'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'intent',
      sessions: [],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('does not consume the flag when sessionKind does not match activeSessionKind', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.flags.pendingConsoleBind = true

    // List response for 'work' kind arrives while activeSessionKind is 'spec'.
    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).not.toHaveBeenCalled()
    expect(r.flags.pendingConsoleBind).toBe(true)
  })

  it('does not consume the flag on a live fan-out push', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'work'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('live-1', 500)],
      page: { kind: 'live', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).not.toHaveBeenCalled()
    expect(r.flags.pendingConsoleBind).toBe(true)
  })

  it('workspace switch still consumes the flag with the sessionKind guard', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'work'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('keeps the pinned console session appended when it is outside the first page', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.consoleSession.value = { workspacePath: WS, sessionId: 'deep-spec' }
    r.activeSession.value = 'deep-spec'
    r.activeTitle.value = 'Deep Spec'
    r.activeVendor.value = 'codex'

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'spec',
      sessions: [s('homepage-spec', 400)],
      page: { kind: 'first', hasMore: true },
    } as unknown as ServerToClient)

    expect(
      r.sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')].map((x) => x.sessionId),
    ).toEqual(['homepage-spec', 'deep-spec'])
    expect(r.sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')][1]).toMatchObject({
      sessionId: 'deep-spec',
      title: 'Deep Spec',
      vendor: 'codex',
      sessionKind: 'spec',
      ownerKind: 'intent',
      state: 'stale',
    })
  })

  it('does not append the pinned console session to a non-active session kind response', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.consoleSession.value = { workspacePath: WS, sessionId: 'deep-spec' }

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(
      r.sessionsByWorkspace.value[sessionCacheKey(WS, 'work')].map((x) => x.sessionId),
    ).toEqual(['work-1'])
  })
})

describe('mid-research reconnect (discussion_detail snapshot + live research_message)', () => {
  function detail(researchMessages: ResearchMessage[]): ServerToClient {
    return {
      type: 'discussion_detail',
      discussion: { id: 'd1' } as Discussion,
      messages: [],
      researchMessages,
    } as ServerToClient
  }
  function rmsg(over: Partial<ResearchMessage>): ResearchMessage {
    return { discussionId: 'd1', createdAt: 0, ...over } as ResearchMessage
  }

  it('restores the already-shown research transcript as standard transcript items', () => {
    const r = makeCtx()
    r.ctx.handleMessage(
      detail([
        rmsg({ seq: 1, kind: 'text', text: 'thinking…' }),
        rmsg({ seq: 2, kind: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { path: 'a' } }),
        rmsg({ seq: 3, kind: 'tool_result', toolUseId: 'u1', content: 'body', isError: false }),
      ]),
    )
    expect(r.researchMessages.value.map((m) => m.kind)).toEqual([
      'assistant',
      'tool-use',
      'tool-result',
    ])
    expect(r.researchMaxSeq.value).toBe(3)
  })

  it('appends a later live research_message and ignores a duplicate/earlier seq', () => {
    const r = makeCtx()
    r.ctx.handleMessage(detail([rmsg({ seq: 1, kind: 'text', text: 'first' })]))
    expect(r.researchMaxSeq.value).toBe(1)

    // Later seq → appended.
    r.ctx.handleMessage({
      type: 'research_message',
      discussionId: 'd1',
      message: rmsg({
        seq: 2,
        kind: 'tool_use',
        toolUseId: 'u9',
        toolName: 'Grep',
        input: { pattern: 'x' },
      }),
    } as ServerToClient)
    expect(r.researchMessages.value.length).toBe(2)
    expect(r.researchMaxSeq.value).toBe(2)

    // Duplicate seq (already shown via snapshot) → ignored.
    r.ctx.handleMessage({
      type: 'research_message',
      discussionId: 'd1',
      message: rmsg({ seq: 2, kind: 'text', text: 'dup' }),
    } as ServerToClient)
    expect(r.researchMessages.value.length).toBe(2)
    expect(r.researchMaxSeq.value).toBe(2)
  })
})
