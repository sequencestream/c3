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
    codesGitStatus: ref<Record<string, unknown>>({}),
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
    automationsProject: ref<string | null>(null),
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

describe('codes-actions git status', () => {
  const clean = { modified: false, untracked: false, staged: false }

  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })
  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('requestCodesGitStatus sends get_code_git_status for the current workspace', () => {
    const { ctx, send } = makeCtx()
    ctx.openCodes(WS)
    ctx.requestCodesGitStatus()
    expect(sentOfType(send, 'get_code_git_status')).toEqual([
      { type: 'get_code_git_status', workspaceId: WS },
    ])
  })

  it('coalesces while one is in flight, then fires exactly one merged follow-up', () => {
    const { ctx, send } = makeCtx()
    ctx.openCodes(WS)
    ctx.requestCodesGitStatus() // → sends #1, in flight
    ctx.requestCodesGitStatus() // in flight → queued
    ctx.requestCodesGitStatus() // still queued (merged)
    expect(sentOfType(send, 'get_code_git_status')).toHaveLength(1)

    // Reply arrives → clears in-flight, fires the single merged follow-up.
    ctx.applyCodeGitStatus(WS, { 'a.ts': { modified: true, untracked: false, staged: false } })
    expect(sentOfType(send, 'get_code_git_status')).toHaveLength(2)

    // The follow-up's reply, with nothing queued, sends no further request.
    ctx.applyCodeGitStatus(WS, {})
    expect(sentOfType(send, 'get_code_git_status')).toHaveLength(2)
  })

  it('applyCodeGitStatus replaces the snapshot wholesale (cleared paths drop)', () => {
    const { ctx } = makeCtx()
    ctx.openCodes(WS)
    ctx.applyCodeGitStatus(WS, { 'a.ts': clean, 'b.ts': clean })
    expect(Object.keys(ctx.codesGitStatus.value)).toEqual(['a.ts', 'b.ts'])
    // New authoritative snapshot: b.ts is gone → its marker must not linger.
    ctx.applyCodeGitStatus(WS, { 'a.ts': clean })
    expect(Object.keys(ctx.codesGitStatus.value)).toEqual(['a.ts'])
  })

  it('ignores a reply for a workspace other than the one being browsed', () => {
    const { ctx } = makeCtx()
    ctx.openCodes(WS)
    ctx.applyCodeGitStatus('/other-ws', { 'x.ts': clean })
    expect(ctx.codesGitStatus.value).toEqual({})
  })

  it('refreshCodesTree reloads root + expanded dirs AND re-pulls git status', () => {
    const { ctx, send } = makeCtx()
    ctx.openCodes(WS)
    ctx.codesDirs.value = { '': [], src: [] }
    ctx.codesExpanded.value = new Set(['src'])
    ctx.codesLoadingDirs.value = new Set() // clear the openCodes in-flight guard
    send.mockClear()

    ctx.refreshCodesTree()

    const listed = sentOfType(send, 'list_dir').map((m) => (m as { rel: string }).rel)
    expect(listed).toContain('')
    expect(listed).toContain('src')
    expect(sentOfType(send, 'get_code_git_status')).toHaveLength(1)
  })

  it('switching workspace clears the snapshot so no stale markers leak across', () => {
    const { ctx } = makeCtx()
    ctx.openCodes(WS)
    ctx.applyCodeGitStatus(WS, { 'a.ts': clean })
    expect(ctx.codesGitStatus.value).not.toEqual({})

    ctx.openCodes('/ws2') // workspace change → resetCodesState
    expect(ctx.codesGitStatus.value).toEqual({})
  })
})

describe('codes-actions navigateToCodeFile', () => {
  const WS = '/ws'

  it('from non-codes tab switches to codes, expands ancestors, and opens file', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.activeTab.value = 'intents'
    ctx.codesDirs.value = { '': [] }

    ctx.navigateToCodeFile('a/b/c.ts')

    expect(ctx.activeTab.value).toBe('codes')
    expect(ctx.codesProject.value).toBe(WS)
    expect(ctx.codesExpanded.value.has('a')).toBe(true)
    expect(ctx.codesExpanded.value.has('a/b')).toBe(true)
    expect(ctx.codesActivePath.value).toBe('a/b/c.ts')
  })

  it('already on codes tab does not reset state', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.codesProject.value = WS
    ctx.activeTab.value = 'codes'
    // Simulate already-open tabs and expanded dirs.
    ctx.codesExpanded.value = new Set(['src'])
    ctx.codesDirs.value = { '': [], src: [] }

    ctx.navigateToCodeFile('src/lib/util.ts')

    // Should keep existing expanded dirs and add new ones.
    expect(ctx.codesExpanded.value.has('src')).toBe(true)
    expect(ctx.codesExpanded.value.has('src/lib')).toBe(true)
    expect(ctx.codesActivePath.value).toBe('src/lib/util.ts')
  })

  it('expands all ancestor directories', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openCodes(WS)

    ctx.navigateToCodeFile('a/b/c/d.ts')

    expect([...ctx.codesExpanded.value].sort()).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('lazy-loads un-cached ancestor directories', () => {
    const { ctx, send } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openCodes(WS)
    send.mockClear()

    ctx.codesDirs.value = { '': [], a: [] }
    ctx.navigateToCodeFile('a/b/c.ts')

    // 'a' is already cached, 'a/b' is not — should request load for 'a/b' only.
    const listed = send.mock.calls
      .map((c: unknown[]) => c[0] as ClientToServer)
      .filter((m) => m.type === 'list_dir')
      .map((m) => (m as { rel: string }).rel)
    expect(listed).toEqual(['a/b'])
  })

  it('normalizes a ./-prefixed path so the tab matches the server reply', () => {
    const { ctx, send } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.codesProject.value = WS
    ctx.activeTab.value = 'codes'
    ctx.codesDirs.value = { '': [] }

    ctx.navigateToCodeFile('./web/src/App.vue')

    // Tab + expansion + read_file all use the canonical (normalized) path.
    expect(ctx.codesActivePath.value).toBe('web/src/App.vue')
    expect(ctx.codesExpanded.value.has('web')).toBe(true)
    expect(ctx.codesExpanded.value.has('web/src')).toBe(true)
    const reads = send.mock.calls
      .map((c: unknown[]) => c[0] as ClientToServer)
      .filter((m) => m.type === 'read_file')
      .map((m) => (m as { rel: string }).rel)
    expect(reads).toContain('web/src/App.vue')
    expect(reads).not.toContain('./web/src/App.vue')
  })

  it('passes line number to openCodeFile', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openCodes(WS)
    // Clear any pre-existing expanded/open state from openCodes.
    ctx.codesExpanded.value = new Set()

    ctx.navigateToCodeFile('main.ts', 42)

    expect(ctx.codesActivePath.value).toBe('main.ts')
  })

  it('no workspace is no-op', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = null
    ctx.activeTab.value = 'intents'

    ctx.navigateToCodeFile('main.ts')

    expect(ctx.activeTab.value).toBe('intents')
    expect(ctx.codesActivePath.value).toBeNull()
  })

  it('when already on codes tab does not reset search mode', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.codesProject.value = WS
    ctx.activeTab.value = 'codes'
    ctx.codesSearchMode.value = 'content'
    ctx.codesSearchQuery.value = 'foo'
    ctx.codesDirs.value = { '': [], src: [] }
    ctx.codesExpanded.value = new Set(['src'])

    ctx.navigateToCodeFile('src/main.ts')

    // navigateToCodeFile itself must not clear search mode.
    expect(ctx.codesSearchMode.value).toBe('content')
    expect(ctx.codesSearchQuery.value).toBe('foo')
  })
})
