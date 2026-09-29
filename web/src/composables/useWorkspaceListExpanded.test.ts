/*
 * 列表竖条的**形态记忆**:形态(展开/收缩)要跨刷新保持,显隐不保持。
 * 这条用例把「显隐是纯内存态、形态落 localStorage」的口径钉在 App.vue 的接线上 ——
 * 两者的差别是刻意的:显隐每次进来都从收起开始(不占横向空间),形态是用户偏好。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick } from 'vue'

const STORAGE_KEY = 'c3.workspaceListExpanded'

// happy-dom here may expose no localStorage; install a minimal in-memory stub so the
// usePersistentToggle persistence path actually runs.
function installLocalStorage(): { store: Map<string, string> } {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = stub
  return { store }
}

function useToggle(key: string, defaultValue: boolean) {
  // 动态引入,好让 localStorage 桩在模块求值前就位。
  let mod!: typeof import('./usePersistentToggle')
  vi.resetModules()
  return import('./usePersistentToggle').then((m) => {
    mod = m
    return mod.usePersistentToggle(key, defaultValue)
  })
}

describe('工作区列表竖条 — 形态记忆', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
  })

  it('首次进入默认展开态(拿到带名称的完整形态)', async () => {
    const expanded = await useToggle(STORAGE_KEY, true)
    expect(expanded.value).toBe(true)
  })

  it('键写入 localStorage:用户切到收缩态后落盘', async () => {
    const { store } = installLocalStorage()
    const expanded = await useToggle(STORAGE_KEY, true)
    expanded.value = false
    // 落盘走 watch,默认异步 flush,等一个 tick。
    await nextTick()
    expect(store.get(STORAGE_KEY)).toBe('false')
  })

  it('刷新后读回同一形态', async () => {
    const { store } = installLocalStorage()
    store.set(STORAGE_KEY, 'false')
    const expanded = await useToggle(STORAGE_KEY, true)
    expect(expanded.value).toBe(false)
  })

  it('localStorage 抛错时退化为纯内存态,不崩', async () => {
    const boom = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
      removeItem() {},
      clear() {},
      key: () => null,
      get length() {
        return 0
      },
    }
    ;(globalThis as { localStorage?: unknown }).localStorage = boom
    const expanded = await useToggle(STORAGE_KEY, true)
    expect(expanded.value).toBe(true)
    // 写回时同样吞掉异常:隐私模式下形态记忆只在本次挂载内有效。
    expect(() => {
      expanded.value = false
    }).not.toThrow()
    expect(expanded.value).toBe(false)
  })
})

describe('工作区列表竖条 — 显隐不持久化', () => {
  it('显隐是纯内存态:不写 localStorage,列表竖条每次都从收起开始', () => {
    const source = readFileSync(resolve(__dirname, '../App.vue'), 'utf-8')
    // 显隐用一个裸 ref(不进 localStorage),形态才走 usePersistentToggle。
    expect(source).toMatch(/const workspaceListOpen = ref\(false\)/)
    expect(source).toMatch(
      /const workspaceListExpanded = usePersistentToggle\('c3\.workspaceListExpanded', true\)/,
    )
  })
})
