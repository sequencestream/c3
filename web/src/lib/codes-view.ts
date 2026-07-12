/*
 * codes-view.ts — Codes(代码浏览)页的纯逻辑与视图类型。
 *
 * 无 DOM / 框架依赖,便于单测:open-tab 聚焦、关闭后聚焦相邻 tab、文件后缀 →
 * Shiki 语言推断、字节数人类可读化。状态与服务端往返在 controls/ 与组件里完成。
 */
import type { CodeFileRead, CodeSearchHit, CodeSearchMode } from '@ccc/shared/protocol'

/** 右栏一个已打开的文件 tab。`file` 为 null 表示内容仍在加载。 */
export interface CodeTab {
  /** workspace 相对路径,既是显示标识也是 tab 唯一 key。 */
  path: string
  /** 已加载的文件元数据 + 内容;加载中为 null。 */
  file: CodeFileRead | null
  /** read_file 在途。 */
  loading: boolean
  /** 内容搜索命中时要滚动/高亮的行号(1-based);文件名命中或普通打开时为空。 */
  focusLine?: number
}

/** 一次代码搜索的结果视图(codes_searched 的客户端镜像)。 */
export interface CodesSearchResultView {
  query: string
  mode: CodeSearchMode
  hits: CodeSearchHit[]
  truncated: boolean
  timedOut: boolean
}

/** 关闭某 tab 后的下一组 tab 与应聚焦的 path(关闭非激活 tab 时保持激活不变)。 */
export interface CloseTabResult {
  tabs: CodeTab[]
  activePath: string | null
}

/**
 * 关闭 `path` 这个 tab:从列表移除;若它是当前激活 tab,则聚焦其右邻(无右邻则左邻),
 * 都没有则置空。关闭非激活 tab 时,激活 tab 不变。
 */
export function closeTab(tabs: CodeTab[], path: string, activePath: string | null): CloseTabResult {
  const idx = tabs.findIndex((t) => t.path === path)
  if (idx < 0) return { tabs, activePath }
  const next = tabs.filter((t) => t.path !== path)
  if (activePath !== path) return { tabs: next, activePath }
  // 被关的是激活 tab:原索引位置现在是右邻;退而求其次取左邻。
  const neighbor = next[idx] ?? next[idx - 1] ?? null
  return { tabs: next, activePath: neighbor ? neighbor.path : null }
}

// 文件后缀 → Shiki canonical 语言 id(白名单见 lib/highlight.ts;白名单外优雅降级纯文本)。
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  vue: 'vue',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  c: 'c',
  h: 'c',
  cs: 'csharp',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
}

// 无后缀但按文件名识别的常见配置/脚本文件。
const NAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  '.gitignore': 'bash',
  '.env': 'bash',
  makefile: 'bash',
}

/** 由 workspace 相对路径推断 Shiki 语言 id;无法识别返回 null(走纯文本兜底)。 */
export function langFromPath(path: string): string | null {
  const base = (path.split('/').pop() ?? path).toLocaleLowerCase()
  if (NAME_LANG[base]) return NAME_LANG[base]
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1)
  return EXT_LANG[ext] ?? null
}

/** 取路径最后一段作为文件名展示。 */
export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** Markdown 文件内容视图的两态:原文(Shiki/纯文本)或渲染预览。仅前端内存态。 */
export const CODE_VIEW_MODES = ['source', 'preview'] as const
export type CodeViewMode = (typeof CODE_VIEW_MODES)[number]

/** 是否对该路径提供 Markdown 预览开关:严格以 `.md` 结尾(不含 .markdown / 无扩展名 / MIME 猜测)。 */
export function isMarkdownPath(path: string): boolean {
  return path.toLocaleLowerCase().endsWith('.md')
}

/**
 * Lexically normalize a workspace-relative path so it matches the canonical
 * form the server echoes back (server resolves via `resolve` + `realpath`,
 * which collapses `./`, `..`, and `//`). Without this, a markdown link like
 * `./web/src/App.vue` opens a tab keyed by the raw path while the server's
 * `file_read` reply carries `web/src/App.vue` — the tab never matches and stays
 * stuck on "loading". Symlinks can't be replicated client-side, but authored
 * links are lexical. A path that escapes the root (leading `..`) is left as-is
 * for the server to reject.
 */
export function normalizeCodePath(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // Pop the last real segment; keep a leading `..` (escaping) untouched.
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * Parse the directory ancestors of a relative file path.
 * Example: 'a/b/c/d.ts' → ['a', 'a/b', 'a/b/c']
 * Single file with no directory → []
 */
export function parseAncestors(path: string): string[] {
  const parts = path.split('/')
  if (parts.length <= 1) return []
  parts.pop() // remove the file name
  const ancestors: string[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    ancestors.push(acc)
  }
  return ancestors
}

/** 字节数人类可读化(B / KB / MB),用于「文件过大」提示。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
