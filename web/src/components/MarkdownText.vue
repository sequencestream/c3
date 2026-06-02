<script setup lang="ts">
/*
 * MarkdownText.vue — 单条文本消息的渲染器。
 *
 * 仅对 assistant 文本启用 Markdown(markdown-it html:false → DOMPurify → v-html
 * 两道防线);user / system 走纯文本转义直出（保留 .msg 的换行语义）。工具消息不进
 * 本组件，仍由 ChatMessages 以 <pre class="tool-body"> 原样渲染。本项目非流式（整段
 * push），无需缓冲层 / 未闭合标签处理。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type { TextMsg } from '../lib/chat-types'
import { highlight, langFromClass } from '../lib/highlight'

const props = defineProps<{
  text: string
  kind: TextMsg['kind']
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

// 渲染管线固定顺序：markdown-it(html:false) → DOMPurify.sanitize → v-html。
// computed 缓存：text/kind 不变则不重复 render + sanitize。
const html = computed(() => {
  if (props.kind !== 'assistant') return ''
  const raw = md.render(props.text)
  return DOMPurify.sanitize(raw, {
    // 兼容 Shiki 等高亮器的 class / data-language；不放行 inline style。
    ADD_ATTR: ['class', 'data-language', 'target', 'rel'],
  })
})

const isMarkdown = computed(() => props.kind === 'assistant')

// 渲染后异步高亮:Shiki 按需 import,逐个代码块替换;失败/未知语言保持原 <pre><code> 兜底。
// 非流式(整段 push),每条消息只需在挂载 / text 变更后跑一次。
const root = ref<HTMLElement | null>(null)

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

onMounted(() => {
  if (isMarkdown.value) void highlightBlocks()
})
watch(
  () => props.text,
  () => {
    if (isMarkdown.value) void nextTick(highlightBlocks)
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
