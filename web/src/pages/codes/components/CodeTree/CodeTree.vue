<script setup lang="ts">
/*
 * CodeTree.vue — 左栏:顶部搜索框 + 懒加载文件树 / 搜索结果。
 *
 * 搜索框 filename/content 两模式切换;有查询词时展示搜索结果(点结果打开对应文件,
 * content 命中带行号并定位),否则展示树。所有路径均为 workspace 相对路径。
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import type { CodeDirEntry, CodeSearchHit, CodeSearchMode } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import type { CodesSearchResultView } from '@/lib/codes-view'
import CodeTreeNode from './CodeTreeNode.vue'

const props = defineProps<{
  rootEntries: CodeDirEntry[] | null
  dirs: Record<string, CodeDirEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>
  activePath: string | null
  searchMode: CodeSearchMode
  searchQuery: string
  searchResult: CodesSearchResultView | null
  searchLoading: boolean
}>()

const emit = defineEmits<{
  'toggle-dir': [rel: string]
  'open-file': [path: string]
  'open-hit': [hit: CodeSearchHit]
  'set-search-mode': [mode: CodeSearchMode]
  'update:searchQuery': [value: string]
  'run-search': []
}>()

const { t } = useTypedI18n()

// 侧栏展开态:持久化 UI 状态(镜像 WorkSessionList 折叠范式)。展开态把文件树宽度
// 翻倍(280→560px),便于看清深层目录 / 长 workspace 路径下的文件名。跨刷新保持;
// localStorage 不可用时由 composable 内置 try/catch 降级为纯内存 ref。
const treeExpanded = usePersistentToggle('c3.codesTreeExpanded')

function toggleExpand(): void {
  treeExpanded.value = !treeExpanded.value
}

const searchActive = computed(() => props.searchQuery.trim().length > 0)
const SEARCH_MODES: CodeSearchMode[] = ['filename', 'content']

// Debounced live search: fire shortly after the user stops typing (Enter still
// triggers immediately via the input handler). The server bounds every search by
// result count + timeout, so a per-pause request is safe.
let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.searchQuery,
  () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => emit('run-search'), 250)
  },
)
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

function runNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  emit('run-search')
}
</script>

<template>
  <div class="code-tree" :class="{ expanded: treeExpanded }">
    <div class="tree-head">
      <div class="tree-head-left">
        <button
          type="button"
          class="tree-collapse-btn"
          :title="
            treeExpanded
              ? t('codes.tree.toggle.collapse.tooltip')
              : t('codes.tree.toggle.expand.tooltip')
          "
          :aria-label="
            treeExpanded
              ? t('codes.tree.toggle.collapse.tooltip')
              : t('codes.tree.toggle.expand.tooltip')
          "
          :aria-pressed="treeExpanded"
          data-testid="codes-tree-toggle"
          @click="toggleExpand"
        >
          {{ treeExpanded ? '⇤' : '⇥' }}
        </button>
        <span class="tree-title">{{ t('codes.tree.title.label') }}</span>
      </div>
      <span class="tree-actions"></span>
    </div>
    <div class="search-box">
      <div class="search-modes">
        <button
          v-for="m in SEARCH_MODES"
          :key="m"
          class="mode-btn"
          :class="{ active: m === searchMode }"
          @click="emit('set-search-mode', m)"
        >
          {{ m === 'filename' ? t('codes.search.mode.filename') : t('codes.search.mode.content') }}
        </button>
      </div>
      <input
        :value="searchQuery"
        class="search-input"
        type="search"
        :placeholder="t('codes.search.placeholder')"
        @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
        @keydown.enter="runNow"
      />
    </div>

    <div class="tree-scroll">
      <!-- Search results -->
      <template v-if="searchActive">
        <div v-if="searchLoading" class="hint">{{ t('codes.search.searching') }}</div>
        <template v-else-if="searchResult">
          <div v-if="searchResult.hits.length === 0" class="hint">
            {{ t('codes.search.empty') }}
          </div>
          <template v-else>
            <button
              v-for="(hit, i) in searchResult.hits"
              :key="`${hit.path}:${hit.line ?? 0}:${i}`"
              class="hit-row"
              :class="{ active: hit.path === activePath }"
              :title="hit.path"
              @click="emit('open-hit', hit)"
            >
              <span class="hit-path">
                {{ hit.path }}<span v-if="hit.line" class="hit-line">:{{ hit.line }}</span>
              </span>
              <span v-if="hit.lineText" class="hit-text">{{ hit.lineText.trim() }}</span>
            </button>
            <div v-if="searchResult.truncated" class="hint">
              {{ t('codes.search.truncated', { count: searchResult.hits.length }) }}
            </div>
            <div v-if="searchResult.timedOut" class="hint">{{ t('codes.search.timedOut') }}</div>
          </template>
        </template>
      </template>

      <!-- File tree -->
      <template v-else>
        <div v-if="!rootEntries" class="hint">{{ t('codes.tree.loading') }}</div>
        <div v-else-if="rootEntries.length === 0" class="hint">{{ t('codes.tree.empty') }}</div>
        <CodeTreeNode
          v-for="entry in rootEntries ?? []"
          :key="entry.path"
          :entry="entry"
          :dirs="dirs"
          :expanded="expanded"
          :loading-dirs="loadingDirs"
          :active-path="activePath"
          :depth="0"
          @toggle="emit('toggle-dir', $event)"
          @open="emit('open-file', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.code-tree {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  overflow: hidden;
  transition: width 0.2s ease;
}
/* 展开态:宽度翻倍,便于看清深层目录 / 长路径下的文件名(镜像 .sidebar.expanded) */
.code-tree.expanded {
  width: 560px;
}
/* 移动端 drill-down:文件树即当前单栏,撑满 pane 全宽(对齐 MobileStack 范式) */
@media (max-width: 767px) {
  .code-tree,
  .code-tree.expanded {
    width: 100%;
    min-width: 0;
    border-right: 0;
  }
}

/* 侧栏头:左侧展开/收缩切换 + 「Files」标题,右侧预留操作位(镜像 .sidebar-head) */
.tree-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.tree-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
/* 切换按钮:图标反映点击后将切换到的目标态(⇥ 展开 / ⇤ 收起) */
.tree-collapse-btn {
  flex-shrink: 0;
  background: var(--c-input);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
}
.tree-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.tree-title {
  font-size: var(--fs-badge);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--c-text-muted);
}
.tree-actions {
  display: inline-flex;
  flex-shrink: 0;
}

.search-box {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.search-modes {
  display: inline-flex;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.mode-btn {
  flex: 1;
  padding: 3px 8px;
  border: 0;
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-micro, 11px);
  cursor: pointer;
}
.mode-btn:not(:last-child) {
  border-right: 1px solid var(--c-border);
}
.mode-btn.active {
  background: var(--c-card);
  color: var(--c-text);
}
.search-input {
  width: 100%;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-input);
  color: var(--c-text);
  font-size: var(--fs-caption);
}

.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-1) 0;
}

.hint {
  padding: var(--sp-2) var(--sp-3);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  font-style: italic;
}

.hit-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-1) var(--sp-3);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.hit-row:hover {
  background: var(--c-card);
}
.hit-row.active {
  background: var(--c-card);
}
.hit-path {
  font-size: var(--fs-caption);
  color: var(--c-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-line {
  color: var(--c-text-muted);
}
.hit-text {
  font-family: var(--font-mono);
  font-size: var(--fs-micro, 11px);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
