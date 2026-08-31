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
  type StateDeps,
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
import { useTypedI18n } from '@/i18n'

export function buildIntentSlice(
  deps: StateDeps,
  nav: {
    intentsProject: ReturnType<typeof ref<string | null>>
    intents: ReturnType<typeof ref<Record<string, Intent[]>>>
  },
) {
  const { t } = deps
  const { intentsProject, intents } = nav

  // Per-workspace SDD master switch, rebroadcast with every intent list. Drives
  // the SDD-aware intent action button (Write Spec / Approve Spec / Start Work)
  // without a separate workspace-setting fetch.
  const intentsSdd = ref<Record<string, boolean>>({})
  const currentIntentsSdd = computed<boolean>(() =>
    intentsProject.value ? (intentsSdd.value[intentsProject.value] ?? false) : false,
  )

  // Per-project automation-orchestrator status (server pushes `workflow_status`).
  const automation = ref<Record<string, WorkflowStatus>>({})
  const currentWorkflow = computed<WorkflowStatus | null>(() =>
    intentsProject.value ? (automation.value[intentsProject.value] ?? null) : null,
  )

  // Per-project queue detail (server pushes `queue_detail` after every pass and
  // every manual control). Kept apart from `automation` on purpose: the status
  // frame stays a compact button summary, this is the per-intent explanation.
  const queueDetail = ref<Record<string, QueueDetail>>({})
  const currentQueueDetail = computed<QueueDetail | null>(() =>
    intentsProject.value ? (queueDetail.value[intentsProject.value] ?? null) : null,
  )
  /** Whether the intents view is showing the queue page instead of the list. */
  const queuePageOpen = ref(false)

  // ---- Intent session list (middle column) ----
  const intentSessions = ref<Record<string, IntentSessionInfo[]>>({})
  const currentIntentSessions = computed<IntentSessionInfo[]>(() =>
    intentsProject.value ? (intentSessions.value[intentsProject.value] ?? []) : [],
  )
  const intentSessionRunStates = ref<Record<string, 'running'>>({})
  const selectedIntentSessionId = ref<string | null>(null)

  // ---- Intent-detail spec document (the `spec` tab content) ----
  // Content of the selected intent's `spec.md`, fetched via `read_file` and
  // routed by the matching `file_read` reply. `pendingSpecRel` tracks the
  // workspace-relative path we are awaiting so a stale files `file_read` for a
  // different file never overwrites it.
  const intentSpecContent = ref<string | null>(null)
  const intentSpecLoading = ref(false)
  const pendingSpecRel = ref<string | null>(null)

  // ---- Intent lifecycle logs (the detail's changelog tab content) ----
  // Cached per intent id; filled by the `intent_logs_list` reply of a lazy
  // `list_intent_logs` request sent when the changelog tab is first opened.
  const intentLogsById = ref<Record<string, IntentLog[]>>({})
  const intentLogsLoading = ref(false)
  // ---- Toast (transient, auto-dismissing global toast) ----
  const toast = ref<string | null>(null)
  // Intent action failures need an explicit acknowledgement, unlike transient toast feedback.
  const intentActionError = ref<string | null>(null)
  // The targeted Git/forge repair guidance for the SAME failure, when the server
  // classified one. Set and cleared together with the message above so the dialog
  // can never show one failure's text next to another failure's retry button.
  const intentActionErrorGuidance = ref<GitActionFailureGuidance | null>(null)
  const intentActionErrorSeq = ref(0)
  /** Set when a manual `create_pr` run fails; drives the link-existing-PR entry. */
  const createPrFailureContext = ref<{
    intentId: string
    deliveryId?: string
  } | null>(null)
  /** Context for the link-existing-PR dialog; survives closing the create-PR error dialog. */
  const linkIntentPrContext = ref<{ intentId: string; deliveryId?: string } | null>(null)
  const linkIntentPrPending = ref(false)
  const linkIntentPrError = ref<string | null>(null)
  const linkIntentPrDialogOpen = ref(false)
  /**
   * The ESCAPE a refused launch left the user, when it left one (see
   * `lib/gate-escape.ts`). Held next to — never merged into — the plain error
   * above: the message states the fact, this states what the user may do about
   * it, and only one dialog is shown for a given refusal.
   */
  const intentGateEscape = ref<{ escape: GateEscape; message: string } | null>(null)
  /**
   * 每条意图最近一次被告知的「worktree 基线不符」,按意图 id 存。
   *
   * 它不是拒绝:会话已经起来了,只是那个目录不在基准分支的最新提交上。所以它不弹
   * 窗、不拦操作,只在意图详情里常驻一条提示,把两个修复动作摆在用户手边 —— 落后
   * 本身可以一直留到 PR 合并时再处理。修复成功或用户关掉即移除该条。
   */
  const worktreeBaselineNotices = ref<Record<string, WorktreeBaselineNotice>>({})
  const createIntentPending = ref(false)
  /**
   * After a contentful `create_intent_result`, the owner session may still be
   * binding (worktree / agent). While this holds that intent's id, the detail's
   * intent-session tab shows in-page loading instead of `firstIntentTurn`. Cleared
   * only when `intentSessionId` lands, a session-start error arrives on this
   * connection, or the create/landing is discarded (workspace switch, refuse,
   * timeout) — never merely because a snapshot lists the id without a session.
   */
  const awaitingIntentSessionBindId = ref<string | null>(null)
  /**
   * Whether the 「增加意图」 dialog is open. Held here rather than inside the
   * intent list because the two events that close it are wire events, not user
   * gestures: a `create_intent_result` closes it (the intent exists, the console
   * is already jumping to it), while a refusal deliberately leaves it OPEN so the
   * content the user typed is still in the form when they fix the base branch.
   */
  const createIntentDialogOpen = ref(false)
  const intentPrSync = ref<
    Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  >({})
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(text: string): void {
    toast.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 4000)
  }
  function showIntentActionError(
    text: string,
    guidance: GitActionFailureGuidance | null = null,
  ): void {
    intentActionError.value = text
    intentActionErrorGuidance.value = guidance
  }
  function closeIntentActionError(): void {
    intentActionError.value = null
    intentActionErrorGuidance.value = null
    createPrFailureContext.value = null
  }
  function openLinkIntentPrDialog(ctx: { intentId: string; deliveryId?: string }): void {
    linkIntentPrContext.value = ctx
    linkIntentPrPending.value = false
    linkIntentPrError.value = null
    linkIntentPrDialogOpen.value = true
  }
  function closeLinkIntentPrDialog(): void {
    linkIntentPrDialogOpen.value = false
    linkIntentPrContext.value = null
    linkIntentPrPending.value = false
    linkIntentPrError.value = null
  }
  function beginLinkIntentPr(): void {
    linkIntentPrPending.value = true
    linkIntentPrError.value = null
  }
  function failLinkIntentPr(message: string): void {
    linkIntentPrPending.value = false
    linkIntentPrError.value = message
  }
  function showIntentGateEscape(escape: GateEscape, message: string): void {
    intentGateEscape.value = { escape, message }
  }
  function closeIntentGateEscape(): void {
    intentGateEscape.value = null
  }
  function noteWorktreeBaseline(notice: WorktreeBaselineNotice): void {
    worktreeBaselineNotices.value = { ...worktreeBaselineNotices.value, [notice.intentId]: notice }
  }
  function clearWorktreeBaselineNotice(intentId: string): void {
    if (!(intentId in worktreeBaselineNotices.value)) return
    const next = { ...worktreeBaselineNotices.value }
    delete next[intentId]
    worktreeBaselineNotices.value = next
  }

  // ---- Dev-launch startup overlay (App-global, like the toast) ----
  // Tracks a manual `start_development` launch so a blocking overlay can show
  // its coarse progress immediately. null = no launch in flight / overlay closed.
  // The minimum-dwell + safety-timeout timers
  // live in this non-reactive holder so both intent-actions (arming) and the
  // message handler / close helper (clearing) share one source.
  const devLaunch = ref<DevLaunchModel | null>(null)
  const specLaunch = ref<SpecLaunchModel | null>(null)
  // `jump` is the post-`ready` delayed jump-to-work-session timer; it lives here
  // so a new launch / overlay close cancels a stale pending jump.
  const devLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
    jump: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null, jump: null }
  function clearDevLaunchTimers(): void {
    if (devLaunchTimers.dwell) clearTimeout(devLaunchTimers.dwell)
    if (devLaunchTimers.safety) clearTimeout(devLaunchTimers.safety)
    if (devLaunchTimers.jump) clearTimeout(devLaunchTimers.jump)
    devLaunchTimers.dwell = null
    devLaunchTimers.safety = null
    devLaunchTimers.jump = null
  }
  function closeDevLaunch(): void {
    clearDevLaunchTimers()
    devLaunch.value = null
  }
  const specLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null }
  function clearSpecLaunchTimers(): void {
    if (specLaunchTimers.dwell) clearTimeout(specLaunchTimers.dwell)
    if (specLaunchTimers.safety) clearTimeout(specLaunchTimers.safety)
    specLaunchTimers.dwell = null
    specLaunchTimers.safety = null
  }
  function closeSpecLaunch(): void {
    clearSpecLaunchTimers()
    specLaunch.value = null
  }

  // ---- Create-PR progress overlay (App-global, same shape as the dev launch) ----
  // Tracks a manual `create_pr` run so the blocking overlay can show its four
  // stages immediately. null = nothing in flight / overlay closed.
  const createPrProgress = ref<CreatePrModel | null>(null)
  const createPrTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null }
  function clearCreatePrTimers(): void {
    if (createPrTimers.dwell) clearTimeout(createPrTimers.dwell)
    if (createPrTimers.safety) clearTimeout(createPrTimers.safety)
    createPrTimers.dwell = null
    createPrTimers.safety = null
  }

  // ---- Create-intent progress overlay (App-global, same shape as the create-PR one) ----
  // Tracks a WITH-CONTENT `create_intent` run so the blocking overlay can narrate
  // the server's chain (fetch → worktree → persist → session) immediately. null =
  // nothing in flight / overlay closed. `stage` paces the narration and exists
  // only here: the protocol pushes no progress for this request.
  const createIntentProgress = ref<CreateIntentModel | null>(null)
  const createIntentTimers: {
    stage: ReturnType<typeof setInterval> | null
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { stage: null, dwell: null, safety: null }
  function clearCreateIntentTimers(): void {
    if (createIntentTimers.stage) clearInterval(createIntentTimers.stage)
    if (createIntentTimers.dwell) clearTimeout(createIntentTimers.dwell)
    if (createIntentTimers.safety) clearTimeout(createIntentTimers.safety)
    createIntentTimers.stage = null
    createIntentTimers.dwell = null
    createIntentTimers.safety = null
  }

  return {
    intentsSdd,
    currentIntentsSdd,
    automation,
    currentWorkflow,
    queueDetail,
    currentQueueDetail,
    queuePageOpen,
    intentSessions,
    currentIntentSessions,
    intentSessionRunStates,
    selectedIntentSessionId,
    intentSpecContent,
    intentSpecLoading,
    pendingSpecRel,
    intentLogsById,
    intentLogsLoading,
    toast,
    intentActionError,
    intentActionErrorGuidance,
    intentActionErrorSeq,
    createPrFailureContext,
    linkIntentPrContext,
    linkIntentPrPending,
    linkIntentPrError,
    linkIntentPrDialogOpen,
    intentGateEscape,
    worktreeBaselineNotices,
    createIntentPending,
    awaitingIntentSessionBindId,
    createIntentDialogOpen,
    intentPrSync,
    showToast,
    showIntentActionError,
    closeIntentActionError,
    openLinkIntentPrDialog,
    closeLinkIntentPrDialog,
    beginLinkIntentPr,
    failLinkIntentPr,
    showIntentGateEscape,
    closeIntentGateEscape,
    noteWorktreeBaseline,
    clearWorktreeBaselineNotice,
    devLaunch,
    specLaunch,
    devLaunchTimers,
    clearDevLaunchTimers,
    closeDevLaunch,
    specLaunchTimers,
    clearSpecLaunchTimers,
    closeSpecLaunch,
    createPrProgress,
    createPrTimers,
    clearCreatePrTimers,
    createIntentProgress,
    createIntentTimers,
    clearCreateIntentTimers,
  } as const
}

export type IntentSlice = ReturnType<typeof buildIntentSlice>
