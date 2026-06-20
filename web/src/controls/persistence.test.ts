import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { installPersistence } from './persistence'
import { WORK_SESSION_QUERY_START_TIME_KEY, type TabKey } from './state'
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
