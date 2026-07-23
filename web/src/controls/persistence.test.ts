import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { installPersistence } from './persistence'
import {
  REQ_PROJECT_KEY,
  VIEW_MODE_KEY,
  WORK_SESSION_QUERY_START_TIME_KEY,
  type TabKey,
} from './state'
import type { AppCtx } from './types'

const stored = new Map<string, string>()
const storage = {
  getItem(key: string): string | null {
    return stored.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    stored.set(key, value)
  },
  removeItem(key: string): void {
    stored.delete(key)
  },
}
const globalWithStorage = globalThis as { localStorage?: unknown }
let originalStorage: unknown

function makeCtx(activeTab: TabKey): AppCtx {
  return { activeTab: ref(activeTab) } as unknown as AppCtx
}

describe('work-session query cache', () => {
  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })

  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('clears its start time when the active page changes', () => {
    const ctx = makeCtx('console')
    installPersistence(ctx)
    storage.setItem(WORK_SESSION_QUERY_START_TIME_KEY, '1718800000000')

    ctx.activeTab.value = 'intents'

    expect(storage.getItem(WORK_SESSION_QUERY_START_TIME_KEY)).toBeNull()
  })

  it('keeps its start time when the active page is reselected', () => {
    const ctx = makeCtx('console')
    installPersistence(ctx)
    storage.setItem(WORK_SESSION_QUERY_START_TIME_KEY, '1718800000000')

    ctx.activeTab.value = 'console'

    expect(storage.getItem(WORK_SESSION_QUERY_START_TIME_KEY)).toBe('1718800000000')
  })
})

describe('intent view restore after a hard refresh', () => {
  const WS = '/ws'

  function makeIntentCtx(): AppCtx {
    return {
      activeTab: ref('console' as TabKey),
      intentsProject: ref<string | null>(null),
      send: vi.fn(),
    } as unknown as AppCtx
  }

  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
    storage.setItem(VIEW_MODE_KEY, 'intents')
    storage.setItem(REQ_PROJECT_KEY, WS)
  })

  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  // The detail progress bar only appends the PR stage once the workspace branch
  // mode is known, so the restore entry must load it like `openIntents` does.
  it('loads the workspace setting for the restored workspace alongside the intent sessions', () => {
    const ctx = makeIntentCtx()
    installPersistence(ctx)

    ctx.maybeRestoreIntents([{ id: WS } as WorkspaceInfo])

    expect(ctx.intentsProject.value).toBe(WS)
    expect(ctx.send).toHaveBeenCalledWith({ type: 'load_workspace_setting', workspaceId: WS })
    expect(ctx.send).toHaveBeenCalledWith({ type: 'open_intent_session', workspaceId: WS })
    expect(ctx.send).toHaveBeenCalledWith({ type: 'list_intent_sessions', workspaceId: WS })
  })

  it('does not load any workspace setting when the persisted workspace is gone', () => {
    const ctx = makeIntentCtx()
    installPersistence(ctx)

    ctx.maybeRestoreIntents([{ id: '/other' } as WorkspaceInfo])

    expect(ctx.send).not.toHaveBeenCalled()
  })
})

describe('codes embedded chat persistence', () => {
  const WS = '/ws'

  beforeEach(() => {
    stored.clear()
    originalStorage = globalWithStorage.localStorage
    globalWithStorage.localStorage = storage
  })

  afterEach(() => {
    globalWithStorage.localStorage = originalStorage
  })

  it('readCodesChatWidth falls back to the default when absent or unparseable', () => {
    const ctx = makeCtx('codes')
    installPersistence(ctx)
    expect(ctx.readCodesChatWidth(WS)).toBe(360)
    storage.setItem(`c3.codes.${WS}.chatWidth`, 'not-a-number')
    expect(ctx.readCodesChatWidth(WS)).toBe(360)
  })

  it('persistCodesChatWidth writes a clamped, rounded pixel value read back verbatim', () => {
    const ctx = makeCtx('codes')
    installPersistence(ctx)
    ctx.persistCodesChatWidth(WS, 520.6)
    expect(storage.getItem(`c3.codes.${WS}.chatWidth`)).toBe('521')
    expect(ctx.readCodesChatWidth(WS)).toBe(521)
  })

  it('readCodesChatWidth clamps out-of-range persisted values to [240, 720]', () => {
    const ctx = makeCtx('codes')
    installPersistence(ctx)
    storage.setItem(`c3.codes.${WS}.chatWidth`, '9000')
    expect(ctx.readCodesChatWidth(WS)).toBe(720)
    storage.setItem(`c3.codes.${WS}.chatWidth`, '10')
    expect(ctx.readCodesChatWidth(WS)).toBe(240)
  })

  it('readCodesSessionId returns null when absent and the id when set; persist clears on null', () => {
    const ctx = makeCtx('codes')
    installPersistence(ctx)
    expect(ctx.readCodesSessionId(WS)).toBeNull()
    ctx.persistCodesSessionId(WS, 'sess-1')
    expect(ctx.readCodesSessionId(WS)).toBe('sess-1')
    ctx.persistCodesSessionId(WS, null)
    expect(ctx.readCodesSessionId(WS)).toBeNull()
  })
})
