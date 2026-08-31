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

export function buildSessionSlice(deps: StateDeps) {
  const { t, modeLabel, auth } = deps

  const messages = ref<ChatMsg[]>([])
  const status = ref<'connecting' | 'open' | 'closed'>('connecting')

  // Authentication (ADR-0023). Purely reactive: `auth.status` stays 'unknown'
  // until the server emits `unauthenticated` (login gate) or a login succeeds.
  const authStatus = computed(() => auth.status.value)
  // Live run status per session (sidebar badges + input lock for the viewed one).
  const sessionStatus = ref<Record<string, SessionStatus>>({})
  // The viewed session's permission mode, a vendor-native ModeToken (2026-06-07-012).
  const mode = ref<ModeToken>('default')
  // Codex dual-policy config (2026-06-08), when the active session is codex.
  const codexPolicy = ref<CodexPolicy | null>(null)

  // Mutable counters (non-reactive) for chat message ids + queue item ids.
  const counters = { nextId: 1, nextQueueId: 1 }
  // Non-reactive flags shared across installers.
  // `pendingConsoleBind`: a workspace switch or session-kind switch cleared the
  // chat column and is waiting for the current workspace+kind's `list_sessions`
  // reply to bind its first session.
  const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }

  // "Current task list" of the viewed session (server-derived, pushed over the
  // `task_*` wire path). Reset on session_selected, then filled from those messages.
  const taskModel = ref<TaskListModel>(emptyTaskModel())

  // Sidebar / session state
  const workspaces = ref<WorkspaceInfo[]>([])
  // 「新增工作区」弹框的受控开关:顶栏两处切换器(桌面 / 移动)共用同一个实例,
  // 手动「+」与冷启动引导都写它,取消 / 确认清空。仅内存态,不持久化。
  const addWorkspaceOpen = ref(false)
  // 「选择目录」的当次请求。服务端在自己所在主机弹原生目录对话框,结果按
  // requestId 关联回来;只有当前请求的回复才被采纳,弹框关闭或发起新请求都会
  // 让旧 requestId 失效,迟到的回复直接丢弃。仅内存态。
  const workspaceDirectoryPicker = ref<WorkspaceDirectoryPickerState>(emptyDirectoryPicker())
  const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
  const activeSessionKind = ref<SessionPageKind>('work')
  const sessionCounts = ref<Record<SessionPageKind, number>>({
    work: 0,
    intent: 0,
    spec: 0,
    spec_review: 0,
    discussion: 0,
    automation: 0,
    tool: 0,
  })
  // 当前工作区「进行中条目数」(按 owner 去重,服务端权威)。与 sessionCounts 同一帧
  // 送达,但语义是条目而非会话:一个意图/讨论/自动化只要有任一会话在跑就计 1。
  // 驱动顶部「意图/讨论/自动化」三个 tab 的角标。
  const ownerRunningCounts = ref<Record<SessionOwnerKind, number>>(emptyOwnerCounts())
  // Per-workspace cursor-pagination state (SR-R14), parallel to the session
  // arrays above. `hasMore` drives the "load more" button; `exhausted` flips it
  // to a "Fully loaded" hint; `loadingMore` guards a double click;
  // `pendingSince` remembers the `since` of an in-flight `window` refresh so its
  // reply can keep loaded-more rows below that boundary.
  const sessionPagingByWorkspace = ref<
    Record<
      string,
      { hasMore: boolean; exhausted: boolean; loadingMore: boolean; pendingSince?: number }
    >
  >({})
  // The single global "current workspace" the sidebar reflects; decoupled from the
  // viewed session's workspace (`activeWorkspace`). Persisted to localStorage.
  const currentWorkspace = ref<string | null>(null)
  const activeWorkspace = ref<string | null>(null)
  const activeSession = ref<string | null>(null)
  const activeTitle = ref<string>('')

  // WorkCenter: pending user-involve events for event list.
  const workcenterEvents = ref<WaitUserInvolveEvent[]>([])
  const workcenterHasMore = ref(false)
  const workcenterLoading = ref(false)
  const workcenterAppendNext = ref(false)
  const workcenterPendingCount = computed(
    () => workcenterEvents.value.filter((event) => event.status === 'todo').length,
  )

  // Workcenter page-internal nav: which page the workcenter view is showing.
  const workcenterPage = ref<WorkcenterPage>('notifications')

  // Chat robots: the global roster (robots are not scoped to a workspace) plus
  // the audit rows of whichever robot is selected.
  const robots = ref<ImRobot[]>([])
  const robotsLoading = ref(false)
  const selectedRobotId = ref<string | null>(null)
  const robotTurns = ref<ImRobotTurnLog[]>([])

  // One-click Feishu app registration: the controls layer owns the request
  // association (client-generated requestId) and the whole UI state, so the
  // form only renders it and emits actions. Credentials in a `ready` /
  // `manual_setup_required` result live here in memory until the user saves;
  // they never reach the roster, broadcast or any persisted state.
  const feishuAppRegistration = ref<FeishuAppRegistrationState>(idleFeishuAppRegistration())

  // Robot-form tool manifest: cached per vendor, like the automation form's, but
  // with no workspace attached — a robot is not scoped to one, so the manifest is
  // the vendor's built-ins plus c3's own MCP tools (no `mcp__<server>__` namespaces).
  const robotToolManifest = ref<Record<string, ToolManifestEntry[] | null>>({})
  const robotToolManifestLoading = ref(false)
  const robotToolManifestError = ref<string | null>(null)

  // Workcenter Dashboard: the cross-workspace snapshot + its per-row gate feedback.
  const dashboardRows = ref<WorkspaceDashboardRow[]>([])
  const dashboardLoading = ref(false)
  // The whole snapshot failed to refresh; the last good rows are kept on screen.
  const dashboardError = ref<UiError | null>(null)
  // Workspace names whose per-row automation toggle is in flight (its switch is busy).
  const dashboardPending = ref<Set<string>>(new Set())
  // A coalesced refresh was requested while a request was in flight — run once after.
  const dashboardRefreshPending = ref(false)

  // The 「会话」(console) tab remembers its OWN last-viewed session, independent of
  // the 「需求」tab's comm session — so switching tabs never crosses chat content.
  const consoleSession = ref<SessionRef | null>(null)

  const hasActiveSession = computed(() => activeSession.value !== null)
  // Sessions of the current workspace (the only ones the sidebar lists).
  const currentSessions = computed<SessionInfo[]>(
    () =>
      (currentWorkspace.value &&
        sessionsByWorkspace.value[
          sessionCacheKey(currentWorkspace.value, activeSessionKind.value)
        ]) ||
      [],
  )
  // Pagination flags of the current workspace's session window (SR-R14): drive
  // the sidebar's "load more" button / "Fully loaded" hint.
  const currentSessionPaging = computed<{ hasMore: boolean; exhausted: boolean }>(() => {
    const p =
      currentWorkspace.value &&
      sessionPagingByWorkspace.value[
        sessionCacheKey(currentWorkspace.value, activeSessionKind.value)
      ]
    return { hasMore: p ? p.hasMore : false, exhausted: p ? p.exhausted : false }
  })

  // Status of one session (idle when unknown).
  function statusOf(sessionId: string): SessionStatus {
    return sessionStatus.value[sessionId] ?? 'idle'
  }

  // The viewed session is "running" (input locked) whenever it isn't idle.
  const running = computed(
    () => hasActiveSession.value && statusOf(activeSession.value as string) !== 'idle',
  )

  // The viewed session's agent run is in the transient socket-disconnect hold
  // (SessionStatus `reconnecting`, AVAIL-7).
  const reconnecting = computed(
    () => hasActiveSession.value && statusOf(activeSession.value as string) === 'reconnecting',
  )

  // Sessions upgraded to a persistent agent team (server `team_upgraded`).
  const teamSessions = ref<Set<string>>(new Set())
  const activeIsTeam = computed(
    () => hasActiveSession.value && teamSessions.value.has(activeSession.value as string),
  )

  // ---- Pending send queue (ordinary sessions, client-side only) ----
  const pendingQueues = ref<Record<string, PendingItem[]>>({})
  // The active page container (Sessions / Intents) exposes `prefill`; this ref
  // binds to whichever is mounted so queue-edit can fold text back into the composer.
  const composer = ref<{
    prefill: (text: string, images?: PromptImage[]) => void
  } | null>(null)

  const currentQueue = computed<PendingItem[]>(() =>
    activeSession.value ? (pendingQueues.value[activeSession.value] ?? []) : [],
  )

  function setQueue(sessionId: string, items: PendingItem[]): void {
    pendingQueues.value = { ...pendingQueues.value, [sessionId]: items }
  }

  // The one permission the user can still act on, or null.
  const actionablePermId = computed<string | null>(() =>
    actionablePermissionId(
      messages.value,
      hasActiveSession.value && statusOf(activeSession.value as string) === 'awaiting_permission',
    ),
  )

  // Fine-grained activity of the viewed session, inferred from the event stream.
  const activity = ref<RunActivity>({ phase: 'idle' })

  // Per-session "danger state" flag (AS-R19).
  const sideEffectPendingBySession = ref<Record<string, boolean>>({})
  const sideEffectPending = computed(
    () =>
      hasActiveSession.value && !!sideEffectPendingBySession.value[activeSession.value as string],
  )
  function clearSideEffectPending(sessionId: string): void {
    if (!sideEffectPendingBySession.value[sessionId]) return
    const next = { ...sideEffectPendingBySession.value }
    delete next[sessionId]
    sideEffectPendingBySession.value = next
  }

  // Which agent the viewed session is really running (stored as the session's
  // CHAIN INDEX, anchored at the session's bound agent).
  const currentAgentIndexBySession = ref<Record<string, number>>({})

  // Available commands/skills for the active session's cwd (fetched lazily on the
  // first `/`). Cleared on session switch.
  const availableCommands = ref<SlashCommandInfo[]>([])

  // ---- Update availability ----
  // Server-detected "is a newer c3 release available?" snapshot (seeded on `ready`,
  // refreshed by `update_status`). The header shows an upgrade hint only when
  // `available === true && latestVersion`; otherwise it renders nothing.
  const updateStatus = ref<UpdateStatus>({
    available: false,
    latestVersion: null,
    checkedAt: null,
  })

  // Server-driven self-update pipeline (seeded on `ready`, refreshed by
  // `self_update_state`). Drives the header's download progress and its
  // "restart to update" action. The cold-start value is deliberately incapable:
  // until the server says otherwise, no restart action is offered.
  const selfUpdate = ref<SelfUpdateState>({
    phase: 'idle',
    capable: false,
    currentVersion: '',
    targetVersion: null,
    downloadedBytes: 0,
    totalBytes: 0,
  })
  function add(m: ChatBody): void {
    messages.value.push({ ...m, id: counters.nextId++ } as ChatMsg)
  }

  // Resolve a session title from the loaded session lists (fallback when unknown).
  function sessionTitleById(id: string): string {
    for (const list of Object.values(sessionsByWorkspace.value)) {
      const s = list.find((x) => x.sessionId === id)
      if (s) return s.title
    }
    return t('session.fallback.label')
  }

  return {
    messages,
    status,
    authStatus,
    sessionStatus,
    mode,
    codexPolicy,
    counters,
    flags,
    taskModel,
    workspaces,
    addWorkspaceOpen,
    workspaceDirectoryPicker,
    sessionsByWorkspace,
    activeSessionKind,
    sessionCounts,
    ownerRunningCounts,
    sessionPagingByWorkspace,
    currentWorkspace,
    activeWorkspace,
    activeSession,
    activeTitle,
    workcenterEvents,
    workcenterHasMore,
    workcenterLoading,
    workcenterAppendNext,
    workcenterPendingCount,
    workcenterPage,
    robots,
    robotsLoading,
    selectedRobotId,
    robotTurns,
    feishuAppRegistration,
    robotToolManifest,
    robotToolManifestLoading,
    robotToolManifestError,
    dashboardRows,
    dashboardLoading,
    dashboardError,
    dashboardPending,
    dashboardRefreshPending,
    consoleSession,
    hasActiveSession,
    currentSessions,
    currentSessionPaging,
    statusOf,
    running,
    reconnecting,
    teamSessions,
    activeIsTeam,
    pendingQueues,
    composer,
    currentQueue,
    setQueue,
    actionablePermId,
    activity,
    sideEffectPendingBySession,
    sideEffectPending,
    clearSideEffectPending,
    currentAgentIndexBySession,
    availableCommands,
    updateStatus,
    selfUpdate,
    add,
    sessionTitleById,
  } as const
}

export type SessionSlice = ReturnType<typeof buildSessionSlice>
