/*
 * highlight.ts — assistant 代码块的 Shiki 按需高亮。
 *
 * 设计要点(见 changes/.../2026-06-02-009-assistant-shiki-highlight/spec.md):
 *  - Shiki 走 dynamic import:首屏不加载,首次高亮时才拉起独立 chunk;语言 grammar 逐个懒加载。
 *  - shiki 4 已无 css-variables 主题 → 自定义「哨兵色主题」:每类 token 给一个固定哨兵 hex,
 *    渲染后把 `style="color:<哨兵hex>"` 确定性映射成 `class="t-<X>"` 并删除所有 inline style。
 *    配色最终由 style.css 的 `.md-body .shiki .t-*{color:var(--c-*)}` 驱动,随 [data-theme] 切换。
 *  - 高亮片段仍过 DOMPurify(class-only、不放行 style),与上游渲染管线同一道安全防线。
 *  - 任何失败(未知语言 / 加载异常)都返回 null,调用方保持原 <pre><code> 兜底,绝不破版。
 */
import DOMPurify from 'dompurify'
import type { Highlighter, ThemeRegistrationRaw } from 'shiki'

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

let hlP: Promise<Highlighter> | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!hlP) {
    hlP = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [CCC_THEME], langs: [] }),
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
    const hl = await getHighlighter()
    if (!hl.getLoadedLanguages().includes(lang)) {
      const { bundledLanguages } = await import('shiki')
      if (!(lang in bundledLanguages)) return null
      await hl.loadLanguage(lang as keyof typeof bundledLanguages)
    }
    const raw = hl.codeToHtml(code, { lang, theme: 'ccc-css-vars' })
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
