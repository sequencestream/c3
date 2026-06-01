<script setup lang="ts">
/*
 * SessionTitleBar.vue — 聊天列(.content)顶部的会话标题行:左侧会话标题,
 * 右侧权限模式下拉。仅在「会话」tab 且有活动会话时由 App 渲染(WC-R9)。
 * presentational:模式切换经 set-mode 上抛,App 走 setMode 乐观更新逻辑。
 */
import BaseDropdown from './BaseDropdown.vue'
import type { PermissionMode } from '@ccc/shared/protocol'

defineProps<{
  activeTitle: string
  mode: PermissionMode
  modeOptions: { value: PermissionMode; label: string }[]
}>()

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
}>()
</script>

<template>
  <div class="session-title-bar">
    <span class="session-title-text" :title="activeTitle">{{ activeTitle }}</span>
    <label class="mode">
      <BaseDropdown
        :model-value="mode"
        :options="modeOptions"
        aria-label="Permission mode"
        @update:model-value="emit('set-mode', $event)"
      />
    </label>
  </div>
</template>
