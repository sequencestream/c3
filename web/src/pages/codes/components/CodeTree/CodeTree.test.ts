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
const chatShowTip = t('codes.chat.toggle.show.tooltip')
const chatHideTip = t('codes.chat.toggle.hide.tooltip')
const copyNameLabel = t('codes.tree.contextMenu.copyName')
const copyRelPathLabel = t('codes.tree.contextMenu.copyRelPath')
const gitModifiedLabel = t('codes.tree.git.modified')
const gitUntrackedLabel = t('codes.tree.git.untracked')
const gitStagedLabel = t('codes.tree.git.staged')
const gitDirChangesLabel = t('codes.tree.git.dirChanges')

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
      gitStatus: {},
      activePath: null,
      searchMode: 'filename',
      searchQuery: '',
      searchPattern: '*',
      searchResult: null,
      searchLoading: false,
      showChat: false,
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

describe('CodeTree.vue — 修改会话切换按钮', () => {
  it('默认渲染:aria-pressed=false、空心图标(chat-off)、show tooltip', () => {
    const w = mountTree()
    const btn = w.find('[data-testid="codes-chat-toggle"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.find('svg').attributes('data-icon')).toBe('chat-off')
    expect(btn.attributes('title')).toBe(chatShowTip)
    expect(btn.attributes('aria-label')).toBe(chatShowTip)
  })

  it('showChat=true 渲染:aria-pressed=true、实心图标(chat-on)、hide tooltip', () => {
    const w = mountTree({ showChat: true })
    const btn = w.find('[data-testid="codes-chat-toggle"]')
    expect(btn.attributes('aria-pressed')).toBe('true')
    expect(btn.find('svg').attributes('data-icon')).toBe('chat-on')
    expect(btn.attributes('title')).toBe(chatHideTip)
    expect(btn.attributes('aria-label')).toBe(chatHideTip)
  })

  it('点击一次 emit toggle-chat', async () => {
    const w = mountTree()
    await w.find('[data-testid="codes-chat-toggle"]').trigger('click')
    expect(w.emitted('toggle-chat')).toHaveLength(1)
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

describe('CodeTree.vue — 文件树 Git 状态标记', () => {
  it('无 git 状态时文件行不渲染任何标记(视觉不变)', () => {
    const w = mountTree({ rootEntries: [rootFile] })
    expect(w.find('.file-row [data-testid="git-marks"]').exists()).toBe(false)
    expect(w.find('[data-testid="dir-change-dot"]').exists()).toBe(false)
  })

  it('untracked→成功色 / modified→警告色 / staged→强调色,三种标记可辨识', () => {
    const w = mountTree({
      rootEntries: [
        { type: 'file', name: 'a.ts', path: 'a.ts' },
        { type: 'file', name: 'b.ts', path: 'b.ts' },
        { type: 'file', name: 'c.ts', path: 'c.ts' },
      ],
      gitStatus: {
        'a.ts': { modified: false, untracked: true, staged: false },
        'b.ts': { modified: true, untracked: false, staged: false },
        'c.ts': { modified: false, untracked: false, staged: true },
      },
    })
    const rows = w.findAll('.file-row')
    expect(rows[0].find('.git-mark--untracked').exists()).toBe(true)
    expect(rows[0].find('[data-testid="git-marks"]').attributes('aria-label')).toBe(
      gitUntrackedLabel,
    )
    expect(rows[1].find('.git-mark--modified').exists()).toBe(true)
    expect(rows[1].find('[data-testid="git-marks"]').attributes('aria-label')).toBe(
      gitModifiedLabel,
    )
    expect(rows[2].find('.git-mark--staged').exists()).toBe(true)
    expect(rows[2].find('[data-testid="git-marks"]').attributes('aria-label')).toBe(gitStagedLabel)
  })

  it('staged + modified 同时呈现两个标记,固定顺序 staged 在前', () => {
    const w = mountTree({
      rootEntries: [{ type: 'file', name: 'a.ts', path: 'a.ts' }],
      gitStatus: { 'a.ts': { modified: true, untracked: false, staged: true } },
    })
    const marks = w.findAll('.file-row .git-mark')
    expect(marks).toHaveLength(2)
    expect(marks[0].attributes('data-git-kind')).toBe('staged')
    expect(marks[1].attributes('data-git-kind')).toBe('modified')
    expect(w.find('.file-row [data-testid="git-marks"]').attributes('aria-label')).toBe(
      `${gitStagedLabel}, ${gitModifiedLabel}`,
    )
  })

  it('折叠目录:子孙有改动时显示汇总圆点(带无障碍标签),无改动的目录不显示', () => {
    const w = mountTree({
      rootEntries: [
        { type: 'directory', name: 'src', path: 'src' },
        { type: 'directory', name: 'docs', path: 'docs' },
      ],
      // src 折叠且从未加载,但快照里有 src 下改动 → 目录仍显示汇总
      gitStatus: { 'src/deep/nested.ts': { modified: true, untracked: false, staged: false } },
    })
    const dirs = w.findAll('.dir-row')
    const srcDot = dirs[0].find('[data-testid="dir-change-dot"]')
    expect(srcDot.exists()).toBe(true)
    expect(srcDot.attributes('aria-label')).toBe(gitDirChangesLabel)
    expect(dirs[1].find('[data-testid="dir-change-dot"]').exists()).toBe(false)
  })

  it('相似前缀目录不串扰:src-old 的改动不点亮 src', () => {
    const w = mountTree({
      rootEntries: [
        { type: 'directory', name: 'src', path: 'src' },
        { type: 'directory', name: 'src-old', path: 'src-old' },
      ],
      gitStatus: { 'src-old/x.ts': { modified: true, untracked: false, staged: false } },
    })
    const dirs = w.findAll('.dir-row')
    expect(dirs[0].find('[data-testid="dir-change-dot"]').exists()).toBe(false)
    expect(dirs[1].find('[data-testid="dir-change-dot"]').exists()).toBe(true)
  })
})
