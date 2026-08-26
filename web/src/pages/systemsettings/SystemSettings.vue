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
  ProviderMigrationPlan,
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
import type { ProviderProbeState } from '@/lib/model-provider'

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
  /** 内联配置 → provider 的迁移报告;`null` = 尚未取到。 */
  providerMigrationPlan?: ProviderMigrationPlan | null
  /** provider 连接探测结果,键为 `${providerId}:${vendor}`。 */
  providerProbes?: Record<string, ProviderProbeState>
}>()

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  /** 一键自动配置:探测可用 vendor 并即时落库 system 型 agent(不走草稿)。 */
  'auto-configure-agents': []
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  'remove-account': [payload: { username: string }]
  'set-admin-account': [payload: { username: string }]
  'target-consumed': []
  'reload-user-access': []
  'save-user-access': [payload: { subject: string; mode: WorkspaceScopeMode; workspaces: string[] }]
  'provider-migrate': [
    payload: {
      action: 'plan' | 'apply' | 'revert' | 'clear'
      providerIds?: string[]
      agentIds?: string[]
    },
  ]
  'provider-probe': [
    payload: {
      providerId: string
      protocolType: import('@ccc/shared/protocol').ProtocolType
      baseUrl?: string
      apiKey?: string
    },
  ]
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
    :provider-migration-plan="providerMigrationPlan"
    :provider-probes="providerProbes"
    @close="$emit('close')"
    @target-consumed="$emit('target-consumed')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @auto-configure-agents="$emit('auto-configure-agents')"
    @set-password="(p) => $emit('set-password', p)"
    @remove-account="(p) => $emit('remove-account', p)"
    @set-admin-account="(p) => $emit('set-admin-account', p)"
    @reload-user-access="$emit('reload-user-access')"
    @save-user-access="(p) => $emit('save-user-access', p)"
    @provider-migrate="(p) => $emit('provider-migrate', p)"
    @provider-probe="(p) => $emit('provider-probe', p)"
  />
</template>
