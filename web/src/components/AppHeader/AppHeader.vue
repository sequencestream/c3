<script setup lang="ts">
/*
 * AppHeader.vue — 顶部栏:工作区切换器、tab nav、设置入口、连接状态。
 * 会话标题与权限模式已下移到聊天列顶部的 SessionTitleBar(WC-R9)。
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
}>()

const emit = defineEmits<{
  'select-tab': [key: string]
  'open-settings': []
  'open-project-config': []
  'add-workspace': [path: string]
  'select-workspace': [path: string]
  'remove-workspace': [path: string]
}>()
</script>

<template>
  <header>
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
    <nav class="header-tabs" :class="{ disabled: tabsEnabled === false }">
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
    <div class="header-right">
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
