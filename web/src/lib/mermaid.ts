/*
 * mermaid.ts — Markdown 里 ```mermaid 围栏代码块的按需图表渲染。
 *
 * 设计要点(与 highlight.ts 同构:懒加载 + 净化 + 失败降级):
 *  - mermaid 走 dynamic import:首屏不加载,文档里真的出现 mermaid 块时才拉起独立 chunk。
 *  - 每次渲染分配唯一 id:mermaid 用 id 给 SVG 内部的 marker/样式做作用域,同页多图必须互不撞号。
 *  - 先 parse(suppressErrors) 再 render:语法错误止步于解析,不让 mermaid 把「错误图」写进文档。
 *  - 关闭 htmlLabels:标签以 <text> 而非 <foreignObject> 承载,产出纯 SVG。DOMPurify 默认禁用
 *    foreignObject(其内是 HTML,是 SVG→HTML 的命名空间跳板),放行它既扩大攻击面又要额外白名单;
 *    纯 SVG 让净化边界既完整又确定。
 *  - 产出 SVG 仍过 DOMPurify(svg profile),与 MarkdownText 的 Markdown 主管线共用同一道
 *    不可信内容边界:mermaid 源码同样来自模型/外部文本,不能因为绕了一层就免检。
 *  - 任何失败(解析失败 / 渲染抛错 / 没拿到 SVG)一律返回 null,调用方保持原 <pre><code> 兜底。
 */
import DOMPurify from 'dompurify'
import { resolveTheme } from './theme'

type MermaidApi = typeof import('mermaid').default

let mermaidP: Promise<MermaidApi> | null = null
// 已生效的 mermaid 主题;控制台切主题后,下一次渲染重新 initialize 以跟上明暗基调。
let appliedTheme: string | null = null
// 图表序号:保证同一页面内每个 SVG 的 id 唯一。
let seq = 0

// 控制台主题 → mermaid 内置主题。这里只对齐明暗基调,配色仍由 mermaid 自带主题给出。
function mermaidTheme(): 'dark' | 'default' {
  try {
    return resolveTheme(document.documentElement.dataset.theme).colorScheme === 'light'
      ? 'default'
      : 'dark'
  } catch {
    return 'dark'
  }
}

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidP) mermaidP = import('mermaid').then((m) => m.default)
  const mermaid = await mermaidP
  const theme = mermaidTheme()
  if (theme !== appliedTheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    })
    appliedTheme = theme
  }
  return mermaid
}

/**
 * 把一段 Mermaid 源码渲染成安全(已过 DOMPurify)的 SVG 字符串。
 * 语法错误或任何异常返回 null,调用方应保持原始 <pre><code> 不变。
 */
export async function renderMermaid(code: string): Promise<string | null> {
  const source = code.trim()
  if (!source) return null
  try {
    const mermaid = await getMermaid()
    // suppressErrors:语法错误以返回值(false)表达,不抛异常、也不产生错误图。
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return null
    const { svg } = await mermaid.render(`c3-mermaid-${++seq}`, source)
    if (!svg) return null
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
  } catch {
    return null
  }
}
