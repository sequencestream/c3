<script setup lang="ts">
/*
 * SystemSettings.vue — 系统设置页容器。
 *
 * 纯容器:封装 SettingsPanel 弹窗,open/settings 由 App 注入,close/save 上抛。
 * 状态(settingsOpen / serverSettings)仍由 App.vue 持有。
 */
import SettingsPanel from './components/SettingsPanel/SettingsPanel.vue'
import type {
  McpApiKeyMeta,
  SessionBindingStats,
  SandboxHostStatus,
  SystemSettings,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
  WorkspaceInfo,
} from '@ccc/shared/protocol'

defineProps<{
  open: boolean
  settings: SystemSettings | null
  hostStatus: VendorHostStatus[]
  vendorAvailability: Record<VendorId, VendorRuntimeStatus>
  sandboxStatus: SandboxHostStatus | null
  bindingStats: SessionBindingStats | null
  mcpApiKeys: McpApiKeyMeta[]
  mcpApiKeyCreated: { meta: McpApiKeyMeta; key: string } | null
  workspaces: WorkspaceInfo[]
}>()

/** 名册操作的载荷类型:抽成具名类型,模板里的转发才不必写内联对象字面量类型。 */
export type CreateMcpApiKeyPayload = { name: string; workspaceIds: string[] }
export type UpdateMcpApiKeyPayload = { id: string; name?: string; workspaceIds?: string[] }

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  'remove-account': [payload: { username: string }]
  'set-admin-account': [payload: { username: string }]
  'create-mcp-api-key': [payload: CreateMcpApiKeyPayload]
  'update-mcp-api-key': [payload: UpdateMcpApiKeyPayload]
  'revoke-mcp-api-key': [id: string]
  'dismiss-mcp-api-key-reveal': []
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
    :mcp-api-keys="mcpApiKeys"
    :mcp-api-key-created="mcpApiKeyCreated"
    :workspaces="workspaces"
    @close="$emit('close')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @set-password="(p) => $emit('set-password', p)"
    @remove-account="(p) => $emit('remove-account', p)"
    @set-admin-account="(p) => $emit('set-admin-account', p)"
    @create-mcp-api-key="(p: CreateMcpApiKeyPayload) => $emit('create-mcp-api-key', p)"
    @update-mcp-api-key="(p: UpdateMcpApiKeyPayload) => $emit('update-mcp-api-key', p)"
    @revoke-mcp-api-key="(id: string) => $emit('revoke-mcp-api-key', id)"
    @dismiss-mcp-api-key-reveal="$emit('dismiss-mcp-api-key-reveal')"
  />
</template>
