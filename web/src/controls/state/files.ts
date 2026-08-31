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

export function buildFilesSlice() {
  // ---- Files view (read-only file browser) ----
  // The workspace name whose tree/tabs are loaded. Reset when it changes.
  const filesProject = ref<string | null>(null)
  // Lazy directory cache: rel path ('' = root) → immediate children. Absent = not loaded yet.
  const filesDirs = ref<Record<string, FileEntry[]>>({})
  // Expanded directory rel paths (reassigned on mutation so Vue tracks the Set).
  const filesExpanded = ref<Set<string>>(new Set())
  // Directories with an in-flight `list_dir`.
  const filesLoadingDirs = ref<Set<string>>(new Set())
  // Authoritative workspace Git-status snapshot: changed-file path → flags.
  // Replaced wholesale on each `file_git_status`; empty = clean / non-git / error.
  const filesGitStatus = ref<Record<string, FileGitStatus>>({})
  // Open file tabs, in tab order. Refresh clears them (no persistence by design).
  const filesTabs = ref<FileTab[]>([])
  // The focused tab's path, or null when none are open.
  const filesActivePath = ref<string | null>(null)
  // Search box: mode toggle + query + glob filter + bounded result set
  // (null = no search yet). `pattern` defaults to `*` (all files).
  const filesSearchMode = ref<FileSearchMode>('filename')
  const filesSearchQuery = ref('')
  const filesSearchPattern = ref('*')
  const filesSearchResult = ref<FilesSearchResultView | null>(null)
  const filesSearchLoading = ref(false)

  const filesActiveTab = computed<FileTab | null>(
    () => filesTabs.value.find((tab) => tab.path === filesActivePath.value) ?? null,
  )
  // Files 内嵌 ChatColumn 的「每工作区最后一次会话」指针(workspaceName → sessionId),
  // 作为持久化到内存的运行时镜像:openFiles 恢复时优先读 localStorage,该 ref 供
  // create/reset 后即时判定 create-vs-reset 按钮态,避免反复读 localStorage。与 Works
  // 的 consoleSession 是两个独立指针,互不覆盖。
  const filesBoundSessionId = ref<Record<string, string>>({})

  return {
    filesProject,
    filesDirs,
    filesExpanded,
    filesLoadingDirs,
    filesGitStatus,
    filesTabs,
    filesActivePath,
    filesSearchMode,
    filesSearchQuery,
    filesSearchPattern,
    filesSearchResult,
    filesSearchLoading,
    filesActiveTab,
    filesBoundSessionId,
  } as const
}

export type FilesSlice = ReturnType<typeof buildFilesSlice>
