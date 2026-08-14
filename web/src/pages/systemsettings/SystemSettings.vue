<script setup lang="ts">
/*
 * SystemSettings.vue — 系统设置页容器。
 *
 * 纯容器:封装 SettingsPanel 弹窗,open/settings 由 App 注入,close/save 上抛。
 * 状态(settingsOpen / serverSettings)仍由 App.vue 持有。
 */
import SettingsPanel from './components/SettingsPanel/SettingsPanel.vue'
import type { SystemSettingsTarget } from '@/lib/action-descriptor'
import type {
  SessionBindingStats,
  SandboxHostStatus,
  SystemSettings,
  UserWorkspaceAccessAccount,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
  WorkspaceInfo,
  WorkspaceScopeMode,
} from '@ccc/shared/protocol'

defineProps<{
  open: boolean
  settings: SystemSettings | null
  hostStatus: VendorHostStatus[]
  vendorAvailability: Record<VendorId, VendorRuntimeStatus>
  sandboxStatus: SandboxHostStatus | null
  bindingStats: SessionBindingStats | null
  workspaces: WorkspaceInfo[]
  /** 一次性定位目标(派生下一步深链的落点);消费后由 App 清空。 */
  target?: SystemSettingsTarget | null
  /** 「用户与访问」名册;`null` = 未取到(含非管理员被服务端拒答)。 */
  userAccessAccounts?: UserWorkspaceAccessAccount[] | null
  /** 「用户与访问」勾选项的工作区来源(随名册回包,不是侧栏可见列表)。 */
  userAccessWorkspaces?: WorkspaceInfo[]
}>()

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  'remove-account': [payload: { username: string }]
  'set-admin-account': [payload: { username: string }]
  'target-consumed': []
  'reload-user-access': []
  'save-user-access': [payload: { subject: string; mode: WorkspaceScopeMode; workspaces: string[] }]
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
    :workspaces="workspaces"
    :target="target"
    :user-access-accounts="userAccessAccounts"
    :user-access-workspaces="userAccessWorkspaces"
    @close="$emit('close')"
    @target-consumed="$emit('target-consumed')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @set-password="(p) => $emit('set-password', p)"
    @remove-account="(p) => $emit('remove-account', p)"
    @set-admin-account="(p) => $emit('set-admin-account', p)"
    @reload-user-access="$emit('reload-user-access')"
    @save-user-access="(p) => $emit('save-user-access', p)"
  />
</template>
