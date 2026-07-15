import { ref, computed } from 'vue'
import { actionablePermissionId } from '@/lib/permission'
import { type PendingItem } from '@/lib/pending-queue'
import {
  discussionPhase,
  showDiscussionStart,
  type DispatchView,
  type DiscussionPhase,
} from '@/lib/discussion-view'
import { emptyTaskModel, type TaskListModel } from '@/lib/task-list'
import { type DevLaunchModel } from '@/lib/dev-launch-view'
import { type SpecLaunchModel } from '@/lib/spec-launch-view'
import { type SessionRef } from '@/lib/tab-view'
import { type SessionSourceAction } from '@/lib/session-jump'
import { type PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
import type { CodeTab, CodesSearchResultView } from '@/lib/codes-view'
import type { ChatBody, ChatMsg, RunActivity } from '@/lib/chat-types'
import { agentNameAt } from '@/lib/agent-prefix'
import type { DeepLinkTarget } from '@/lib/deep-link'
import type {
  WorkflowStatus,
  CodeDirEntry,
  CodeGitStatus,
  CodeSearchMode,
  CodexPolicy,
  DepType,
  Discussion,
  ModeToken,
  VendorModeCatalog,
  Intent,
  IntentLog,
  IntentSessionInfo,
  UpdateStatus,
  PromptImage,
  WorkspaceSetting as WorkspaceSettingType,
  Automation,
  AutomationExecutionLog,
  ToolManifestEntry,
  AdapterCapability,
  SessionAgentSwitch,
  SessionBindingStats,
  SessionCapabilities,
  SessionInfo,
  SessionKind,
  SessionStatus,
  SkillLinkStatus,
  SkillSupportState,
  SlashCommandInfo,
  SysExtraMount,
  SystemSettings,
  TranscriptItem,
  VendorHostStatus,
  VendorId,
  WaitUserInvolveEvent,
  WorkspaceInfo,
  WorkspaceDashboardRow,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { useTypedI18n } from '@/i18n'
import { useModeLabel, CLAUDE_MODE_FALLBACK } from '@/composables/useModeLabel'
import { useAuth } from '@/composables/useAuth'
import type { ApprovalRequest } from '@/components/SkillApprovalModal/SkillApprovalModal.vue'

export type TypedT = ReturnType<typeof useTypedI18n>['t']
export type ModeLabel = ReturnType<typeof useModeLabel>
export type AuthApi = ReturnType<typeof useAuth>

export interface StateDeps {
  t: TypedT
  modeLabel: ModeLabel
  auth: AuthApi
}

// localStorage keys for view-restore persistence (kept here so both state and
// the persistence installer share the single source).
export const VIEW_MODE_KEY = 'c3.viewMode'
export const REQ_PROJECT_KEY = 'c3.intentsProject'
export const DISC_PROJECT_KEY = 'c3.discussionsProject'
export const DISC_ID_KEY = 'c3.discussionId'
export const SCHED_PROJECT_KEY = 'c3.automationsProject'
export const CODES_PROJECT_KEY = 'c3.codesProject'
export const CURRENT_WS_KEY = 'c3.currentWorkspace'
export const WORK_SESSION_QUERY_START_TIME_KEY = 'work_session_query_start_time'
// Codes 内嵌 ChatColumn 的 per-workspace 持久化键前缀。实际键为
// `c3.codes.<workspaceId>.chatWidth` / `c3.codes.<workspaceId>.sessionId`
// (由 persistence.ts 的 codesKey 拼装),记住每个工作区最后一次的分隔条宽度与
// 内嵌会话 id。
export const CODES_CHAT_WIDTH_KEY = 'chatWidth'
export const CODES_CHAT_SESSION_KEY = 'sessionId'
// 内嵌 ChatColumn 分隔条宽度(像素):默认 / 最小 / 最大。像素而非比例,窗口缩放时
// 用户感知宽度更稳定。
export const CODES_CHAT_WIDTH_DEFAULT = 360
export const CODES_CHAT_WIDTH_MIN = 240
export const CODES_CHAT_WIDTH_MAX = 720

export type TabKey = 'console' | 'intents' | 'discussion' | 'automations' | 'codes'
export type SessionPageKind = Exclude<SessionKind, 'consensus'>

export const SESSION_PAGE_KINDS: readonly SessionPageKind[] = [
  'work',
  'intent',
  'spec',
  'discussion',
  'automation',
  'tool',
]

export function sessionCacheKey(workspaceId: string, sessionKind: SessionPageKind): string {
  return `${workspaceId}::${sessionKind}`
}

// 顶部「会话」tab 角标数值:当前工作区六类会话(work/intent/spec/discussion/
// automation/tool)进行中计数之和。与左侧列表六个 kind tab 角标同一数据源
// (sessionCounts),不引入新口径。tool 类在 showToolSessions 关闭时服务端本就
// 不推送(值为 0),自然不计入。和为 0 时上层 `v-if="tab.badgeCount"` 不渲染角标。
export function sumSessionCounts(counts: Record<SessionPageKind, number>): number {
  return SESSION_PAGE_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
}

/**
 * Create the full reactive state surface of the app controller: every ref,
 * computed, and pure (state-only) helper used by App.vue and the action
 * installers. Holds NO methods that talk to the server — those are attached by
 * the domain installers onto the shared `ctx`.
 */
export function createState(deps: StateDeps) {
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
  const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
  const activeSessionKind = ref<SessionPageKind>('work')
  const sessionCounts = ref<Record<SessionPageKind, number>>({
    work: 0,
    intent: 0,
    spec: 0,
    discussion: 0,
    automation: 0,
    tool: 0,
  })
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
  const workcenterPage = ref<'dashboard' | 'notifications'>('dashboard')

  // Workcenter Dashboard: the cross-workspace snapshot + its per-row gate feedback.
  const dashboardRows = ref<WorkspaceDashboardRow[]>([])
  const dashboardLoading = ref(false)
  // The whole snapshot failed to refresh; the last good rows are kept on screen.
  const dashboardError = ref<UiError | null>(null)
  // Workspace ids whose per-row automation toggle is in flight (its switch is busy).
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
  const currentAgentName = computed(() =>
    activeSession.value
      ? agentNameAt(
          serverSettings.value,
          activeAgentSwitch.value?.current.id,
          currentAgentIndexBySession.value[activeSession.value] ?? 0,
        )
      : '',
  )

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

  // ---- View mode (workspace / workcenter) ----
  const viewMode = ref<'workspace' | 'workcenter'>('workspace')
  // 切到 workcenter 前记住的标签页,切回 workspace 时恢复。
  const savedTab = ref<TabKey>('console')

  // ---- Top-bar tabs ----
  const HEADER_TABS = computed<{ key: TabKey; label: string; badgeCount?: number }[]>(() => [
    {
      key: 'console',
      label: t('nav.tab.console.label'),
      badgeCount: sumSessionCounts(sessionCounts.value),
    },
    { key: 'intents', label: t('nav.tab.intents.label') },
    { key: 'discussion', label: t('nav.tab.discussion.label') },
    { key: 'automations', label: t('nav.tab.automations.label') },
    { key: 'codes', label: t('nav.tab.codes.label') },
  ])
  const activeTab = ref<TabKey>('console')
  const intentsProject = ref<string | null>(null)
  const intents = ref<Record<string, Intent[]>>({})

  const currentIntents = computed<Intent[]>(() =>
    intentsProject.value ? (intents.value[intentsProject.value] ?? []) : [],
  )

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
  // workspace-relative path we are awaiting so a stale codes `file_read` for a
  // different file never overwrites it.
  const intentSpecContent = ref<string | null>(null)
  const intentSpecLoading = ref(false)
  const pendingSpecRel = ref<string | null>(null)

  // ---- Intent lifecycle logs (the detail's changelog tab content) ----
  // Cached per intent id; filled by the `intent_logs_list` reply of a lazy
  // `list_intent_logs` request sent when the changelog tab is first opened.
  const intentLogsById = ref<Record<string, IntentLog[]>>({})
  const intentLogsLoading = ref(false)

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
  // Manual Start fallback visibility.
  const showStart = computed<boolean>(() => {
    const d = activeDiscussion.value
    if (!d) return false
    const discussionLive =
      activeDiscussionRunState.value !== undefined ||
      d.status === 'in_progress' ||
      d.status === 'completed'
    return showDiscussionStart(d.status, activeResearchLive.value, discussionLive)
  })

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

  // ---- Codes view (read-only file browser) ----
  // The workspace id whose tree/tabs are loaded. Reset when it changes.
  const codesProject = ref<string | null>(null)
  // Lazy directory cache: rel path ('' = root) → immediate children. Absent = not loaded yet.
  const codesDirs = ref<Record<string, CodeDirEntry[]>>({})
  // Expanded directory rel paths (reassigned on mutation so Vue tracks the Set).
  const codesExpanded = ref<Set<string>>(new Set())
  // Directories with an in-flight `list_dir`.
  const codesLoadingDirs = ref<Set<string>>(new Set())
  // Authoritative workspace Git-status snapshot: changed-file path → flags.
  // Replaced wholesale on each `code_git_status`; empty = clean / non-git / error.
  const codesGitStatus = ref<Record<string, CodeGitStatus>>({})
  // Open file tabs, in tab order. Refresh clears them (no persistence by design).
  const codesTabs = ref<CodeTab[]>([])
  // The focused tab's path, or null when none are open.
  const codesActivePath = ref<string | null>(null)
  // Search box: mode toggle + query + glob filter + bounded result set
  // (null = no search yet). `pattern` defaults to `*` (all files).
  const codesSearchMode = ref<CodeSearchMode>('filename')
  const codesSearchQuery = ref('')
  const codesSearchPattern = ref('*')
  const codesSearchResult = ref<CodesSearchResultView | null>(null)
  const codesSearchLoading = ref(false)

  const codesActiveTab = computed<CodeTab | null>(
    () => codesTabs.value.find((tab) => tab.path === codesActivePath.value) ?? null,
  )
  // Codes 内嵌 ChatColumn 的「每工作区最后一次会话」指针(workspaceId → sessionId),
  // 作为持久化到内存的运行时镜像:openCodes 恢复时优先读 localStorage,该 ref 供
  // create/reset 后即时判定 create-vs-reset 按钮态,避免反复读 localStorage。与 Works
  // 的 consoleSession 是两个独立指针,互不覆盖。
  const codesBoundSessionId = ref<Record<string, string>>({})

  // ---- System settings (agent config) ----
  const settingsOpen = ref(false)
  const serverSettings = ref<SystemSettings | null>(null)
  const hostStatus = ref<VendorHostStatus[]>([])
  const bindingStats = ref<SessionBindingStats | null>(null)
  const sessionCapabilities = ref<Record<VendorId, SessionCapabilities> | null>(null)
  const skillSupport = ref<Record<VendorId, SkillSupportState> | null>(null)
  const vendorCapabilities = ref<Record<VendorId, Record<AdapterCapability, boolean>> | null>(null)
  const vendorModes = ref<Record<VendorId, VendorModeCatalog> | null>(null)
  const skillApprovalRequest = ref<ApprovalRequest | null>(null)
  const skillLinkStatuses = ref<SkillLinkStatus[]>([])
  const installingSkillIds = ref<string[]>([])

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

  // ---- New-session agent picker (the "+" modal) ----
  const newSessionOpen = ref(false)
  const newSessionWorkspace = ref<string | null>(null)
  const activeVendor = ref<VendorId | null>(null)
  // Whether the active session's vendor exposes the SDK task surface (`taskStore`).
  const taskStoreAvailable = computed(() => {
    const caps = vendorCapabilities.value
    const vendor = activeVendor.value
    if (!caps || !vendor) return true
    return caps[vendor]?.taskStore ?? true
  })
  const activeAgentSwitch = ref<SessionAgentSwitch | null>(null)
  // The active session's title-bar source action (jump target + label family),
  // derived on `session_selected` from its owner metadata (+ the legacy
  // `linkedIntentId` compat field); null ⇒ no source button. Refreshed/cleared on
  // every (re)select, same lifecycle as `activeVendor`.
  const activeSessionSource = ref<SessionSourceAction | null>(null)
  // One-shot request to select a specific intent on the intents page (set by the
  // title-bar jump button, consumed + cleared by Intents.vue once applied).
  const requestedIntentId = ref<string | null>(null)
  // One-shot request to select a specific work session on the console tab. It can
  // wait first for the intent's last work session id, then for that work row.
  const requestedWorkSessionId = ref<PendingWorkSessionSelectRequest | null>(null)
  // One-shot request to force IntentDetail to switch to a specific sub-tab (set by
  // the WorkCenter jump-to-source, consumed + cleared by IntentDetail once applied).
  const requestedIntentSubTab = ref<'intentSession' | 'specSession' | null>(null)
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

  // The mode-picker options for the viewed session.
  const modeOptions = computed(() => {
    const vendor = activeVendor.value
    const catalog = vendor ? vendorModes.value?.[vendor] : undefined
    const list = catalog
      ? catalog.modes.map((m) => ({ token: m.token, labelCode: m.labelCode }))
      : CLAUDE_MODE_FALLBACK
    return list.map((m) => ({ value: m.token, label: modeLabel(m.labelCode) }))
  })

  // The time zone automation cron fields are interpreted in for the live preview.
  const automationTimezone = computed(
    () => serverSettings.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  )

  // ---- Toast (transient, auto-dismissing global toast) ----
  const toast = ref<string | null>(null)
  // Intent action failures need an explicit acknowledgement, unlike transient toast feedback.
  const intentActionError = ref<string | null>(null)
  const intentActionErrorSeq = ref(0)
  const intentPrSync = ref<
    Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  >({})
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(text: string): void {
    toast.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 4000)
  }
  function showIntentActionError(text: string): void {
    intentActionError.value = text
  }
  function closeIntentActionError(): void {
    intentActionError.value = null
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

  // ---- Pure (state-only) message-append helpers ----
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
    // primitives / runtime helpers
    counters,
    flags,
    add,
    setQueue,
    statusOf,
    clearSideEffectPending,
    showToast,
    showIntentActionError,
    closeIntentActionError,
    sessionTitleById,
    devLaunchTimers,
    clearDevLaunchTimers,
    closeDevLaunch,
    specLaunchTimers,
    clearSpecLaunchTimers,
    closeSpecLaunch,
    clearPendingDeepLink,
    // refs
    messages,
    status,
    sessionStatus,
    mode,
    codexPolicy,
    taskModel,
    workspaces,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    currentWorkspace,
    activeWorkspace,
    activeSession,
    activeTitle,
    workcenterEvents,
    workcenterHasMore,
    workcenterLoading,
    workcenterAppendNext,
    workcenterPage,
    dashboardRows,
    dashboardLoading,
    dashboardError,
    dashboardPending,
    dashboardRefreshPending,
    consoleSession,
    teamSessions,
    pendingQueues,
    composer,
    activity,
    sideEffectPendingBySession,
    currentAgentIndexBySession,
    availableCommands,
    updateStatus,
    viewMode,
    savedTab,
    activeTab,
    intentsProject,
    intents,
    automation,
    intentSessions,
    intentSessionRunStates,
    selectedIntentSessionId,
    intentSpecContent,
    intentSpecLoading,
    pendingSpecRel,
    intentLogsById,
    intentLogsLoading,
    discussionsProject,
    discussions,
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
    automationsProject,
    automations,
    selectedAutomationId,
    automationLogs,
    executionTranscripts,
    selectedExecutionId,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabled,
    automationEnabledSaving,
    automationSettingBeforeSave,
    automationToolManifest,
    automationToolManifestLoading,
    automationToolManifestError,
    automationSaving,
    automationFormOpen,
    automationFormTarget,
    codesProject,
    codesDirs,
    codesExpanded,
    codesLoadingDirs,
    codesGitStatus,
    codesTabs,
    codesActivePath,
    codesSearchMode,
    codesSearchQuery,
    codesSearchPattern,
    codesSearchResult,
    codesSearchLoading,
    codesBoundSessionId,
    settingsOpen,
    serverSettings,
    hostStatus,
    bindingStats,
    sessionCapabilities,
    skillSupport,
    vendorCapabilities,
    vendorModes,
    skillApprovalRequest,
    skillLinkStatuses,
    installingSkillIds,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    newSessionOpen,
    newSessionWorkspace,
    activeVendor,
    activeAgentSwitch,
    activeSessionSource,
    requestedIntentId,
    requestedWorkSessionId,
    requestedIntentSubTab,
    requestedMergedTab,
    requestedIntentSessionId,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    toast,
    intentActionError,
    intentActionErrorSeq,
    intentPrSync,
    devLaunch,
    specLaunch,
    // computeds
    authStatus,
    workcenterPendingCount,
    hasActiveSession,
    currentSessions,
    activeSessionKind,
    sessionCounts,
    currentSessionPaging,
    running,
    reconnecting,
    activeIsTeam,
    currentQueue,
    actionablePermId,
    sideEffectPending,
    currentAgentName,
    HEADER_TABS,
    currentIntents,
    intentsSdd,
    currentIntentsSdd,
    currentWorkflow,
    currentIntentSessions,
    currentDiscussions,
    activeDiscussionRunState,
    activeDiscussionDispatch,
    activeResearchLive,
    activeDiscussionPhase,
    showStart,
    currentAutomations,
    selectedAutomation,
    selectedAutomationLogs,
    selectedExecution,
    codesActiveTab,
    taskStoreAvailable,
    modeOptions,
    automationTimezone,
  }
}

export type AppState = ReturnType<typeof createState>

// Re-export DepType so action installers can reference it without re-importing
// the shared protocol path (keeps the update-deps signature in one place).
export type { DepType }
