import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CodeTree from './CodeTree.vue'
import { i18n } from '@/i18n'
import type { CodeDirEntry } from '@ccc/shared/protocol'

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
const copyNameLabel = t('codes.tree.contextMenu.copyName')
const copyRelPathLabel = t('codes.tree.contextMenu.copyRelPath')

const rootFile: CodeDirEntry = { type: 'file', name: 'README.md', path: 'README.md' }
const rootDir: CodeDirEntry = { type: 'directory', name: 'src', path: 'src' }
const nestedFile: CodeDirEntry = { type: 'file', name: 'main.ts', path: 'src/main.ts' }
const nestedDir: CodeDirEntry = { type: 'directory', name: 'components', path: 'src/components' }

let originalClipboard: Clipboard | undefined
let writeText: ReturnType<typeof vi.fn>

function mountTree(overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    },
  })
}

beforeEach(() => {
  installLocalStorage()
  originalClipboard = navigator.clipboard
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: originalClipboard,
  })
  vi.restoreAllMocks()
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

describe('CodeTree.vue — 文件树节点右键复制', () => {
  it('右键文件节点显示 copy name 与 copy relative path 菜单项', async () => {
    const w = mountTree({ rootEntries: [rootFile] })
    await w.find('.file-row').trigger('contextmenu', { clientX: 24, clientY: 32 })

    expect(w.find('.tree-context-menu').exists()).toBe(true)
    expect(w.find('[data-testid="tree-context-copy-name"]').text()).toBe(copyNameLabel)
    expect(w.find('[data-testid="tree-context-copy-relative-path"]').text()).toBe(copyRelPathLabel)
  })

  it('右键文件夹节点同样显示菜单', async () => {
    const w = mountTree({ rootEntries: [rootDir] })
    await w.find('.dir-row').trigger('contextmenu', { clientX: 24, clientY: 32 })

    expect(w.find('.tree-context-menu').exists()).toBe(true)
    expect(w.find('[data-testid="tree-context-copy-name"]').text()).toBe(copyNameLabel)
    expect(w.find('[data-testid="tree-context-copy-relative-path"]').text()).toBe(copyRelPathLabel)
  })

  it('copy name 复制文件 basename,不包含父级路径,并抛成功 toast', async () => {
    const w = mountTree({
      rootEntries: [rootDir],
      dirs: { src: [nestedFile] },
      expanded: new Set(['src']),
    })

    await w.findAll('.file-row')[0].trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-name"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith('main.ts')
    expect(w.emitted('toast')?.at(-1)).toEqual([
      t('codes.tree.contextMenu.copySuccess', { value: 'main.ts' }),
    ])
  })

  it('copy relative path 复制嵌套文件的 workspace 相对路径', async () => {
    const w = mountTree({
      rootEntries: [rootDir],
      dirs: { src: [nestedFile] },
      expanded: new Set(['src']),
    })

    await w.findAll('.file-row')[0].trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-relative-path"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith('src/main.ts')
    expect(w.emitted('toast')?.at(-1)).toEqual([
      t('codes.tree.contextMenu.copySuccess', { value: 'src/main.ts' }),
    ])
  })

  it('copy relative path 对根层文件和文件夹复制自身名称', async () => {
    const w = mountTree({ rootEntries: [rootFile, rootDir] })

    await w.findAll('.file-row')[0].trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-relative-path"]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith('README.md')

    await w.findAll('.dir-row')[0].trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-relative-path"]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith('src')
  })

  it('copy relative path 对嵌套文件夹包含父目录', async () => {
    const w = mountTree({
      rootEntries: [rootDir],
      dirs: { src: [nestedDir] },
      expanded: new Set(['src']),
    })

    await w.findAll('.dir-row')[1].trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-relative-path"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith('src/components')
  })

  it('复制失败时抛失败 toast', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const w = mountTree({ rootEntries: [rootFile] })

    await w.find('.file-row').trigger('contextmenu', { clientX: 24, clientY: 32 })
    await w.find('[data-testid="tree-context-copy-name"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith('README.md')
    expect(w.emitted('toast')?.at(-1)).toEqual([
      t('codes.tree.contextMenu.copyFailed', { value: 'README.md' }),
    ])
  })

  it('点击菜单外区域关闭菜单', async () => {
    const w = mountTree({ rootEntries: [rootFile] })
    await w.find('.file-row').trigger('contextmenu', { clientX: 24, clientY: 32 })

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(w.find('.tree-context-menu').exists()).toBe(false)
  })

  it('右键菜单不影响左键文件打开和目录展开', async () => {
    const w = mountTree({ rootEntries: [rootDir, rootFile] })

    await w.find('.dir-row').trigger('contextmenu', { clientX: 24, clientY: 32 })
    expect(w.emitted('toggle-dir')).toBeUndefined()

    await w.find('.dir-row').trigger('click')
    expect(w.emitted('toggle-dir')?.at(-1)).toEqual(['src'])

    await w.find('.file-row').trigger('contextmenu', { clientX: 24, clientY: 32 })
    expect(w.emitted('open-file')).toBeUndefined()

    await w.find('.file-row').trigger('click')
    expect(w.emitted('open-file')?.at(-1)).toEqual(['README.md'])
  })
})
