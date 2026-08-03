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
  SandboxHostStatus,
  SystemSettings,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
} from '@ccc/shared/protocol'

defineProps<{
  open: boolean
  settings: SystemSettings | null
  hostStatus: VendorHostStatus[]
  vendorAvailability: Record<VendorId, VendorRuntimeStatus>
  sandboxStatus: SandboxHostStatus | null
  bindingStats: SessionBindingStats | null
}>()

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  'remove-account': [payload: { username: string }]
  'set-admin-account': [payload: { username: string }]
}>()
</script>

<template>
  <SettingsPanel
    :open="open"
    :settings="settings"
    :host-status="hostStatus"
    :vendor-availability="vendorAvailability"
    :sandbox-status="sandboxStatus"
    :binding-stats="bindingStats"
    @close="$emit('close')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @set-password="(p) => $emit('set-password', p)"
    @remove-account="(p) => $emit('remove-account', p)"
    @set-admin-account="(p) => $emit('set-admin-account', p)"
  />
</template>
