<script setup lang="ts">
/*
 * SessionTitleBar.vue — 聊天列(.content)顶部的会话标题行:左侧会话标题。
 * 两种用途:
 *  - 「会话」tab(WC-R9):右侧渲染权限模式下拉,模式切换经 set-mode 上抛。
 *  - 需求视图(RM-R3):show-mode=false 不渲染模式选择器(新建沟通会话的 "+"
 *    按钮改由左栏需求列表头部承载)。
 * presentational:所有交互上抛由 App 处理。
 */
import BaseDropdown from '../BaseDropdown/BaseDropdown.vue'
import type { PermissionMode, VendorId } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    activeTitle: string
    mode?: PermissionMode
    modeOptions?: { value: PermissionMode; label: string }[]
    showMode?: boolean
    /** The session's resolved agent vendor; absent ⇒ no dot (comm sessions). */
    vendor?: VendorId | null
  }>(),
  {
    mode: 'default',
    modeOptions: () => [],
    showMode: true,
    vendor: null,
  },
)

// The vendor dot's colour + brand label (for its tooltip), or null when no vendor.
const vendorColor = (): string | null => (props.vendor ? VENDOR_COLOR[props.vendor] : null)
const vendorLabel = (): string => (props.vendor ? VENDOR_LABEL[props.vendor] : '')

const emit = defineEmits<{
  'set-mode': [mode: PermissionMode]
}>()
</script>

<template>
  <div class="session-title-bar">
    <span
      v-if="vendorColor()"
      class="vendor-dot"
      :style="{ backgroundColor: vendorColor() as string }"
      :title="vendorLabel()"
      data-testid="session-vendor-dot"
    ></span>
    <span class="session-title-text" :title="activeTitle">{{ activeTitle }}</span>
    <slot name="action" />
    <label v-if="showMode" class="mode">
      <BaseDropdown
        :model-value="mode"
        :options="modeOptions"
        :aria-label="t('session.titleBar.mode.ariaLabel')"
        @update:model-value="emit('set-mode', $event)"
      />
    </label>
  </div>
</template>
