/**
 * Codes 内嵌 ChatColumn 的控制层:openCodes 会话恢复、create/reset 会话、
 * session_selected 落地时的 codesBoundSessionId + localStorage 持久化,以及宽度读写。
 * 复用控制层单一活动会话:Codes 发的就是普通 select_session / create_session。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { installPersistence } from './persistence'
import { installCodesActions } from './codes-actions'
import type { AppCtx } from './types'

const WS = '/ws'

const stored = new Map<string, string>()
const storage = {
  getItem: (k: string): string | null => stored.get(k) ?? null,
  setItem: (k: string, v: string): void => void stored.set(k, v),
  removeItem: (k: string): void => void stored.delete(k),
}
const globalWithStorage = globalThis as { localStorage?: unknown }
let originalStorage: unknown

function makeCtx(activeSessionId: string | null = null) {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const ctx = {
    send,
    // codes file browser state (reset by openCodes on workspace change)
    codesProject: ref<string | null>(null),
    codesDirs: ref<Record<string, unknown[]>>({}),
    codesExpanded: ref<Set<string>>(new Set()),
    codesLoadingDirs: ref<Set<string>>(new Set()),
    codesTabs: ref<unknown[]>([]),
    codesActivePath: ref<string | null>(null),
    codesSearchMode: ref('filename'),
    codesSearchQuery: ref(''),
    codesSearchPattern: ref('*'),
    codesSearchResult: ref<unknown>(null),
    codesSearchLoading: ref(false),
    codesBoundSessionId: ref<Record<string, string>>({}),
    // single active session (shared with Works)
    activeSession: ref<string | null>(activeSessionId),
    activeTab: ref('codes'),
    // persistence deps
    currentWorkspace: ref<string | null>(null),
    intentsProject: ref<string | null>(null),
    discussionsProject: ref<string | null>(null),
    activeDiscussionId: ref<string | null>(null),
    schedulesProject: ref<string | null>(null),
  } as unknown as AppCtx
  installPersistence(ctx)
  installCodesActions(ctx)
  return { ctx, send }
}

function sentOfType(send: ReturnType<typeof vi.fn>, type: string): ClientToServer[] {
  return send.mock.calls.map((c) => c[0] as ClientToServer).filter((m) => m.type === type)
}

describe('codes-actions embedded chat', () => {
  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })
  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('openCodes restores a persisted session via select_session', () => {
    const { ctx, send } = makeCtx('other-session')
    storage.setItem(`c3.codes.${WS}.sessionId`, 'sess-1')

    ctx.openCodes(WS)

    const selects = sentOfType(send, 'select_session')
    expect(selects).toEqual([{ type: 'select_session', workspaceId: WS, sessionId: 'sess-1' }])
    expect(ctx.codesBoundSessionId.value[WS]).toBe('sess-1')
  })

  it('openCodes with no persisted id sends no select_session and keeps the active session', () => {
    const { ctx, send } = makeCtx('works-session')

    ctx.openCodes(WS)

    expect(sentOfType(send, 'select_session')).toHaveLength(0)
    expect(ctx.activeSession.value).toBe('works-session')
    expect(ctx.codesBoundSessionId.value[WS]).toBeUndefined()
  })

  it('createCodesChatSession sends create_session; session_selected persists the binding', () => {
    const { ctx, send } = makeCtx(null)
    ctx.openCodes(WS)

    ctx.createCodesChatSession(WS)
    expect(sentOfType(send, 'create_session')).toEqual([
      { type: 'create_session', workspaceId: WS },
    ])

    // Simulate the server round-trip: session_selected sets the active session.
    ctx.activeSession.value = 'sess-new'

    expect(ctx.codesBoundSessionId.value[WS]).toBe('sess-new')
    expect(storage.getItem(`c3.codes.${WS}.sessionId`)).toBe('sess-new')
  })

  it('a pending session id binds in-memory but is not persisted (waits for the real id)', () => {
    const { ctx } = makeCtx(null)
    ctx.openCodes(WS)

    const pending = `${PENDING_SESSION_PREFIX}tmp`
    ctx.activeSession.value = pending
    // In-memory binding is immediate so chatActive (activeSession===bound) holds and
    // the freshly-created session's input is usable; otherwise it would deadlock.
    expect(ctx.codesBoundSessionId.value[WS]).toBe(pending)
    // But the pending id is never persisted — it won't survive a reconnect.
    expect(storage.getItem(`c3.codes.${WS}.sessionId`)).toBeNull()

    ctx.activeSession.value = 'sess-real'
    expect(ctx.codesBoundSessionId.value[WS]).toBe('sess-real')
    expect(storage.getItem(`c3.codes.${WS}.sessionId`)).toBe('sess-real')
  })

  it('resetCodesChatSession replaces the binding with a freshly created session', () => {
    const { ctx, send } = makeCtx(null)
    ctx.openCodes(WS)
    ctx.activeSession.value = 'sess-old'
    expect(ctx.codesBoundSessionId.value[WS]).toBe('sess-old')

    ctx.resetCodesChatSession(WS)
    expect(sentOfType(send, 'create_session')).toEqual([
      { type: 'create_session', workspaceId: WS },
    ])

    ctx.activeSession.value = 'sess-fresh'
    expect(ctx.codesBoundSessionId.value[WS]).toBe('sess-fresh')
    expect(storage.getItem(`c3.codes.${WS}.sessionId`)).toBe('sess-fresh')
  })

  it('does not persist the codes binding while on another tab', () => {
    const { ctx } = makeCtx(null)
    ctx.openCodes(WS)
    ctx.activeTab.value = 'console'

    ctx.activeSession.value = 'works-session'

    expect(ctx.codesBoundSessionId.value[WS]).toBeUndefined()
    expect(storage.getItem(`c3.codes.${WS}.sessionId`)).toBeNull()
  })

  it('persistCodesChatWidth / readCodesChatWidth round-trip', () => {
    const { ctx } = makeCtx()
    ctx.persistCodesChatWidth(WS, 520)
    expect(ctx.readCodesChatWidth(WS)).toBe(520)
  })
})
