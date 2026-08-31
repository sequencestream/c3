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

export function buildDiscussionSlice() {
  // ---- Discussion view (read path) ----
  const discussionsProject = ref<string | null>(null)
  const discussions = ref<Record<string, Discussion[]>>({})
  const currentDiscussions = computed<Discussion[]>(() =>
    discussionsProject.value ? (discussions.value[discussionsProject.value] ?? []) : [],
  )
  const activeDiscussionId = ref<string | null>(null)
  const activeDiscussion = ref<Discussion | null>(null)
  const discussionMessages = ref<ChatMsg[]>([])
  const discussionMaxSeq = ref(0)
  const discussionRunState = ref<Record<string, 'running' | 'paused'>>({})
  const researchState = ref<Record<string, 'running'>>({})
  const researchMessages = ref<ChatMsg[]>([])
  const researchMaxSeq = ref(0)
  const discussionDispatch = ref<Record<string, DispatchView>>({})
  // Draft for the discussion composer (human speak / follow-up question).
  const discussionInput = ref('')

  // The open discussion's live run-state ('running' | 'paused' | undefined).
  const activeDiscussionRunState = computed<'running' | 'paused' | undefined>(() =>
    activeDiscussionId.value ? discussionRunState.value[activeDiscussionId.value] : undefined,
  )
  // The open discussion's transient dispatch (in-flight/failed) status.
  const activeDiscussionDispatch = computed<DispatchView>(() => {
    const id = activeDiscussionId.value
    return (id && discussionDispatch.value[id]) || { pending: [], errors: [] }
  })
  // Whether the open discussion's research run is live.
  const activeResearchLive = computed<boolean>(() =>
    activeDiscussionId.value ? researchState.value[activeDiscussionId.value] === 'running' : false,
  )
  // Right-pane phase: the live research stream, or the discussion stream.
  const activeDiscussionPhase = computed<DiscussionPhase>(() =>
    discussionPhase(activeResearchLive.value),
  )
  // The manual launch action the title bar offers: `start` for a draft whose
  // research never auto-started, `restart` for an `in_progress` discussion left
  // dangling by an engine error / server restart, `null` while anything is live.
  // Liveness is the RUN-state snapshot, never the persisted status.
  const discussionLaunch = computed<DiscussionLaunchAction | null>(() => {
    const d = activeDiscussion.value
    if (!d) return null
    return discussionLaunchAction(
      d.status,
      activeResearchLive.value,
      activeDiscussionRunState.value !== undefined,
    )
  })

  return {
    discussionsProject,
    discussions,
    currentDiscussions,
    activeDiscussionId,
    activeDiscussion,
    discussionMessages,
    discussionMaxSeq,
    discussionRunState,
    researchState,
    researchMessages,
    researchMaxSeq,
    discussionDispatch,
    discussionInput,
    activeDiscussionRunState,
    activeDiscussionDispatch,
    activeResearchLive,
    activeDiscussionPhase,
    discussionLaunch,
  } as const
}

export type DiscussionSlice = ReturnType<typeof buildDiscussionSlice>
