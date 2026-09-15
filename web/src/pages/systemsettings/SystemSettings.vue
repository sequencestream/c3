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
  ModelProvider,
  ProtocolType,
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
import type { SpeedTestIntent, SpeedTestUiState } from '@/lib/model-provider-speed-test'

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
  /** provider 连接探测结果,键为 `${providerId}:${vendor}`。 */
  providerProbes?: Record<string, ProviderProbeState>
  /** 正在手动「下载 / 检查新版本」的 vendor 列表。 */
  vendorCliSyncing?: VendorId[]
  /** 已提交快照里的 provider 列表,只作测速候选(服务端按已保存配置拨号)。 */
  savedProviders?: ModelProvider[]
  /** 测速的可见状态。 */
  speedTest?: SpeedTestUiState
}>()

defineEmits<{
  close: []
  save: [settings: SystemSettings]
  /** 一键自动配置:探测可用 vendor 并即时落库 system 型 agent(不走草稿)。 */
  'auto-configure-agents': []
  'sync-vendor-cli': [vendor: VendorId]
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  'remove-account': [payload: { username: string }]
  'set-admin-account': [payload: { username: string }]
  'target-consumed': []
  'reload-user-access': []
  'save-user-access': [payload: { subject: string; mode: WorkspaceScopeMode; workspaces: string[] }]
  'provider-probe': [
    payload: {
      providerId: string
      protocolType: ProtocolType
      baseUrl?: string
      apiKey?: string
    },
  ]
  /** 测速意图上抛(App 负责落到具体动作)。 */
  'speed-test': [intent: SpeedTestIntent]
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
    :provider-probes="providerProbes"
    :vendor-cli-syncing="vendorCliSyncing"
    :saved-providers="savedProviders"
    :speed-test="speedTest"
    @close="$emit('close')"
    @target-consumed="$emit('target-consumed')"
    @save="(s: SystemSettings) => $emit('save', s)"
    @auto-configure-agents="$emit('auto-configure-agents')"
    @sync-vendor-cli="(v) => $emit('sync-vendor-cli', v)"
    @set-password="(p) => $emit('set-password', p)"
    @remove-account="(p) => $emit('remove-account', p)"
    @set-admin-account="(p) => $emit('set-admin-account', p)"
    @reload-user-access="$emit('reload-user-access')"
    @save-user-access="(p) => $emit('save-user-access', p)"
    @provider-probe="(p) => $emit('provider-probe', p)"
    @speed-test="(intent) => $emit('speed-test', intent)"
  />
</template>
