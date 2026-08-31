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

export function buildAutomationSlice() {
  // ---- Automations view (read path) ----
  const automationsProject = ref<string | null>(null)
  const automations = ref<Record<string, Automation[]>>({})
  const currentAutomations = computed<Automation[]>(() =>
    automationsProject.value ? (automations.value[automationsProject.value] ?? []) : [],
  )
  const selectedAutomationId = ref<string | null>(null)
  const selectedAutomation = computed<Automation | null>(() => {
    if (!selectedAutomationId.value || !automationsProject.value) return null
    return currentAutomations.value.find((s) => s.id === selectedAutomationId.value) ?? null
  })
  const automationLogs = ref<Record<string, AutomationExecutionLog[]>>({})
  const selectedAutomationLogs = computed<AutomationExecutionLog[]>(() =>
    selectedAutomationId.value ? (automationLogs.value[selectedAutomationId.value] ?? []) : [],
  )
  const executionTranscripts = ref<Record<string, TranscriptItem[]>>({})
  const selectedExecutionId = ref<string | null>(null)
  const selectedExecution = computed<AutomationExecutionLog | null>(() => {
    if (!selectedExecutionId.value) return null
    return selectedAutomationLogs.value.find((l) => l.id === selectedExecutionId.value) ?? null
  })

  // ---- Automations workspace gate (WorkspaceSetting.automationEnabled) ----
  // A snapshot of the automations workspace's full setting, bound to
  // `automationsProject`. Held separately from `currentWorkspaceSetting` (the
  // settings panel's snapshot) and tagged with the workspace it belongs to, so a
  // late `workspace_setting` reply for a previous workspace never leaks the wrong
  // gate value into the current view.
  const automationWorkspaceSetting = ref<WorkspaceSettingType | null>(null)
  const automationWorkspaceSettingId = ref<string | null>(null)
  // True while a gate save is awaiting the server echo; disables the toggle so a
  // double-flip cannot race. The snapshot captured before an optimistic flip, so
  // a server-side rejection can roll the toggle back to the last confirmed value.
  const automationEnabledSaving = ref(false)
  const automationSettingBeforeSave = ref<WorkspaceSettingType | null>(null)
  // The gate value for the CURRENT automations workspace: available (a boolean)
  // only when the held snapshot matches `automationsProject`; `null` while loading
  // or right after a workspace switch (toggle renders disabled until it resolves).
  const automationEnabled = computed<boolean | null>(() => {
    const path = automationsProject.value
    if (!path || automationWorkspaceSettingId.value !== path || !automationWorkspaceSetting.value) {
      return null
    }
    return automationWorkspaceSetting.value.automationEnabled ?? true
  })

  // Automation-form tool manifest: cached per vendor, cleared on form close.
  const automationToolManifest = ref<Record<string, ToolManifestEntry[] | null>>({})
  const automationToolManifestLoading = ref(false)
  const automationToolManifestError = ref<string | null>(null)

  // Automation save-in-progress flag: drives the "Saving…" overlay that blocks
  // interaction while the server processes a create/update (2-4s typical latency).
  const automationSaving = ref(false)

  // The modal serves both create (target = null) and edit (target = a automation).
  const automationFormOpen = ref(false)
  const automationFormTarget = ref<Automation | null>(null)

  return {
    automationsProject,
    automations,
    currentAutomations,
    selectedAutomationId,
    selectedAutomation,
    automationLogs,
    selectedAutomationLogs,
    executionTranscripts,
    selectedExecutionId,
    selectedExecution,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
    automationEnabled,
    automationToolManifest,
    automationToolManifestLoading,
    automationToolManifestError,
    automationSaving,
    automationFormOpen,
    automationFormTarget,
  } as const
}

export type AutomationSlice = ReturnType<typeof buildAutomationSlice>
