<script setup lang="ts">
/*
 * SessionTitleBar.vue — 聊天列(.content)顶部的会话标题行:左侧会话标题。
 * 两种用途:
 *  - 「会话」tab(WC-R9):右侧渲染权限模式下拉,模式切换经 set-mode 上抛。
 *  - 需求视图(RM-R3):show-mode=false 不渲染模式选择器(新建沟通会话的 "+"
 *    按钮改由左栏需求列表头部承载)。
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
  }>(),
  {
    mode: 'default',
    modeOptions: () => [],
    showMode: true,
  },
)

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
}>()
</script>

<template>
  <div class="session-title-bar">
    <span class="session-title-text" :title="activeTitle">{{ activeTitle }}</span>
    <slot name="action" />
    <label v-if="showMode" class="mode">
      <BaseDropdown
        :model-value="mode"
        :options="modeOptions"
        aria-label="Permission mode"
        @update:model-value="emit('set-mode', $event)"
      />
    </label>
  </div>
</template>
