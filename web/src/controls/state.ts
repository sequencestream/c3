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
import { type SessionRef } from '@/lib/tab-view'
import type { ChatBody, ChatMsg, RunActivity } from '@/lib/chat-types'
import { agentNameAt } from '@/lib/agent-prefix'
import type {
  AutomationStatus,
  CodexPolicy,
  DepType,
  Discussion,
  ModeToken,
  VendorModeCatalog,
  Intent,
  IntentSessionInfo,
  WorkspaceSetting as WorkspaceSettingType,
  Schedule,
  ScheduleExecutionLog,
  ToolManifestEntry,
  AdapterCapability,
  SessionAgentSwitch,
  SessionBindingStats,
  SessionCapabilities,
  SessionInfo,
  SessionStatus,
  SkillLinkStatus,
  SkillSupportState,
  SlashCommandInfo,
  SystemSettings,
  TranscriptItem,
  VendorHostStatus,
  VendorId,
  WaitUserInvolveEvent,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
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
export const SCHED_PROJECT_KEY = 'c3.schedulesProject'
export const CURRENT_WS_KEY = 'c3.currentWorkspace'

export type TabKey = 'console' | 'intents' | 'discussion' | 'schedules'

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
  // `pendingConsoleBind`: a workspace switch cleared the chat column and is
  // waiting for the new workspace's `list_sessions` reply to bind its first session.
  const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }

  // "Current task list" of the viewed session (server-derived, pushed over the
  // `task_*` wire path). Reset on session_selected, then filled from those messages.
  const taskModel = ref<TaskListModel>(emptyTaskModel())

  // Sidebar / session state
  const workspaces = ref<WorkspaceInfo[]>([])
  const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
  // The single global "current workspace" the sidebar reflects; decoupled from the
  // viewed session's workspace (`activeWorkspace`). Persisted to localStorage.
  const currentWorkspace = ref<string | null>(null)
  const activeWorkspace = ref<string | null>(null)
  const activeSession = ref<string | null>(null)
  const activeTitle = ref<string>('')

  // WorkCenter: pending user-involve events for event list.
  const workcenterEvents = ref<WaitUserInvolveEvent[]>([])
  const workcenterPendingCount = computed(
    () => workcenterEvents.value.filter((event) => event.status === 'todo').length,
  )

  // The 「会话」(console) tab remembers its OWN last-viewed session, independent of
  // the 「需求」tab's comm session — so switching tabs never crosses chat content.
  const consoleSession = ref<SessionRef | null>(null)

  const hasActiveSession = computed(() => activeSession.value !== null)
  // Sessions of the current workspace (the only ones the sidebar lists).
  const currentSessions = computed<SessionInfo[]>(
    () => (currentWorkspace.value && sessionsByWorkspace.value[currentWorkspace.value]) || [],
  )

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
  const composer = ref<{ prefill: (text: string) => void } | null>(null)

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

  // ---- View mode (workspace / workcenter) ----
  const viewMode = ref<'workspace' | 'workcenter'>('workspace')
  // 切到 workcenter 前记住的标签页,切回 workspace 时恢复。
  const savedTab = ref<TabKey>('console')

  // ---- Top-bar tabs ----
  const HEADER_TABS = computed<{ key: TabKey; label: string; badgeCount?: number }[]>(() => [
    { key: 'console', label: t('nav.tab.console.label') },
    { key: 'intents', label: t('nav.tab.intents.label') },
    { key: 'discussion', label: t('nav.tab.discussion.label') },
    { key: 'schedules', label: t('nav.tab.schedules.label') },
  ])
  const activeTab = ref<TabKey>('console')
  const intentsProject = ref<string | null>(null)
  const intents = ref<Record<string, Intent[]>>({})

  const currentIntents = computed<Intent[]>(() =>
    intentsProject.value ? (intents.value[intentsProject.value] ?? []) : [],
  )

  // Per-project automation-orchestrator status (server pushes `automation_status`).
  const automation = ref<Record<string, AutomationStatus>>({})
  const currentAutomation = computed<AutomationStatus | null>(() =>
    intentsProject.value ? (automation.value[intentsProject.value] ?? null) : null,
  )

  // ---- Intent session list (middle column) ----
  const intentSessions = ref<Record<string, IntentSessionInfo[]>>({})
  const currentIntentSessions = computed<IntentSessionInfo[]>(() =>
    intentsProject.value ? (intentSessions.value[intentsProject.value] ?? []) : [],
  )
  const intentSessionRunStates = ref<Record<string, 'running'>>({})
  const selectedIntentSessionId = ref<string | null>(null)

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

  // ---- Schedules view (read path) ----
  const schedulesProject = ref<string | null>(null)
  const schedules = ref<Record<string, Schedule[]>>({})
  const currentSchedules = computed<Schedule[]>(() =>
    schedulesProject.value ? (schedules.value[schedulesProject.value] ?? []) : [],
  )
  const selectedScheduleId = ref<string | null>(null)
  const selectedSchedule = computed<Schedule | null>(() => {
    if (!selectedScheduleId.value || !schedulesProject.value) return null
    return currentSchedules.value.find((s) => s.id === selectedScheduleId.value) ?? null
  })
  const scheduleLogs = ref<Record<string, ScheduleExecutionLog[]>>({})
  const selectedScheduleLogs = computed<ScheduleExecutionLog[]>(() =>
    selectedScheduleId.value ? (scheduleLogs.value[selectedScheduleId.value] ?? []) : [],
  )
  const executionTranscripts = ref<Record<string, TranscriptItem[]>>({})
  const selectedExecutionId = ref<string | null>(null)
  const selectedExecution = computed<ScheduleExecutionLog | null>(() => {
    if (!selectedExecutionId.value) return null
    return selectedScheduleLogs.value.find((l) => l.id === selectedExecutionId.value) ?? null
  })

  // Schedule-form tool manifest: cached per vendor, cleared on form close.
  const scheduleToolManifest = ref<Record<string, ToolManifestEntry[] | null>>({})
  const scheduleToolManifestLoading = ref(false)
  const scheduleToolManifestError = ref<string | null>(null)

  // The modal serves both create (target = null) and edit (target = a schedule).
  const scheduleFormOpen = ref(false)
  const scheduleFormTarget = ref<Schedule | null>(null)

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

  // The mode-picker options for the viewed session.
  const modeOptions = computed(() => {
    const vendor = activeVendor.value
    const catalog = vendor ? vendorModes.value?.[vendor] : undefined
    const list = catalog
      ? catalog.modes.map((m) => ({ token: m.token, labelCode: m.labelCode }))
      : CLAUDE_MODE_FALLBACK
    return list.map((m) => ({ value: m.token, label: modeLabel(m.labelCode) }))
  })

  // The time zone schedule cron fields are interpreted in for the live preview.
  const scheduleTimezone = computed(
    () => serverSettings.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  )

  // ---- Toast (transient, auto-dismissing global toast) ----
  const toast = ref<string | null>(null)
  const intentActionErrorSeq = ref(0)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(text: string): void {
    toast.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 4000)
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
    sessionTitleById,
    // refs
    messages,
    status,
    sessionStatus,
    mode,
    codexPolicy,
    taskModel,
    workspaces,
    sessionsByWorkspace,
    currentWorkspace,
    activeWorkspace,
    activeSession,
    activeTitle,
    workcenterEvents,
    consoleSession,
    teamSessions,
    pendingQueues,
    composer,
    activity,
    sideEffectPendingBySession,
    currentAgentIndexBySession,
    availableCommands,
    viewMode,
    savedTab,
    activeTab,
    intentsProject,
    intents,
    automation,
    intentSessions,
    intentSessionRunStates,
    selectedIntentSessionId,
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
    schedulesProject,
    schedules,
    selectedScheduleId,
    scheduleLogs,
    executionTranscripts,
    selectedExecutionId,
    scheduleToolManifest,
    scheduleToolManifestLoading,
    scheduleToolManifestError,
    scheduleFormOpen,
    scheduleFormTarget,
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
    newSessionOpen,
    newSessionWorkspace,
    activeVendor,
    activeAgentSwitch,
    toast,
    intentActionErrorSeq,
    // computeds
    authStatus,
    workcenterPendingCount,
    hasActiveSession,
    currentSessions,
    running,
    reconnecting,
    activeIsTeam,
    currentQueue,
    actionablePermId,
    sideEffectPending,
    currentAgentName,
    HEADER_TABS,
    currentIntents,
    currentAutomation,
    currentIntentSessions,
    currentDiscussions,
    activeDiscussionRunState,
    activeDiscussionDispatch,
    activeResearchLive,
    activeDiscussionPhase,
    showStart,
    currentSchedules,
    selectedSchedule,
    selectedScheduleLogs,
    selectedExecution,
    taskStoreAvailable,
    modeOptions,
    scheduleTimezone,
  }
}

export type AppState = ReturnType<typeof createState>

// Re-export DepType so action installers can reference it without re-importing
// the shared protocol path (keeps the update-deps signature in one place).
export type { DepType }
