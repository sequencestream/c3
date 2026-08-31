import { ref, computed } from 'vue'
import { actionablePermissionId } from '@/lib/permission'
import { type PendingItem } from '@/lib/pending-queue'
import {
  discussionPhase,
  discussionLaunchAction,
  type DispatchView,
  type DiscussionPhase,
  type DiscussionLaunchAction,
} from '@/lib/discussion-view'
import { emptyTaskModel, type TaskListModel } from '@/lib/task-list'
import { type CreateIntentModel } from '@/lib/create-intent-view'
import { type CreatePrModel } from '@/lib/create-pr-view'
import type { DeliveryBranchInitState } from '@/lib/delivery-view'
import { type DevLaunchModel } from '@/lib/dev-launch-view'
import type { GateEscape } from '@/lib/gate-escape'
import type { WorktreeBaselineNotice } from '@/lib/worktree-baseline'
import { type SpecLaunchModel } from '@/lib/spec-launch-view'
import { type SessionRef } from '@/lib/tab-view'
import { type SessionSourceAction } from '@/lib/session-jump'
import { type PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
import type { FileTab, FilesSearchResultView } from '@/lib/files-view'
import type { ChatBody, ChatMsg, RunActivity } from '@/lib/chat-types'
import { agentNameAt } from '@/lib/agent-prefix'
import { deriveVendorAvailability } from '@/lib/vendor-runtime'
import { normalizePersonalized, readLocalPersonalized } from '@/lib/personalized-settings'
import type { DeepLinkTarget } from '@/lib/deep-link'
import type { SystemSettingsTarget } from '@/lib/action-descriptor'
import type {
  WorkflowStatus,
  QueueDetail,
  FileEntry,
  FileGitStatus,
  FileSearchMode,
  CodexPolicy,
  DepType,
  AssociatedIntent,
  Delivery,
  DeliveryLog,
  DeliveryPr,
  DeliveryTransitionPlan,
  Discussion,
  GitActionFailureGuidance,
  ModeToken,
  VendorModeCatalog,
  Intent,
  IntentLog,
  IntentSessionInfo,
  UpdateStatus,
  SelfUpdateState,
  PromptImage,
  PersonalizedSettings,
  WorkspaceSetting as WorkspaceSettingType,
  Automation,
  AutomationExecutionLog,
  ToolManifestEntry,
  AdapterCapability,
  SessionAgentSwitch,
  McpApiKeyMeta,
  ExternalMcpToolDescriptor,
  SessionBindingStats,
  SessionCapabilities,
  SandboxHostStatus,
  SessionInfo,
  SessionKind,
  SessionOwnerKind,
  SessionRunStatus,
  SessionStatus,
  SkillLinkStatus,
  SkillSupportState,
  ParkRecoveryStats,
  WorkspaceMemoryListItem,
  SlashCommandInfo,
  SysExtraMount,
  SystemSettings,
  TranscriptItem,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
  WaitUserInvolveEvent,
  UserWorkspaceAccessAccount,
  WorkspaceInfo,
  WorkspaceDashboardRow,
  ImRobot,
  ImRobotTurnLog,
  ImIdentityBinding,
  ImIdentityChallengeCreated,
  ImIdentityChallengeSummary,
  ImGroupWorkspaceGrant,
  AppRegistrationManualSetupReason,
  AppRegistrationFailedReason,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { ApprovalRequest } from '@/components/SkillApprovalModal/SkillApprovalModal.vue'
import type { ProviderProbeState } from '@/lib/model-provider'

import {
  type TabKey,
  type WorkcenterPage,
  type SessionPageKind,
  type WorkspaceDirectoryPickerState,
  type FeishuAppRegistrationState,
  type MyImIdentityView,
  idleFeishuAppRegistration,
  emptyDirectoryPicker,
  sumSessionCounts,
  emptyOwnerCounts,
  runningSessionsFingerprint,
  runningSessionsFingerprintOf,
  sessionCacheKey,
  VIEW_MODE_KEY,
} from './types'

export function buildSettingsSlice() {
  // ---- System settings (agent config) ----
  const settingsOpen = ref(false)
  // 一次性定位目标:某个派生的 ActionDescriptor 要求打开系统设置并落到具体位置。
  // 面板消费后由 App 清空(与 automationFormTarget / requestedIntentSubTab 同一套
  // 「一次性目标」模式),因此重开设置页不会再跳回上一次的 agent 行。
  const settingsTarget = ref<SystemSettingsTarget | null>(null)
  const hostStatus = ref<VendorHostStatus[]>([])
  // 服务端给出的、覆盖全部 vendor 的运行时可用性;旧服务端不发此字段,故可为 null。
  const vendorRuntime = ref<Record<VendorId, VendorRuntimeStatus> | null>(null)
  // 全前端唯一的「vendor 能不能跑」判定:所有门控点读它,不各自解读 hostStatus,
  // 也不按 vendor 名分支(旧服务端的回落规则收敛在 deriveVendorAvailability 内)。
  const vendorAvailability = computed(() =>
    deriveVendorAvailability(vendorRuntime.value ?? undefined, hostStatus.value),
  )
  const sandboxStatus = ref<SandboxHostStatus | null>(null)
  const bindingStats = ref<SessionBindingStats | null>(null)
  const sessionCapabilities = ref<Record<VendorId, SessionCapabilities> | null>(null)
  const skillSupport = ref<Record<VendorId, SkillSupportState> | null>(null)
  const vendorCapabilities = ref<Record<VendorId, Record<AdapterCapability, boolean>> | null>(null)
  const vendorModes = ref<Record<VendorId, VendorModeCatalog> | null>(null)
  // ---- External MCP API keys (personal settings) ----
  // THIS identity's own keys, metadata only. A key is an owned credential, so the
  // only roster the console holds is the signed-in identity's own: there is no
  // per-workspace key list, because filing never decided what a key reaches.
  // `myMcpApiKeyCreated` holds the ONE reply that ever carries a plaintext key: it
  // lives in memory for this page view so the user can copy it, and is cleared on
  // dismiss, page close, identity change and reconnect. Nothing writes it to
  // storage, so a refresh loses it permanently — the promise the server makes.
  const myMcpApiKeys = ref<McpApiKeyMeta[]>([])
  const myMcpApiKeyCreated = ref<{ meta: McpApiKeyMeta; key: string } | null>(null)

  // IM identity binding (personal settings). Challenge plaintext mirrors MCP keys:
  // shown once in memory, cleared on dismiss / page close / reconnect.
  const myImIdentity = ref<MyImIdentityView | null>(null)
  const imIdentityChallengeCreated = ref<ImIdentityChallengeCreated | null>(null)
  // Admin robot console: bindings and group scope for the selected robot.
  const imIdentityBindings = ref<ImIdentityBinding[]>([])
  const imGroupWorkspaceScopes = ref<ImGroupWorkspaceGrant[]>([])
  const imGroupScopeChatId = ref('')

  // ---- Account × workspace access (system settings) ----
  // The administrator's authorization editor. Held outside `serverSettings`
  // because it is NOT part of the `SystemSettings` draft/save payload: a whole
  // -object settings save must never be able to carry, or silently drop, an
  // access policy.
  const userWorkspaceAccess = ref<{
    workspaces: WorkspaceInfo[]
    accounts: UserWorkspaceAccessAccount[]
  } | null>(null)

  // Connection probe results, keyed `${providerId}:${vendor}`. Transient UI state:
  // a probe answers "is this endpoint alive right now", so it is never persisted
  // and is dropped on reconnect along with the rest of the session view.
  const providerProbes = ref<Record<string, ProviderProbeState>>({})

  // ---- Workspace accessors (workspace settings, read-only) ----
  // Who can reach the CURRENT workspace, derived server-side. `null` until the
  // first answer arrives, so "not loaded yet" is distinguishable from "nobody".
  const workspaceAccessors = ref<string[] | null>(null)

  const skillApprovalRequest = ref<ApprovalRequest | null>(null)
  const skillLinkStatuses = ref<SkillLinkStatus[]>([])
  const installingSkillIds = ref<string[]>([])

  // ---- Personalized setting ----
  // The third settings class: per-person preferences, reachable by every account
  // (no admin gate). Seeded from this browser's own record so the first paint and a
  // no-account session already show the right language; replaced by the server echo
  // once an account answers.
  const personalizedSettingOpen = ref(false)
  const personalizedSettings = ref<PersonalizedSettings>(
    normalizePersonalized(readLocalPersonalized()),
  )

  // ---- Workspace setting ----
  const workspaceSettingOpen = ref(false)
  const currentWorkspaceSetting = ref<WorkspaceSettingType | null>(null)
  const detectedMainBranch = ref<string | null>(null)
  // Read-only: the FIXED, centralized SDD spec root the server resolved for the
  // workspace (`~/.c3/specs/<project-path-segment>`). Displayed, never editable.
  const resolvedSpecRoot = ref<string | null>(null)
  // Read-only: the workspace-scoped built-in sandbox allow set the server resolved
  // (project directory ro, specs root rw). Displayed next to editable extraMounts.
  const sysExtraMounts = ref<SysExtraMount[]>([])
  // ---- Local observation (park recovery) ----
  // Read-only counts for the workspace-setting page's observation section. Kept
  // OUTSIDE `currentWorkspaceSetting` on purpose: it is derived measurement, not
  // configuration, so it must never join a settings draft or a save payload.
  // `null` stats + `null` error = never loaded / cleared on workspace switch.
  const parkRecoveryStats = ref<ParkRecoveryStats | null>(null)
  const parkRecoveryError = ref<UiError | null>(null)
  const parkRecoveryLoading = ref(false)

  // ---- Workspace memories (workspace settings, read + delete) ----
  // The summary listing behind the memory tab. Held outside `currentWorkspaceSetting`
  // for the same reason the observation counts are: memories are content the agent
  // wrote, not configuration, so they must never join a settings draft or a save
  // payload. `null` = never loaded / cleared on reconnect, which is what tells
  // "not fetched yet" apart from "this workspace remembers nothing".
  const workspaceMemories = ref<WorkspaceMemoryListItem[] | null>(null)
  const workspaceMemoriesError = ref<UiError | null>(null)
  const workspaceMemoriesLoading = ref(false)
  // Ids whose soft delete is in flight — the row stays visible but its button is
  // disabled, so a second click cannot fire while the first is unanswered.
  const deletingMemoryIds = ref<string[]>([])

  return {
    settingsOpen,
    settingsTarget,
    hostStatus,
    vendorRuntime,
    vendorAvailability,
    sandboxStatus,
    bindingStats,
    sessionCapabilities,
    skillSupport,
    vendorCapabilities,
    vendorModes,
    myMcpApiKeys,
    myMcpApiKeyCreated,
    myImIdentity,
    imIdentityChallengeCreated,
    imIdentityBindings,
    imGroupWorkspaceScopes,
    imGroupScopeChatId,
    userWorkspaceAccess,
    providerProbes,
    workspaceAccessors,
    skillApprovalRequest,
    skillLinkStatuses,
    installingSkillIds,
    personalizedSettingOpen,
    personalizedSettings,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    parkRecoveryStats,
    parkRecoveryError,
    parkRecoveryLoading,
    workspaceMemories,
    workspaceMemoriesError,
    workspaceMemoriesLoading,
    deletingMemoryIds,
  } as const
}

export type SettingsSlice = ReturnType<typeof buildSettingsSlice>
