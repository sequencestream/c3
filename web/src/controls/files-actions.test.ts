/**
 * Files 内嵌 ChatColumn 的控制层:openFiles 会话恢复、create/reset 会话、
 * session_selected 落地时的 filesBoundSessionId + localStorage 持久化,以及宽度读写。
 * 复用控制层单一活动会话:Files 发的就是普通 select_session / create_session。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { installPersistence } from './persistence'
import { installFilesActions } from './files-actions'
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
    // files file browser state (reset by openFiles on workspace change)
    filesProject: ref<string | null>(null),
    filesDirs: ref<Record<string, unknown[]>>({}),
    filesExpanded: ref<Set<string>>(new Set()),
    filesLoadingDirs: ref<Set<string>>(new Set()),
    filesGitStatus: ref<Record<string, unknown>>({}),
    filesTabs: ref<unknown[]>([]),
    filesActivePath: ref<string | null>(null),
    filesSearchMode: ref('filename'),
    filesSearchQuery: ref(''),
    filesSearchPattern: ref('*'),
    filesSearchResult: ref<unknown>(null),
    filesSearchLoading: ref(false),
    filesBoundSessionId: ref<Record<string, string>>({}),
    // single active session (shared with Works)
    activeSession: ref<string | null>(activeSessionId),
    activeTab: ref('files'),
    // persistence deps
    currentWorkspace: ref<string | null>(null),
    intentsProject: ref<string | null>(null),
    discussionsProject: ref<string | null>(null),
    activeDiscussionId: ref<string | null>(null),
    automationsProject: ref<string | null>(null),
  } as unknown as AppCtx
  installPersistence(ctx)
  installFilesActions(ctx)
  return { ctx, send }
}

function sentOfType(send: ReturnType<typeof vi.fn>, type: string): ClientToServer[] {
  return send.mock.calls.map((c) => c[0] as ClientToServer).filter((m) => m.type === type)
}

describe('files-actions embedded chat', () => {
  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })
  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('openFiles restores a persisted session via select_session', () => {
    const { ctx, send } = makeCtx('other-session')
    storage.setItem(`c3.files.${WS}.sessionId`, 'sess-1')

    ctx.openFiles(WS)

    const selects = sentOfType(send, 'select_session')
    expect(selects).toEqual([{ type: 'select_session', workspaceName: WS, sessionId: 'sess-1' }])
    expect(ctx.filesBoundSessionId.value[WS]).toBe('sess-1')
  })

  it('openFiles with no persisted id sends no select_session and keeps the active session', () => {
    const { ctx, send } = makeCtx('works-session')

    ctx.openFiles(WS)

    expect(sentOfType(send, 'select_session')).toHaveLength(0)
    expect(ctx.activeSession.value).toBe('works-session')
    expect(ctx.filesBoundSessionId.value[WS]).toBeUndefined()
  })

  it('createFilesChatSession sends create_session; session_selected persists the binding', () => {
    const { ctx, send } = makeCtx(null)
    ctx.openFiles(WS)

    ctx.createFilesChatSession(WS)
    expect(sentOfType(send, 'create_session')).toEqual([
      { type: 'create_session', workspaceName: WS },
    ])

    // Simulate the server round-trip: session_selected sets the active session.
    ctx.activeSession.value = 'sess-new'

    expect(ctx.filesBoundSessionId.value[WS]).toBe('sess-new')
    expect(storage.getItem(`c3.files.${WS}.sessionId`)).toBe('sess-new')
  })

  it('a pending session id binds in-memory but is not persisted (waits for the real id)', () => {
    const { ctx } = makeCtx(null)
    ctx.openFiles(WS)

    const pending = `${PENDING_SESSION_PREFIX}tmp`
    ctx.activeSession.value = pending
    // In-memory binding is immediate so chatActive (activeSession===bound) holds and
    // the freshly-created session's input is usable; otherwise it would deadlock.
    expect(ctx.filesBoundSessionId.value[WS]).toBe(pending)
    // But the pending id is never persisted — it won't survive a reconnect.
    expect(storage.getItem(`c3.files.${WS}.sessionId`)).toBeNull()

    ctx.activeSession.value = 'sess-real'
    expect(ctx.filesBoundSessionId.value[WS]).toBe('sess-real')
    expect(storage.getItem(`c3.files.${WS}.sessionId`)).toBe('sess-real')
  })

  it('resetFilesChatSession replaces the binding with a freshly created session', () => {
    const { ctx, send } = makeCtx(null)
    ctx.openFiles(WS)
    ctx.activeSession.value = 'sess-old'
    expect(ctx.filesBoundSessionId.value[WS]).toBe('sess-old')

    ctx.resetFilesChatSession(WS)
    expect(sentOfType(send, 'create_session')).toEqual([
      { type: 'create_session', workspaceName: WS },
    ])

    ctx.activeSession.value = 'sess-fresh'
    expect(ctx.filesBoundSessionId.value[WS]).toBe('sess-fresh')
    expect(storage.getItem(`c3.files.${WS}.sessionId`)).toBe('sess-fresh')
  })

  it('does not persist the files binding while on another tab', () => {
    const { ctx } = makeCtx(null)
    ctx.openFiles(WS)
    ctx.activeTab.value = 'console'

    ctx.activeSession.value = 'works-session'

    expect(ctx.filesBoundSessionId.value[WS]).toBeUndefined()
    expect(storage.getItem(`c3.files.${WS}.sessionId`)).toBeNull()
  })

  it('persistFilesChatWidth / readFilesChatWidth round-trip', () => {
    const { ctx } = makeCtx()
    ctx.persistFilesChatWidth(WS, 520)
    expect(ctx.readFilesChatWidth(WS)).toBe(520)
  })
})

describe('files-actions git status', () => {
  const clean = { modified: false, untracked: false, staged: false }

  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })
  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('requestFilesGitStatus sends get_file_git_status for the current workspace', () => {
    const { ctx, send } = makeCtx()
    ctx.openFiles(WS)
    ctx.requestFilesGitStatus()
    expect(sentOfType(send, 'get_file_git_status')).toEqual([
      { type: 'get_file_git_status', workspaceName: WS },
    ])
  })

  it('coalesces while one is in flight, then fires exactly one merged follow-up', () => {
    const { ctx, send } = makeCtx()
    ctx.openFiles(WS)
    ctx.requestFilesGitStatus() // → sends #1, in flight
    ctx.requestFilesGitStatus() // in flight → queued
    ctx.requestFilesGitStatus() // still queued (merged)
    expect(sentOfType(send, 'get_file_git_status')).toHaveLength(1)

    // Reply arrives → clears in-flight, fires the single merged follow-up.
    ctx.applyFileGitStatus(WS, { 'a.ts': { modified: true, untracked: false, staged: false } })
    expect(sentOfType(send, 'get_file_git_status')).toHaveLength(2)

    // The follow-up's reply, with nothing queued, sends no further request.
    ctx.applyFileGitStatus(WS, {})
    expect(sentOfType(send, 'get_file_git_status')).toHaveLength(2)
  })

  it('applyFileGitStatus replaces the snapshot wholesale (cleared paths drop)', () => {
    const { ctx } = makeCtx()
    ctx.openFiles(WS)
    ctx.applyFileGitStatus(WS, { 'a.ts': clean, 'b.ts': clean })
    expect(Object.keys(ctx.filesGitStatus.value)).toEqual(['a.ts', 'b.ts'])
    // New authoritative snapshot: b.ts is gone → its marker must not linger.
    ctx.applyFileGitStatus(WS, { 'a.ts': clean })
    expect(Object.keys(ctx.filesGitStatus.value)).toEqual(['a.ts'])
  })

  it('ignores a reply for a workspace other than the one being browsed', () => {
    const { ctx } = makeCtx()
    ctx.openFiles(WS)
    ctx.applyFileGitStatus('/other-ws', { 'x.ts': clean })
    expect(ctx.filesGitStatus.value).toEqual({})
  })

  it('refreshFilesTree reloads root + expanded dirs AND re-pulls git status', () => {
    const { ctx, send } = makeCtx()
    ctx.openFiles(WS)
    ctx.filesDirs.value = { '': [], src: [] }
    ctx.filesExpanded.value = new Set(['src'])
    ctx.filesLoadingDirs.value = new Set() // clear the openFiles in-flight guard
    send.mockClear()

    ctx.refreshFilesTree()

    const listed = sentOfType(send, 'list_dir').map((m) => (m as { rel: string }).rel)
    expect(listed).toContain('')
    expect(listed).toContain('src')
    expect(sentOfType(send, 'get_file_git_status')).toHaveLength(1)
  })

  it('switching workspace clears the snapshot so no stale markers leak across', () => {
    const { ctx } = makeCtx()
    ctx.openFiles(WS)
    ctx.applyFileGitStatus(WS, { 'a.ts': clean })
    expect(ctx.filesGitStatus.value).not.toEqual({})

    ctx.openFiles('/ws2') // workspace change → resetFilesState
    expect(ctx.filesGitStatus.value).toEqual({})
  })
})

describe('files-actions navigateToFile', () => {
  const WS = '/ws'

  it('from non-files tab switches to files, expands ancestors, and opens file', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.activeTab.value = 'intents'
    ctx.filesDirs.value = { '': [] }

    ctx.navigateToFile('a/b/c.ts')

    expect(ctx.activeTab.value).toBe('files')
    expect(ctx.filesProject.value).toBe(WS)
    expect(ctx.filesExpanded.value.has('a')).toBe(true)
    expect(ctx.filesExpanded.value.has('a/b')).toBe(true)
    expect(ctx.filesActivePath.value).toBe('a/b/c.ts')
  })

  it('already on files tab does not reset state', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.filesProject.value = WS
    ctx.activeTab.value = 'files'
    // Simulate already-open tabs and expanded dirs.
    ctx.filesExpanded.value = new Set(['src'])
    ctx.filesDirs.value = { '': [], src: [] }

    ctx.navigateToFile('src/lib/util.ts')

    // Should keep existing expanded dirs and add new ones.
    expect(ctx.filesExpanded.value.has('src')).toBe(true)
    expect(ctx.filesExpanded.value.has('src/lib')).toBe(true)
    expect(ctx.filesActivePath.value).toBe('src/lib/util.ts')
  })

  it('expands all ancestor directories', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openFiles(WS)

    ctx.navigateToFile('a/b/c/d.ts')

    expect([...ctx.filesExpanded.value].sort()).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('lazy-loads un-cached ancestor directories', () => {
    const { ctx, send } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openFiles(WS)
    send.mockClear()

    ctx.filesDirs.value = { '': [], a: [] }
    ctx.navigateToFile('a/b/c.ts')

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
    ctx.filesProject.value = WS
    ctx.activeTab.value = 'files'
    ctx.filesDirs.value = { '': [] }

    ctx.navigateToFile('./web/src/App.vue')

    // Tab + expansion + read_file all use the canonical (normalized) path.
    expect(ctx.filesActivePath.value).toBe('web/src/App.vue')
    expect(ctx.filesExpanded.value.has('web')).toBe(true)
    expect(ctx.filesExpanded.value.has('web/src')).toBe(true)
    const reads = send.mock.calls
      .map((c: unknown[]) => c[0] as ClientToServer)
      .filter((m) => m.type === 'read_file')
      .map((m) => (m as { rel: string }).rel)
    expect(reads).toContain('web/src/App.vue')
    expect(reads).not.toContain('./web/src/App.vue')
  })

  it('passes line number to openFile', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.openFiles(WS)
    // Clear any pre-existing expanded/open state from openFiles.
    ctx.filesExpanded.value = new Set()

    ctx.navigateToFile('main.ts', 42)

    expect(ctx.filesActivePath.value).toBe('main.ts')
  })

  it('no workspace is no-op', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = null
    ctx.activeTab.value = 'intents'

    ctx.navigateToFile('main.ts')

    expect(ctx.activeTab.value).toBe('intents')
    expect(ctx.filesActivePath.value).toBeNull()
  })

  it('when already on files tab does not reset search mode', () => {
    const { ctx } = makeCtx()
    ctx.currentWorkspace.value = WS
    ctx.filesProject.value = WS
    ctx.activeTab.value = 'files'
    ctx.filesSearchMode.value = 'content'
    ctx.filesSearchQuery.value = 'foo'
    ctx.filesDirs.value = { '': [], src: [] }
    ctx.filesExpanded.value = new Set(['src'])

    ctx.navigateToFile('src/main.ts')

    // navigateToFile itself must not clear search mode.
    expect(ctx.filesSearchMode.value).toBe('content')
    expect(ctx.filesSearchQuery.value).toBe('foo')
  })
})
