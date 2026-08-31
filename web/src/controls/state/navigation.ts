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

export function buildNavigationSlice() {
  // ---- View mode (workspace / workcenter) ----
  const viewMode = ref<'workspace' | 'workcenter'>('workspace')
  // 切到 workcenter 前记住的标签页,切回 workspace 时恢复。
  const savedTab = ref<TabKey>('intents')

  // Null means the authoritative server settings have not arrived yet. Navigation
  // treats that state as safely hidden and only restores console after the reply.
  const serverSettings = ref<SystemSettings | null>(null)
  const activeTab = ref<TabKey>('intents')
  const intentsProject = ref<string | null>(null)
  const intents = ref<Record<string, Intent[]>>({})
  // ---- New-session agent picker (the "+" modal) ----
  const newSessionOpen = ref(false)
  const newSessionWorkspace = ref<string | null>(null)
  const activeVendor = ref<VendorId | null>(null)
  // Whether the active session's vendor exposes the SDK task surface (`taskStore`).
  const activeAgentSwitch = ref<SessionAgentSwitch | null>(null)
  // The active session's title-bar source action (jump target + label family),
  // derived on `session_selected` from its owner metadata (+ the legacy
  // `linkedIntentId` compat field); null ⇒ no source button. Refreshed/cleared on
  // every (re)select, same lifecycle as `activeVendor`.
  const activeSessionSource = ref<SessionSourceAction | null>(null)
  // 当前活动会话的**真实** kind(来自列表投影行或 session_selected),与左栏的显示分类
  // activeSessionKind 不同:「规范」分类同时列出 spec 与 spec_review 两种真实 kind。
  // 只读呈现必须按真实 kind 判定,否则规范撰写会话会被一起锁死。null = 未知(按可写处理,
  // 服务端仍有 kind 门禁兜底)。
  const activeSessionRealKind = ref<SessionKind | null>(null)
  // 活动会话是否只能回放:spec_review 会话由系统运行并产出结论,人不能续跑。
  const activeSessionReadonly = computed<boolean>(
    () => activeSessionRealKind.value === 'spec_review',
  )
  // One-shot request to select a specific intent on the intents page (set by the
  // title-bar jump button, consumed + cleared by Intents.vue once applied).
  const requestedIntentId = ref<string | null>(null)
  // One-shot request to select a specific work session on the console tab. It can
  // wait first for the intent's last work session id, then for that work row.
  const requestedWorkSessionId = ref<PendingWorkSessionSelectRequest | null>(null)
  // One-shot request to force IntentDetail to switch to a specific sub-tab (set by
  // the WorkCenter jump-to-source, the post-Start-Work jump, and the
  // action-descriptor `intent-spec` deep link; consumed + cleared by IntentDetail
  // once applied). `'spec'` opens the document tab (approval checkpoint).
  const requestedIntentSubTab = ref<
    'intentSession' | 'specSession' | 'specReviewSession' | 'workSession' | 'spec' | null
  >(null)
  // One-shot request to select a specific WorkCenter wait-user event (set by the
  // action-descriptor `workcenter-event` deep link; consumed + cleared by
  // WorkCenter.vue once the event is visible in the list).
  const requestedWorkcenterEventId = ref<string | null>(null)
  // One-shot request to force IntentMergedList to switch to a specific tab (set by
  // the WorkCenter jump-to-source when no intent matches the session id).
  const requestedMergedTab = ref<'intents' | 'sessions' | null>(null)
  // One-shot request to open a specific standalone intent (chat) session on the
  // intents page (set by the title-bar source button when an intent session has no
  // owning intent to select). Consumed + cleared by Intents.vue once applied: it
  // flips the right column to the standalone chat bound to the active session.
  const requestedIntentSessionId = ref<string | null>(null)

  // ---- Deep link (URL hash routing) ----
  // One-shot pending deep link parsed from `location.hash` at startup, consumed
  // by the `ready` handler once workspaces are available. Not persisted to
  // localStorage — survives only the first `ready` after app mount.
  const pendingDeepLink = ref<DeepLinkTarget | null>(null)
  // A deep link whose target id was fulfilled by the corresponding server reply.
  // Kept as a set so the same link is never re-triggered (unlikely but defensive).
  const deepLinkFulfilled = ref<Set<string>>(new Set())
  // Timer handle for the deep link fulfillment timeout (cleanup on unload).
  const deepLinkTimers: { timeout: ReturnType<typeof setTimeout> | null } = { timeout: null }
  function clearPendingDeepLink(): void {
    pendingDeepLink.value = null
    if (deepLinkTimers.timeout) clearTimeout(deepLinkTimers.timeout)
    deepLinkTimers.timeout = null
  }

  return {
    viewMode,
    savedTab,
    serverSettings,
    activeTab,
    intentsProject,
    intents,
    newSessionOpen,
    newSessionWorkspace,
    activeVendor,
    activeAgentSwitch,
    activeSessionSource,
    activeSessionRealKind,
    activeSessionReadonly,
    requestedIntentId,
    requestedWorkSessionId,
    requestedIntentSubTab,
    requestedWorkcenterEventId,
    requestedMergedTab,
    requestedIntentSessionId,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    clearPendingDeepLink,
  } as const
}

export type NavigationSlice = ReturnType<typeof buildNavigationSlice>
