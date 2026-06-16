<script setup lang="ts">
/*
 * CodeFileView.vue — 单个文件 tab 的内容渲染。
 *
 * 复用既有 Shiki 高亮管线(lib/highlight):按文件后缀推断语言,白名单外/二进制/超限
 * 优雅降级为纯文本 <pre>。左侧行号 gutter 与代码逐行对齐(white-space:pre 不换行,
 * 每个源码行恰好一行高);内容搜索命中时滚动并高亮目标行。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import { highlight } from '@/lib/highlight'
import { basename, formatFileSize, langFromPath, type CodeTab } from '@/lib/codes-view'

const props = defineProps<{ tab: CodeTab }>()
const { t } = useTypedI18n()

const file = computed(() => props.tab.file)
const content = computed(() => file.value?.content ?? '')
const lineCount = computed(() => (content.value ? content.value.split('\n').length : 0))
// 可渲染 = 已加载、非二进制、未超限、且有文本内容。
const renderable = computed(
  () => !!file.value && !file.value.binary && !file.value.truncated && content.value.length > 0,
)

const scrollEl = ref<HTMLElement | null>(null)
const gutterEl = ref<HTMLElement | null>(null)
// Shiki 高亮后的 HTML(已过 DOMPurify、class-only);null = 走纯文本兜底。
const highlighted = ref<string | null>(null)
const markerTop = ref(0)
const markerHeight = ref(0)
const showMarker = ref(false)

async function renderHighlight(): Promise<void> {
  highlighted.value = null
  const f = file.value
  if (!renderable.value || !f || f.content == null) return
  const lang = langFromPath(props.tab.path)
  if (!lang) return // 白名单外:保持纯文本兜底
  const html = await highlight(f.content, lang)
  // content 可能在 await 期间已切换(切 tab):仅当仍是同一文件时采用。
  if (file.value === f) highlighted.value = html
}

// 把目标行滚动到可视中部并高亮(读 gutter 子元素的真实几何,免去 line-height 估算)。
function focusLine(): void {
  const line = props.tab.focusLine
  const gutter = gutterEl.value
  const scroll = scrollEl.value
  if (!line || line < 1 || !gutter || !scroll) {
    showMarker.value = false
    return
  }
  const row = gutter.children[line - 1] as HTMLElement | undefined
  if (!row) {
    showMarker.value = false
    return
  }
  markerTop.value = row.offsetTop
  markerHeight.value = row.offsetHeight
  showMarker.value = true
  scroll.scrollTop = row.offsetTop - scroll.clientHeight / 2 + row.offsetHeight / 2
}

// 文件内容或 tab 切换:重新高亮后再定位。
watch(
  () => [props.tab.path, file.value] as const,
  () => {
    void renderHighlight().then(() => nextTick(focusLine))
  },
  { immediate: true },
)
// 同一 tab 被不同搜索行重新聚焦时,仅重定位。
watch(
  () => props.tab.focusLine,
  () => void nextTick(focusLine),
)
</script>

<template>
  <div class="code-file">
    <div class="code-file-meta">
      <span class="code-file-name">{{ basename(tab.path) }}</span>
      <span class="code-file-path">{{ tab.path }}</span>
    </div>

    <div v-if="!file || tab.loading" class="code-file-status">{{ t('codes.file.loading') }}</div>
    <div v-else-if="file.binary" class="code-file-status">{{ t('codes.file.binary') }}</div>
    <div v-else-if="file.truncated" class="code-file-status">
      {{ t('codes.file.tooLarge', { size: formatFileSize(file.size) }) }}
    </div>
    <div v-else-if="content.length === 0" class="code-file-status">{{ t('codes.file.empty') }}</div>

    <div v-else ref="scrollEl" class="code-scroll">
      <div class="code-body">
        <div
          v-if="showMarker"
          class="line-marker"
          :style="{ top: `${markerTop}px`, height: `${markerHeight}px` }"
        ></div>
        <div ref="gutterEl" class="code-gutter" aria-hidden="true">
          <span
            v-for="n in lineCount"
            :key="n"
            class="gutter-num"
            :class="{ focused: n === tab.focusLine }"
            >{{ n }}</span
          >
        </div>
        <div class="code-main">
          <!-- highlighted 已过 markdown 同款 DOMPurify(class-only,不放行 style),v-html 受控 -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-if="highlighted" class="code-content" v-html="highlighted"></div>
          <pre v-else class="code-content code-plain"><code>{{ content }}</code></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-file {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
}

.code-file-meta {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-panel);
}
.code-file-name {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-text);
}
.code-file-path {
  min-width: 0;
  font-size: var(--fs-micro, 11px);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-file-status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}

.code-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--c-code);
}

.code-body {
  position: relative;
  display: flex;
  align-items: flex-start;
  min-height: 100%;
  width: max-content;
  min-width: 100%;
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  line-height: var(--lh-code);
}

.line-marker {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 0;
  background: var(--c-primary-soft, rgba(120, 160, 255, 0.16));
  pointer-events: none;
}

.code-gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: var(--sp-3) var(--sp-2);
  text-align: right;
  user-select: none;
  background: var(--c-code);
  border-right: 1px solid var(--c-border);
  color: var(--c-text-disabled);
}
.gutter-num {
  display: block;
  min-width: 2.5ch;
}
.gutter-num.focused {
  color: var(--c-text);
  font-weight: 600;
}

.code-main {
  flex: 1;
  min-width: 0;
}
.code-content {
  margin: 0;
  padding: var(--sp-3);
  background: transparent;
  white-space: pre;
}
.code-plain code {
  display: block;
  background: transparent;
  padding: 0;
  white-space: pre;
}

/* 复用 lib/highlight 的哨兵 token class;此处脱离 .md-body,显式绑定同一组配色变量。 */
.code-content :deep(pre.shiki) {
  margin: 0;
  padding: 0;
  background: transparent;
  white-space: pre;
}
.code-content :deep(.shiki .line) {
  display: inline;
}
.code-content :deep(.shiki .t-comment) {
  color: var(--c-text-disabled);
  font-style: italic;
}
.code-content :deep(.shiki .t-keyword) {
  color: var(--c-primary-2);
}
.code-content :deep(.shiki .t-string) {
  color: var(--c-success);
}
.code-content :deep(.shiki .t-function) {
  color: var(--c-primary);
}
.code-content :deep(.shiki .t-number) {
  color: var(--c-warning);
}
.code-content :deep(.shiki .t-type) {
  color: var(--c-purple-text);
}
.code-content :deep(.shiki .t-variable) {
  color: var(--c-text);
}
.code-content :deep(.shiki .t-punctuation) {
  color: var(--c-text-muted);
}
</style>
