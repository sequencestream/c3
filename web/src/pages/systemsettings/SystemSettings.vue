<script setup lang="ts">
/*
 * SystemSettings.vue — 系统设置页容器。
 *
 * 纯容器:封装 SettingsPanel 弹窗,open/settings 由 App 注入,close/save 上抛。
 * 状态(settingsOpen / serverSettings)仍由 App.vue 持有。
 */
import SettingsPanel from './components/SettingsPanel/SettingsPanel.vue'
import type {
  SessionBindingStats,
  SkillSupportState,
  SystemSettings,
  UiLang,
  VendorHostStatus,
  VendorId,
} from '@ccc/shared/protocol'

defineProps<{
  open: boolean
  settings: SystemSettings | null
  hostStatus: VendorHostStatus[]
  bindingStats: SessionBindingStats | null
  skillSupport: Record<VendorId, SkillSupportState> | null
}>()

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  'set-ui-lang': [lang: UiLang]
}>()
</script>

<template>
  <SettingsPanel
    :open="open"
    :settings="settings"
    :host-status="hostStatus"
    :binding-stats="bindingStats"
    :skill-support="skillSupport"
    @close="$emit('close')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @set-ui-lang="(l: UiLang) => $emit('set-ui-lang', l)"
  />
</template>
