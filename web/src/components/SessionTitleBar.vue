<script setup lang="ts">
/*
 * SessionTitleBar.vue — 聊天列(.content)顶部的会话标题行:左侧会话标题。
 * 两种用途:
 *  - 「会话」tab(WC-R9):右侧渲染权限模式下拉,模式切换经 set-mode 上抛。
 *  - 需求视图(RM-R3):show-mode=false 不渲染模式选择器,show-new=true 渲染
 *    "+" 按钮,点击经 new-session 上抛以开启全新沟通会话。
 * presentational:所有交互上抛由 App 处理。
 */
import BaseDropdown from './BaseDropdown.vue'
import type { PermissionMode } from '@ccc/shared/protocol'

withDefaults(
  defineProps<{
    activeTitle: string
    mode?: PermissionMode
    modeOptions?: { value: PermissionMode; label: string }[]
    showMode?: boolean
    showNew?: boolean
  }>(),
  {
    mode: 'default',
    modeOptions: () => [],
    showMode: true,
    showNew: false,
  },
)

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
  'new-session': []
}>()
</script>

<template>
  <div class="session-title-bar">
    <span class="session-title-text" :title="activeTitle">{{ activeTitle }}</span>
    <label v-if="showMode" class="mode">
      <BaseDropdown
        :model-value="mode"
        :options="modeOptions"
        aria-label="Permission mode"
        @update:model-value="emit('set-mode', $event)"
      />
    </label>
    <button
      v-if="showNew"
      type="button"
      class="new-session-btn"
      aria-label="开启新沟通会话"
      title="开启新沟通会话"
      @click="emit('new-session')"
    >
      +
    </button>
  </div>
</template>
