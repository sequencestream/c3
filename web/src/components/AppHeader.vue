<script setup lang="ts">
/*
 * AppHeader.vue — 顶部栏:工作区切换器、tab nav、设置入口、连接状态。
 * 会话标题与权限模式已下移到聊天列顶部的 SessionTitleBar(WC-R9)。
 */
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspace: string | null
  status: 'connecting' | 'open' | 'closed'
  /** Top-bar tabs (data-driven so a future tab is one more entry). */
  tabs: { key: string; label: string }[]
  /** Currently selected tab key. */
  activeTab: string
  /** Tabs require a current workspace; disabled until one is selected. */
  tabsEnabled?: boolean
}>()

const emit = defineEmits<{
  'select-tab': [key: string]
  'open-settings': []
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
    <nav class="header-tabs" :class="{ disabled: tabsEnabled === false }">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="header-tab"
        :class="{ active: t.key === activeTab }"
        :disabled="tabsEnabled === false"
        @click="emit('select-tab', t.key)"
      >
        {{ t.label }}
      </button>
    </nav>
    <div class="header-right">
      <button class="icon-btn settings-btn" title="System settings" @click="emit('open-settings')">
        ⚙
      </button>
      <span class="status" :class="status === 'open' ? 'ok' : 'err'">
        {{ status }}
      </span>
    </div>
  </header>
</template>
