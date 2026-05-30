<script setup lang="ts">
/*
 * AppHeader.vue — 顶部栏：会话面包屑、权限模式下拉、设置入口、连接状态。
 */
import BaseDropdown from './BaseDropdown.vue'
import type { PermissionMode } from '@ccc/shared/protocol'

defineProps<{
  hasActiveSession: boolean
  activeWorkspaceName: string
  activeTitle: string
  mode: PermissionMode
  modeOptions: { value: PermissionMode; label: string }[]
  status: 'connecting' | 'open' | 'closed'
}>()

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
  'open-settings': []
}>()
</script>

<template>
  <header>
    <h1 v-if="!hasActiveSession">c3 — Claude Code Center</h1>
    <div v-else class="crumbs">
      <span class="crumb-ws">{{ activeWorkspaceName }}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-session">{{ activeTitle }}</span>
      <label class="mode">
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
