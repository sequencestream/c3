<script setup lang="ts">
/*
 * AppHeader.vue — 顶部栏：会话面包屑、权限模式下拉、设置入口、连接状态。
 */
import BaseDropdown from './BaseDropdown.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import type { PermissionMode, WorkspaceInfo } from '@ccc/shared/protocol'

defineProps<{
  hasActiveSession: boolean
  workspaces: WorkspaceInfo[]
  currentWorkspace: string | null
  activeTitle: string
  mode: PermissionMode
  modeOptions: { value: PermissionMode; label: string }[]
  status: 'connecting' | 'open' | 'closed'
  /** Hidden for the requirement comm session, which is pinned to `default`. */
  modeSelectable?: boolean
}>()

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
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
    <div v-if="hasActiveSession" class="crumbs">
      <span class="crumb-sep">›</span>
      <span class="crumb-session">{{ activeTitle }}</span>
      <label v-if="modeSelectable !== false" class="mode">
        <span class="mode-paren">(</span>
        <BaseDropdown
          :model-value="mode"
          :options="modeOptions"
          :disabled="!hasActiveSession"
          aria-label="Permission mode"
          @update:model-value="emit('set-mode', $event)"
        />
        <span class="mode-paren">)</span>
      </label>
    </div>
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
