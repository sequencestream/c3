<script setup lang="ts">
/*
 * Codes.vue — 代码浏览页容器。
 *
 * 桌面双栏:左 CodeTree(搜索框 + 懒加载树)+ 右 CodeTabs(多 tab 文件查看)。
 * 移动端经 MobileStack 退化为 树 → 文件 两级 drill-down。所有状态由 App.vue 持有、
 * 经 props 注入,动作经 emit 上抛(controls/codes-actions 落地服务端往返)。
 *
 * 前端仅持有并透传 workspace 相对路径 + 不透明 workspaceId;任何越界判断由服务端
 * guard 决定,本页不存在构造绝对路径/越界路径的入口。
 */
import { computed, ref } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import CodeTree from './components/CodeTree/CodeTree.vue'
import CodeTabs from './components/CodeTabs/CodeTabs.vue'
import type { CodeDirEntry, CodeSearchHit, CodeSearchMode } from '@ccc/shared/protocol'
import type { CodeTab, CodesSearchResultView } from '@/lib/codes-view'

const props = defineProps<{
  dirs: Record<string, CodeDirEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>
  tabs: CodeTab[]
  activePath: string | null
  activeTab: CodeTab | null
  searchMode: CodeSearchMode
  searchQuery: string
  searchPattern: string
  searchResult: CodesSearchResultView | null
  searchLoading: boolean
}>()

const emit = defineEmits<{
  'toggle-dir': [rel: string]
  'open-file': [path: string]
  'open-hit': [hit: CodeSearchHit]
  'close-tab': [path: string]
  'select-tab': [path: string]
  'set-search-mode': [mode: CodeSearchMode]
  'update:searchQuery': [value: string]
  'update:searchPattern': [value: string]
  'run-search': []
  toast: [message: string]
}>()

const rootEntries = computed<CodeDirEntry[] | null>(() => props.dirs[''] ?? null)

const mobilePanes = [
  { key: 'tree', title: 'Files' },
  { key: 'viewer', title: 'Viewer' },
] as const
type MobilePaneKey = (typeof mobilePanes)[number]['key']

const mobileActiveKey = ref<MobilePaneKey>('tree')
const mobileActiveToken = computed(() => props.activePath ?? 'tree')

function openFile(path: string): void {
  mobileActiveKey.value = 'viewer'
  emit('open-file', path)
}
function openHit(hit: CodeSearchHit): void {
  if (hit.type === 'file') mobileActiveKey.value = 'viewer'
  emit('open-hit', hit)
}
function handleMobileBack(targetKey: string): void {
  if (targetKey === 'tree') mobileActiveKey.value = 'tree'
}
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Files"
    @back="handleMobileBack"
  >
    <template #tree>
      <CodeTree
        :root-entries="rootEntries"
        :dirs="dirs"
        :expanded="expanded"
        :loading-dirs="loadingDirs"
        :active-path="activePath"
        :search-mode="searchMode"
        :search-query="searchQuery"
        :search-pattern="searchPattern"
        :search-result="searchResult"
        :search-loading="searchLoading"
        @toggle-dir="(rel: string) => emit('toggle-dir', rel)"
        @open-file="openFile"
        @open-hit="openHit"
        @set-search-mode="(m: CodeSearchMode) => emit('set-search-mode', m)"
        @update:search-query="(v: string) => emit('update:searchQuery', v)"
        @update:search-pattern="(v: string) => emit('update:searchPattern', v)"
        @run-search="emit('run-search')"
        @toast="(message: string) => emit('toast', message)"
      />
    </template>

    <template #viewer>
      <CodeTabs
        :tabs="tabs"
        :active-path="activePath"
        :active-tab="activeTab"
        @select="(path: string) => emit('select-tab', path)"
        @close="(path: string) => emit('close-tab', path)"
      />
    </template>
  </MobileStack>
</template>
