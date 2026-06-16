import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeTree from './CodeTree.vue'
import { i18n } from '@/i18n'

const STORAGE_KEY = 'c3.codesTreeExpanded'

// happy-dom here exposes no localStorage; install a minimal in-memory stub so the
// usePersistentToggle persistence path actually runs (the composable reads the
// global `localStorage` identifier → globalThis.localStorage).
function installLocalStorage(): void {
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
}

// Resolve the active-locale tooltip from the real i18n instance so the assertions
// hold regardless of which locale the test run starts in (en/zh both shipped).
const t = i18n.global.t
const expandTip = t('codes.tree.toggle.expand.tooltip')
const collapseTip = t('codes.tree.toggle.collapse.tooltip')

function mountTree() {
  return mount(CodeTree, {
    props: {
      rootEntries: [],
      dirs: {},
      expanded: new Set<string>(),
      loadingDirs: new Set<string>(),
      activePath: null,
      searchMode: 'filename',
      searchQuery: '',
      searchPattern: '*',
      searchResult: null,
      searchLoading: false,
    },
  })
}

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = undefined
})

describe('CodeTree.vue — Files 侧栏头 + 展开/收缩切换', () => {
  it('默认渲染 Files 标题 + 切换按钮,.code-tree 无 expanded class', () => {
    const w = mountTree()
    expect(w.find('.tree-title').text()).toBe(t('codes.tree.title.label'))
    const btn = w.find('[data-testid="codes-tree-toggle"]')
    expect(btn.exists()).toBe(true)
    expect(w.find('.code-tree').classes()).not.toContain('expanded')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.text()).toBe('⇥')
  })

  it('点击切换 → 加 expanded class、aria-pressed=true、图标 ⇥→⇤', async () => {
    const w = mountTree()
    const btn = w.find('[data-testid="codes-tree-toggle"]')
    await btn.trigger('click')
    expect(w.find('.code-tree').classes()).toContain('expanded')
    expect(btn.attributes('aria-pressed')).toBe('true')
    expect(btn.text()).toBe('⇤')
  })

  it('再次点击 → 回到无 expanded class、aria-pressed=false、图标回 ⇥', async () => {
    const w = mountTree()
    const btn = w.find('[data-testid="codes-tree-toggle"]')
    await btn.trigger('click')
    await btn.trigger('click')
    expect(w.find('.code-tree').classes()).not.toContain('expanded')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.text()).toBe('⇥')
  })

  it('title / aria-label 在两态间切换 i18n tooltip', async () => {
    const w = mountTree()
    const btn = w.find('[data-testid="codes-tree-toggle"]')
    expect(btn.attributes('title')).toBe(expandTip)
    expect(btn.attributes('aria-label')).toBe(expandTip)
    await btn.trigger('click')
    expect(btn.attributes('title')).toBe(collapseTip)
    expect(btn.attributes('aria-label')).toBe(collapseTip)
  })

  it('切换写入 localStorage 字符串 true / false', async () => {
    const w = mountTree()
    const btn = w.find('[data-testid="codes-tree-toggle"]')
    await btn.trigger('click')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    await btn.trigger('click')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })
})

describe('CodeTree.vue — 文件模式 glob 过滤框', () => {
  it('渲染独立的 pattern 输入框,初值取 searchPattern', () => {
    const w = mountTree()
    const pattern = w.find('input.search-pattern')
    expect(pattern.exists()).toBe(true)
    expect((pattern.element as HTMLInputElement).value).toBe('*')
  })

  it('输入 pattern → 抛 update:searchPattern', async () => {
    const w = mountTree()
    const pattern = w.find('input.search-pattern')
    await pattern.setValue('*.ts')
    expect(w.emitted('update:searchPattern')?.at(-1)).toEqual(['*.ts'])
  })
})
