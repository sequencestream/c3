/*
 * highlight.ts — assistant 代码块的 Shiki 按需高亮。
 *
 * 设计要点(见 changes/.../2026-06-02-009-assistant-shiki-highlight/spec.md):
 *  - Shiki 走 dynamic import:首屏不加载,首次高亮时才拉起独立 chunk;语言 grammar 逐个懒加载。
 *  - 采用 `shiki/core` + JavaScript 正则引擎(`shiki/engine/javascript`),不引 Oniguruma WASM
 *    (省下 ~600KB wasm chunk、首屏更快)。
 *  - 语言走**白名单**(LANG_LOADERS):只为常见语言产出懒加载 chunk,避免 `bundledLanguages`
 *    全量清单把 ~300 种语法/主题全打进 dist(白名单外的语言由 highlight() 返回 null 优雅降级)。
 *  - shiki 4 已无 css-variables 主题 → 自定义「哨兵色主题」:每类 token 给一个固定哨兵 hex,
 *    渲染后把 `style="color:<哨兵hex>"` 确定性映射成 `class="t-<X>"` 并删除所有 inline style。
 *    配色最终由 style.css 的 `.md-body .shiki .t-*{color:var(--c-*)}` 驱动,随 [data-theme] 切换。
 *  - 高亮片段仍过 DOMPurify(class-only、不放行 style),与上游渲染管线同一道安全防线。
 *  - 任何失败(未知语言 / 加载异常)都返回 null,调用方保持原 <pre><code> 兜底,绝不破版。
 */
import DOMPurify from 'dompurify'
import type { HighlighterCore, ThemeRegistrationRaw, LanguageRegistration } from 'shiki/core'

// 语言白名单:canonical id → 懒加载该语法 chunk 的 loader。
// 仅收常见语言;白名单外(含 cpp/emacs-lisp/wasm 等巨型冷门语法)统一降级纯 <pre>。
// 注:单语言文件自包含其内嵌语法(如 vue 自带 ts/css/html),Vite 会跨 chunk 去重共享 grammar。
type LangModule = { default: LanguageRegistration | LanguageRegistration[] }
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

// 常见别名 → canonical id(markdown-it 的 language-* 可能给简写/同义词)。
const LANG_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  cs: 'csharp',
  'c#': 'csharp',
  dockerfile: 'docker',
  gql: 'graphql',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  yml: 'yaml',
}

// 哨兵 hex → token class。哨兵色仅作占位标记,永不出现在最终 DOM(转换阶段被替换/剥除)。
const TOKEN_CLASS: Record<string, string> = {
  '#c01001': 't-keyword',
  '#c01002': 't-string',
  '#c01003': 't-comment',
  '#c01004': 't-function',
  '#c01005': 't-number',
  '#c01006': 't-type',
  '#c01007': 't-variable',
  '#c01008': 't-punctuation',
}

// 默认前景哨兵:无特定 scope 的文本。转换时只剥 style、不加 class → 继承 .md-body 的 --c-text。
const DEFAULT_FG = '#aaaaaa'
const DEFAULT_BG = '#000000'

const CCC_THEME: ThemeRegistrationRaw = {
  name: 'ccc-css-vars',
  type: 'dark',
  fg: DEFAULT_FG,
  bg: DEFAULT_BG,
  settings: [
    { settings: { foreground: DEFAULT_FG, background: DEFAULT_BG } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#c01003' } },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.operator',
        'storage',
        'storage.type',
        'storage.modifier',
        'constant.language',
      ],
      settings: { foreground: '#c01001' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'],
      settings: { foreground: '#c01002' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
      settings: { foreground: '#c01004' },
    },
    {
      scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.null'],
      settings: { foreground: '#c01005' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
      settings: { foreground: '#c01006' },
    },
    {
      scope: ['variable', 'variable.parameter', 'variable.other', 'meta.definition.variable'],
      settings: { foreground: '#c01007' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'punctuation.separator'],
      settings: { foreground: '#c01008' },
    },
  ],
}

let hlP: Promise<HighlighterCore> | null = null

async function getHighlighter(): Promise<HighlighterCore> {
  if (!hlP) {
    hlP = Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
      ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
        createHighlighterCore({
          themes: [CCC_THEME],
          langs: [],
          engine: createJavaScriptRegexEngine(),
        }),
    )
  }
  return hlP
}

// 把 Shiki 输出里的哨兵色 inline style 替换为 token class,并剥除所有残留 style。
function styleToClass(html: string): string {
  return html.replace(/style="([^"]*)"/g, (_m, body: string) => {
    const lower = body.toLowerCase()
    for (const [hex, cls] of Object.entries(TOKEN_CLASS)) {
      if (lower.includes(hex)) return `class="${cls}"`
    }
    // 默认前景或背景哨兵:不加 class,直接剥除(继承容器配色)。
    return ''
  })
}

/**
 * 高亮一段代码,返回安全(已过 DOMPurify、class-only)的 `<pre class="shiki">…</pre>` HTML 串。
 * 未知语言或任何异常返回 null,调用方应保持原始 <pre><code> 不变。
 */
export async function highlight(code: string, lang: string): Promise<string | null> {
  try {
    const canonical = LANG_ALIASES[lang] ?? lang
    const loader = LANG_LOADERS[canonical]
    if (!loader) return null // 白名单外:降级纯 <pre>
    const hl = await getHighlighter()
    if (!hl.getLoadedLanguages().includes(canonical)) {
      const mod = await loader()
      await hl.loadLanguage(mod.default)
    }
    const raw = hl.codeToHtml(code, { lang: canonical, theme: 'ccc-css-vars' })
    const classed = styleToClass(raw)
    return DOMPurify.sanitize(classed, { ADD_ATTR: ['class', 'data-language', 'tabindex'] })
  } catch {
    return null
  }
}

// 从 markdown-it 产出的 `language-xxx` class 提取语言 id。
export function langFromClass(className: string): string | null {
  const m = /(?:^|\s)language-([\w+-]+)/.exec(className)
  return m ? m[1].toLowerCase() : null
}
