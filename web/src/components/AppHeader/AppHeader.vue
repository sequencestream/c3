<script setup lang="ts">
/*
 * AppHeader.vue — 顶部栏:工作区切换器、tab nav、viewMode 切换、设置入口、连接状态。
 * 会话标题与权限模式已下移到聊天列顶部的 SessionTitleBar(WC-R9)。
 *
 * 2026-06-08 新增 viewMode 支持:
 * - workspace 模式:左侧 WS switcher + 项目配置,中间标签页,右侧 viewMode 切换 + 设置
 * - workcenter 模式:左侧 workcenter 导航按钮,中间区域隐藏,右侧 viewMode 切换 + 设置
 */
import WorkspaceSwitcher from '../WorkspaceSwitcher/WorkspaceSwitcher.vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspace: string | null
  status: 'connecting' | 'open' | 'closed'
  /** Top-bar tabs (data-driven so a future tab is one more entry). */
  tabs: { key: string; label: string; badgeCount?: number }[]
  /** Currently selected tab key. */
  activeTab: string
  /** Tabs require a current workspace; disabled until one is selected. */
  tabsEnabled?: boolean
  /** Current view mode: workspace or workcenter. */
  viewMode: 'workspace' | 'workcenter'
}>()

const emit = defineEmits<{
  'select-tab': [key: string]
  'open-settings': []
  'open-project-config': []
  'add-workspace': [path: string]
  'select-workspace': [path: string]
  'remove-workspace': [path: string]
  'update:viewMode': [mode: 'workspace' | 'workcenter']
}>()
</script>

<template>
  <header>
    <!-- Left area: workspace mode — WorkspaceSwitcher + project config -->
    <template v-if="viewMode === 'workspace'">
      <WorkspaceSwitcher
        :workspaces="workspaces"
        :current-workspace="currentWorkspace"
        @add-workspace="emit('add-workspace', $event)"
        @select-workspace="emit('select-workspace', $event)"
        @remove-workspace="emit('remove-workspace', $event)"
      />
      <button
        class="icon-btn project-config-btn"
        :title="t('projectConfig.entry.tooltip')"
        :disabled="!currentWorkspace"
        @click="emit('open-project-config')"
      >
        ⚙
      </button>
    </template>

    <!-- Left area: workcenter mode — nav button -->
    <template v-else>
      <button class="header-tab active" disabled>
        {{ t('workcenter.title') }}
      </button>
    </template>

    <!-- Middle: workspace tabs (hidden in workcenter mode) -->
    <nav
      v-if="viewMode === 'workspace'"
      class="header-tabs"
      :class="{ disabled: tabsEnabled === false }"
    >
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="header-tab"
        :class="{ active: tab.key === activeTab, 'has-badge': (tab.badgeCount ?? 0) > 0 }"
        :disabled="tabsEnabled === false"
        @click="emit('select-tab', tab.key)"
      >
        {{ tab.label }}
        <span v-if="tab.badgeCount" class="tab-badge">{{ tab.badgeCount }}</span>
      </button>
    </nav>

    <!-- Right area: viewMode toggle + settings + status -->
    <div class="header-right">
      <div class="view-mode-toggle">
        <button
          class="vm-toggle-btn"
          :class="{ active: viewMode === 'workspace' }"
          @click="emit('update:viewMode', 'workspace')"
        >
          {{ t('nav.viewMode.workspace') }}
        </button>
        <button
          class="vm-toggle-btn"
          :class="{ active: viewMode === 'workcenter' }"
          @click="emit('update:viewMode', 'workcenter')"
        >
          {{ t('nav.viewMode.workcenter') }}
        </button>
      </div>

      <button
        class="icon-btn settings-btn"
        :title="t('nav.settings.tooltip')"
        @click="emit('open-settings')"
      >
        ⚙
      </button>
      <span class="status" :class="status === 'open' ? 'ok' : 'err'">
        {{ status }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.view-mode-toggle {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.vm-toggle-btn {
  background: transparent;
  border: none;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--c-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
  line-height: 1.6;
}
.vm-toggle-btn:not(:last-child) {
  border-right: 1px solid var(--c-border);
}
.vm-toggle-btn:hover {
  color: var(--c-text);
  background: var(--c-card);
}
.vm-toggle-btn.active {
  color: var(--c-text);
  background: var(--c-card);
}
</style>
