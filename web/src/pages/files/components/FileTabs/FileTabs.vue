<script setup lang="ts">
/*
 * FileTabs.vue — 右栏多 tab 容器。
 *
 * 顶部 tab 条(每个可手动关闭),下方渲染当前激活 tab 的文件内容。无打开 tab 时空态。
 * tab 的打开/聚焦/关闭逻辑在 controls/files-actions;本组件只展示 + 上抛点击。
 */
import { reactive, watch } from 'vue'
import { basename, type FileTab, type FileViewMode } from '@/lib/files-view'
import { useTypedI18n } from '@/i18n'
import FileView from '../FileView/FileView.vue'

const props = defineProps<{
  tabs: FileTab[]
  activePath: string | null
  activeTab: FileTab | null
}>()

const emit = defineEmits<{
  select: [path: string]
  close: [path: string]
}>()

const { t } = useTypedI18n()

// 每个已打开 tab 的视图模式(原文/预览),按 path 记忆。纯前端内存态,不落库、不进协议。
// FileView 用 :key="path" 逐 tab 重挂载,状态必须由本容器持有才能跨 tab 切换保留。
const viewModes = reactive(new Map<string, FileViewMode>())

function viewModeFor(path: string): FileViewMode {
  return viewModes.get(path) ?? 'preview'
}

function setViewMode(path: string, mode: FileViewMode): void {
  viewModes.set(path, mode)
}

function onClose(path: string): void {
  // 关闭即遗忘:重新打开同一路径视为新 tab,回到默认 'preview'。
  viewModes.delete(path)
  emit('close', path)
}

// 兜底:若 tab 被外部途径移除(非本组件关闭按钮),清理其残留模式记录。
watch(
  () => props.tabs.map((tab) => tab.path),
  (paths) => {
    const open = new Set(paths)
    for (const path of viewModes.keys()) {
      if (!open.has(path)) viewModes.delete(path)
    }
  },
)
</script>

<template>
  <div class="file-tabs">
    <div v-if="tabs.length" class="tab-strip" role="tablist">
      <div
        v-for="tab in tabs"
        :key="tab.path"
        class="tab"
        :class="{ active: tab.path === activePath }"
        role="tab"
        :aria-selected="tab.path === activePath"
        :title="tab.path"
        @click="emit('select', tab.path)"
      >
        <span class="tab-name">{{ basename(tab.path) }}</span>
        <button
          class="tab-close"
          :title="t('files.tab.close')"
          :aria-label="t('files.tab.close')"
          @click.stop="onClose(tab.path)"
        >
          ×
        </button>
      </div>
    </div>

    <FileView
      v-if="activeTab"
      :key="activeTab.path"
      :tab="activeTab"
      :view-mode="viewModeFor(activeTab.path)"
      @update:view-mode="(mode: FileViewMode) => setViewMode(activeTab!.path, mode)"
    />
    <div v-else class="tabs-empty">{{ t('files.tabs.empty') }}</div>
  </div>
</template>

<style scoped>
.file-tabs {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
}

.tab-strip {
  flex-shrink: 0;
  display: flex;
  overflow-x: auto;
  background: var(--c-panel);
  border-bottom: 1px solid var(--c-border);
  -webkit-overflow-scrolling: touch;
}

.tab {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  max-width: 200px;
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border-right: 1px solid var(--c-border);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tab:hover {
  background: var(--c-card);
}
.tab.active {
  color: var(--c-text);
  background: var(--c-bg);
  border-bottom-color: var(--c-primary);
}
.tab-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-close {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.tab-close:hover {
  background: var(--c-border);
  color: var(--c-text);
}

.tabs-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}
</style>
