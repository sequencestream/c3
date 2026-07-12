<script setup lang="ts">
/*
 * MarkdownText.vue — 单条文本消息的渲染器。
 *
 * 默认仅对 assistant 文本启用 Markdown(markdown-it html:false → DOMPurify → v-html
 * 两道防线);user / system 走纯文本转义直出（保留 .msg 的换行语义）。工具消息不进
 * 本组件，仍由 ChatMessages 以 <pre class="tool-body"> 原样渲染。本项目非流式（整段
 * push），无需缓冲层 / 未闭合标签处理。
 *
 * 非聊天场景（如需求详情、prompt 预览）可传 `markdown` 强制走同一条安全渲染管线，
 * 无需借 kind="assistant"——此时 kind 可省略，XSS 防护与外链加固一致。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type { TextMsg } from '../../lib/chat-types'
import { highlight, langFromClass } from '../../lib/highlight'

const props = defineProps<{
  text: string
  // 聊天场景传消息的 kind(仅 'assistant' 启用 Markdown);非聊天场景可省略并改用 markdown。
  kind?: TextMsg['kind']
  // 强制启用 Markdown 管线,不论 kind——用于需求详情等非聊天场景。
  markdown?: boolean
}>()

// 模块级单例：避免每次渲染都 new MarkdownIt / 重复注册 hook。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// 外链安全：强制新窗口打开并隔离 opener；剔除 javascript:/data: 等危险协议。
// 在模块加载时注册一次（DOMPurify 是全局单例，hook 不应每次组件挂载重复添加）。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href') ?? ''
    if (/^\s*(javascript|data):/i.test(href)) {
      node.removeAttribute('href')
    } else {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }
})

// markdown 强制开启,或 kind==='assistant' 时启用 Markdown;其余走纯文本直出。
const isMarkdown = computed(() => props.markdown === true || props.kind === 'assistant')

// 渲染管线固定顺序：markdown-it(html:false) → DOMPurify.sanitize → v-html。
// computed 缓存：text/kind/markdown 不变则不重复 render + sanitize。
const html = computed(() => {
  if (!isMarkdown.value) return ''
  const raw = md.render(props.text)
  return DOMPurify.sanitize(raw, {
    // 兼容 Shiki 等高亮器的 class / data-language；不放行 inline style。
    ADD_ATTR: ['class', 'data-language', 'target', 'rel'],
  })
})

// 渲染后异步高亮:Shiki 按需 import,逐个代码块替换;失败/未知语言保持原 <pre><code> 兜底。
// 非流式(整段 push),每条消息只需在挂载 / text 变更后跑一次。
const root = ref<HTMLElement | null>(null)

function wrapScrollableTables(): void {
  const el = root.value
  if (!el) return
  const tables = el.querySelectorAll<HTMLTableElement>('table')
  for (const table of tables) {
    if (table.parentElement?.classList.contains('md-scroll')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'md-scroll md-table-scroll'
    table.parentNode?.insertBefore(wrapper, table)
    wrapper.appendChild(table)
  }
}

async function highlightBlocks() {
  const el = root.value
  if (!el) return
  const codes = el.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')
  for (const code of codes) {
    const lang = langFromClass(code.className)
    if (!lang) continue
    const pre = code.parentElement
    if (!pre) continue
    const html = await highlight(code.textContent ?? '', lang)
    // text 可能已在 await 期间变更:确认该 <pre> 仍在文档中再替换。
    if (html && pre.isConnected) pre.outerHTML = html
  }
}

// 识别文件路径链接:无 URI scheme、不以 // # / 开头的相对引用视为代码文件链接。
// 为命中的链接添加 .code-file-link class、移除 DOMPurify 强加的 target/rel 安全属性,
// 并在 click 时 dispatch 可冒泡的 c3:code-file-click 事件(供控制层导航到 codes 页)。
function enhanceCodeFileLinks(): void {
  const el = root.value
  if (!el) return
  const links = el.querySelectorAll<HTMLAnchorElement>('a[href]')
  for (const a of links) {
    const href = a.getAttribute('href') ?? ''
    // 协议相对 URL / 锚点 / 绝对路径 / 显式 URI scheme → 不是代码文件链接。
    if (
      href.startsWith('//') ||
      href.startsWith('#') ||
      href.startsWith('/') ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(href)
    )
      continue
    // 解析 #L<N> 行号后缀;含其他 fragment 格式的不予增强。
    let path = href
    let line: number | undefined
    const hashIndex = href.indexOf('#')
    if (hashIndex >= 0) {
      const fragment = href.slice(hashIndex + 1)
      const lineMatch = fragment.match(/^L(\d+)$/)
      if (!lineMatch) continue
      path = href.slice(0, hashIndex)
      line = parseInt(lineMatch[1], 10)
    }
    // 增强:class + 移除外链安全属性 + 自定义事件。
    a.classList.add('code-file-link')
    a.removeAttribute('target')
    a.removeAttribute('rel')
    a.onclick = (e) => {
      e.preventDefault()
      a.dispatchEvent(
        new CustomEvent('c3:code-file-click', {
          bubbles: true,
          detail: { path, line },
        }),
      )
    }
  }
}

onMounted(() => {
  if (isMarkdown.value) {
    wrapScrollableTables()
    void highlightBlocks()
    enhanceCodeFileLinks()
  }
})
watch(
  () => props.text,
  () => {
    if (isMarkdown.value)
      void nextTick(() => {
        wrapScrollableTables()
        void highlightBlocks()
        enhanceCodeFileLinks()
      })
  },
)
</script>

<template>
  <!-- assistant：经双防线后 v-html；其余 kind：纯文本插值（Vue 自动转义） -->
  <!-- html 已过 markdown-it(html:false) + DOMPurify.sanitize，v-html 在此是受控且有意为之 -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-if="isMarkdown" ref="root" class="md-body" v-html="html"></div>
  <template v-else>{{ text }}</template>
</template>

<style>
/* 代码文件链接与外部链接视觉区分:虚线、hover 加下划线(内链导航风格)。 */
.md-body a.code-file-link {
  text-decoration: underline;
  text-decoration-style: dotted;
}
.md-body a.code-file-link:hover {
  text-decoration-style: solid;
}
</style>
