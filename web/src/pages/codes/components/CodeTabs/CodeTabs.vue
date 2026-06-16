<script setup lang="ts">
/*
 * CodeTabs.vue — 右栏多 tab 容器。
 *
 * 顶部 tab 条(每个可手动关闭),下方渲染当前激活 tab 的文件内容。无打开 tab 时空态。
 * tab 的打开/聚焦/关闭逻辑在 controls/codes-actions;本组件只展示 + 上抛点击。
 */
import { basename, type CodeTab } from '@/lib/codes-view'
import { useTypedI18n } from '@/i18n'
import CodeFileView from '../CodeFileView/CodeFileView.vue'

defineProps<{
  tabs: CodeTab[]
  activePath: string | null
  activeTab: CodeTab | null
}>()

const emit = defineEmits<{
  select: [path: string]
  close: [path: string]
}>()

const { t } = useTypedI18n()
</script>

<template>
  <div class="code-tabs">
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
          :title="t('codes.tab.close')"
          :aria-label="t('codes.tab.close')"
          @click.stop="emit('close', tab.path)"
        >
          ×
        </button>
      </div>
    </div>

    <CodeFileView v-if="activeTab" :key="activeTab.path" :tab="activeTab" />
    <div v-else class="tabs-empty">{{ t('codes.tabs.empty') }}</div>
  </div>
</template>

<style scoped>
.code-tabs {
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
