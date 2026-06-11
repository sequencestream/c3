<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { createWsClient } from './lib/ws'
import { actionablePermissionId } from './lib/permission'
import { resolveCurrentWorkspace } from './lib/current-workspace'
import {
  appendItem,
  mergeQueue,
  removeItem,
  shouldFlush,
  type PendingItem,
} from './lib/pending-queue'
import AppHeader from './components/AppHeader/AppHeader.vue'
import Works from './pages/works/Works.vue'
import Intents from './pages/intents/Intents.vue'
import Discussions from './pages/discussions/Discussions.vue'
import Schedules from './pages/schedules/Schedules.vue'
import WorkCenter from './pages/workcenter/WorkCenter.vue'
import SystemSettingsPage from './pages/systemsettings/SystemSettings.vue'
import WorkspaceSettingPage from './pages/workspacesetting/WorkspaceSetting.vue'
import Login from './pages/login/Login.vue'
import { useAuth } from './composables/useAuth'
import SkillApprovalModal from './components/SkillApprovalModal/SkillApprovalModal.vue'
import type { ApprovalRequest } from './components/SkillApprovalModal/SkillApprovalModal.vue'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  reconcileRunState,
  reconcileResearchState,
  researchMessageToChat,
  discussionPhase,
  showDiscussionStart,
  applyDispatchStatus,
  clearDispatchAgent,
  type DispatchView,
  type DiscussionPhase,
} from './lib/discussion-view'
import { applyTaskEvent, emptyTaskModel, type TaskListModel } from './lib/task-list'
import {
  consoleEntryTarget,
  consoleTabEntryEffects,
  workspaceSwitchEffects,
  type SessionRef,
} from './lib/tab-view'
import type { ChatBody, ChatMsg, PermissionMsg, RunActivity } from './lib/chat-types'
import { advanceOnFailure, agentNameAt, resolveAgentIndex } from './lib/agent-prefix'
import type {
  AutomationStatus,
  CodexPolicy,
  CreateScheduleInput,
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
  UpdateScheduleInput,
  OpencodeServerStatus,
  IntentStatus,
  AdapterCapability,
  ServerToClient,
  SessionAgentSwitch,
  SessionBindingStats,
  SessionCapabilities,
  SessionInfo,
  SessionRunStatus,
  SessionStatus,
  SkillSupportState,
  SlashCommandInfo,
  SystemSettings,
  TranscriptItem,
  UiLang,
  VendorHostStatus,
  VendorId,
  WaitUserInvolveEvent,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import NewSessionModal from './pages/works/components/NewSessionModal/NewSessionModal.vue'
import { applyLocale, setStoredLocale, i18n, useTypedI18n, type Locale } from './i18n'
import { translateUiError } from './i18n/errors'
import { useModeLabel, CLAUDE_MODE_FALLBACK } from './composables/useModeLabel'

const { t } = useTypedI18n()
const modeLabel = useModeLabel()

const messages = ref<ChatMsg[]>([])
const status = ref<'connecting' | 'open' | 'closed'>('connecting')

// Authentication (ADR-0023). Purely reactive: `auth.status` stays 'unknown'
// until the server emits `unauthenticated` (login gate) or a login succeeds.
// When auth is disabled the server never signals, so the app renders normally.
const auth = useAuth()
const authStatus = computed(() => auth.status.value)
// Live run status per session (sidebar badges + input lock for the viewed one).
// Source of truth: server `ready.statuses` + `session_status` broadcasts.
const sessionStatus = ref<Record<string, SessionStatus>>({})
// The viewed session's permission mode, a vendor-native ModeToken (2026-06-07-012).
const mode = ref<ModeToken>('default')
// Codex dual-policy config (2026-06-08), when the active session is codex.
const codexPolicy = ref<CodexPolicy | null>(null)
let nextId = 1

// "Current task list" of the viewed session. Since 2026-06-07-009 the server
// derives the model (from the task-tool stream + history replay) and pushes it
// over the independent `task_*` wire path — the client no longer re-parses
// `tool_result.content`. Reset on session_selected, then filled from those
// messages (`task_list` = full snapshot; per-task variants = single upsert/delete).
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

// The 「会话」(console) tab remembers its OWN last-viewed session, independent of
// the 「需求」tab's comm session — so switching tabs never crosses chat content.
// The viewed state (`activeSession`/`messages`/…) reflects whichever tab is
// active; this pointer lets `switchToConsoleTab` re-bind the console tab's
// session (the server only streams to the currently-viewed session, so we
// re-`select_session` on switch rather than caching a stale `messages`). The
// intent tab needs no symmetric pointer: its comm session is server-tracked
// (`is_current` per project) and recovered by re-sending `open_intent_chat`.
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

// The viewed session is "running" (input locked) whenever it isn't idle —
// covers both an executing turn and one blocked awaiting a permission decision.
const running = computed(
  () => hasActiveSession.value && statusOf(activeSession.value as string) !== 'idle',
)

// The viewed session's agent run is in the transient socket-disconnect hold
// (SessionStatus `reconnecting`, AVAIL-7): backing off before a single
// auto-`resume` of the same run. Surfaced as a distinct "reconnecting…" middle
// state in the status bar — it's still `running` (input stays locked), so this
// only refines the label, like `activity`.
const reconnecting = computed(
  () => hasActiveSession.value && statusOf(activeSession.value as string) === 'reconnecting',
)

// Sessions upgraded to a persistent agent team (server `team_upgraded`). The lead
// process stays alive across turns, so the composer stays usable (messages route
// to the live lead) and a "结束团队" control ends it. Pruned when a session goes
// idle (the team run ended).
const teamSessions = ref<Set<string>>(new Set())
const activeIsTeam = computed(
  () => hasActiveSession.value && teamSessions.value.has(activeSession.value as string),
)

// ---- Pending send queue (ordinary sessions, client-side only) ----
// While an ordinary turn is in flight the server rejects user_prompt, so Send
// enqueues here instead. Kept per sessionId in memory (survives session
// switches; lost on reload). When the viewed session returns to idle and its
// queue is non-empty, the queue is merged into one prompt and flushed via the
// normal user_prompt path. No server/protocol change.
const pendingQueues = ref<Record<string, PendingItem[]>>({})
let nextQueueId = 1
// The active page container (Sessions / Intents) exposes `prefill`; this ref
// binds to whichever is mounted so queue-edit can fold text back into the composer.
const composer = ref<{ prefill: (text: string) => void } | null>(null)

const currentQueue = computed<PendingItem[]>(() =>
  activeSession.value ? (pendingQueues.value[activeSession.value] ?? []) : [],
)

function setQueue(sessionId: string, items: PendingItem[]) {
  pendingQueues.value = { ...pendingQueues.value, [sessionId]: items }
}

function onEnqueue(text: string) {
  const sid = activeSession.value
  if (!sid) return
  setQueue(sid, appendItem(currentQueue.value, text, nextQueueId++))
}

function onDeleteQueued(id: number) {
  const sid = activeSession.value
  if (!sid) return
  setQueue(sid, removeItem(currentQueue.value, id))
}

// Edit: pull the item out of the queue and fold its text back into the composer
// draft for re-editing (the composer appends with a newline if a draft exists).
function onEditQueued(item: PendingItem) {
  const sid = activeSession.value
  if (!sid) return
  setQueue(sid, removeItem(currentQueue.value, item.id))
  composer.value?.prefill(item.text)
}

// Flush the viewed session's queue once it is idle: merge into one prompt, send
// via the normal path, and clear the queue. onSubmit optimistically marks the
// session running, so this won't re-fire before the server confirms.
function flushIfReady() {
  const sid = activeSession.value
  if (!sid) return
  if (!shouldFlush(running.value, activeIsTeam.value, currentQueue.value.length)) return
  const merged = mergeQueue(currentQueue.value)
  setQueue(sid, [])
  onSubmit(merged)
}

// Trigger on a running→idle transition (status broadcast) or when switching to an
// already-idle session that still holds a queue.
watch([running, activeSession, activeIsTeam], () => flushIfReady())

// The one permission the user can still act on (the live, still-pending request),
// or null. Drives the actionable-vs-static split: history replayed from the
// buffer rebuilds permission cards with `decision: null`, but they are only
// clickable while the session is genuinely blocked on them — see
// `actionablePermissionId`. Everything else renders as a static history line.
const actionablePermId = computed<string | null>(() =>
  actionablePermissionId(
    messages.value,
    hasActiveSession.value && statusOf(activeSession.value as string) === 'awaiting_permission',
  ),
)

// Fine-grained activity of the viewed session, inferred from the event stream
// (see RunActivity). `running` is the authoritative on/off; this only refines
// the label. Reset on session switch; the replayed buffer tail re-derives it.
const activity = ref<RunActivity>({ phase: 'idle' })

// Per-session "danger state" flag (AS-R19): set when a turn ended with
// `turn_end { side_effect_pending: true }` — the side-effect gate refused an
// auto-resume because a write-class tool_use was unclosed at the disconnect, so
// the turn settled to idle awaiting a MANUAL continue. Drives the status bar's
// confirm + 「continue」control. Cleared the moment the session runs again
// (manual continue via onSubmit, or any new prompt) and on (re)select.
const sideEffectPendingBySession = ref<Record<string, boolean>>({})
const sideEffectPending = computed(
  () => hasActiveSession.value && !!sideEffectPendingBySession.value[activeSession.value as string],
)
function clearSideEffectPending(sessionId: string) {
  if (!sideEffectPendingBySession.value[sessionId]) return
  const next = { ...sideEffectPendingBySession.value }
  delete next[sessionId]
  sideEffectPendingBySession.value = next
}

// Which agent the viewed session is really running, inferred client-side like
// RunActivity. Stored as the session's CHAIN INDEX (position in the server's
// degradation order), not a name — so renaming/switching the default agent
// refreshes the prefix via the computed below, with no per-event reset. Index 0
// = the default agent; `agent_failed` advances it down the chain. Reset to 0 on
// (re)select (we don't track per-session bound agents — see agent-prefix.ts).
const currentAgentIndexBySession = ref<Record<string, number>>({})
const currentAgentName = computed(() =>
  activeSession.value
    ? agentNameAt(serverSettings.value, currentAgentIndexBySession.value[activeSession.value] ?? 0)
    : '',
)

// Available commands/skills for the active session's cwd (fetched lazily on the
// first `/`). Cleared on session switch so the next `/` refetches for the new cwd.
const availableCommands = ref<SlashCommandInfo[]>([])

// ---- View mode (workspace / workcenter) ----
// viewMode 切换 Workspace/Workcenter 两种操作模式。
// workspace 模式:左侧 WS switcher,中间标签页(Sessions/Intents/Discussions/Schedules)。
// workcenter 模式:事件列表+详情两栏布局。
// 首次切到 workcenter 时自动请求 list_wait_user_events,切回 workspace 时恢复之前标签页。
const viewMode = ref<'workspace' | 'workcenter'>('workspace')
// 切到 workcenter 前记住的标签页,切回 workspace 时恢复。
const savedTab = ref<TabKey>('console')
let viewModeFirstWorkcenter = true

function setViewMode(mode: 'workspace' | 'workcenter') {
  if (mode === viewMode.value) return
  if (mode === 'workcenter') {
    // 记住当前标签页
    savedTab.value = activeTab.value
    viewMode.value = 'workcenter'
    if (viewModeFirstWorkcenter) {
      viewModeFirstWorkcenter = false
      if (currentWorkspace.value)
        client?.send({ type: 'list_wait_user_events', projectPath: currentWorkspace.value })
    }
  } else {
    viewMode.value = 'workspace'
    // 恢复之前标签页
    activeTab.value = savedTab.value
    persistViewMode()
  }
}

// ---- Top-bar tabs ----
// `activeTab` is the explicit top-bar tab selection that drives which page the
// content area shows (only in workspace mode). The list is data so a future tab
// is just one more entry here + one branch in the body.
type TabKey = 'console' | 'intents' | 'discussion' | 'schedules'
const HEADER_TABS = computed<{ key: TabKey; label: string; badgeCount?: number }[]>(() => [
  { key: 'console', label: t('nav.tab.console.label') },
  { key: 'intents', label: t('nav.tab.intents.label') },
  { key: 'discussion', label: t('nav.tab.discussion.label') },
  { key: 'schedules', label: t('nav.tab.schedules.label') },
])
const activeTab = ref<TabKey>('console')
const intentsProject = ref<string | null>(null)
// Per-project intent lists (the server pushes `intents`; we ignore
// projects we aren't viewing).
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
// Per-project intent communication session lists (server pushes `intent_sessions`).
const intentSessions = ref<Record<string, IntentSessionInfo[]>>({})
const currentIntentSessions = computed<IntentSessionInfo[]>(() =>
  intentsProject.value ? (intentSessions.value[intentsProject.value] ?? []) : [],
)
// Live run-state snapshot for each intent session (id → 'running'); only active
// runs appear. Carried in every `intent_sessions` push, survives refresh/reconnect.
const intentSessionRunStates = ref<Record<string, 'running'>>({})
// The currently-selected intent session id (for highlighting + re-select guard).
const selectedIntentSessionId = ref<string | null>(null)

// ---- Discussion view (read path) ----
// Mirrors the intent view: the discussion tab shows a project's discussion
// list (left) and one opened discussion's read-only history (right). No live
// session in R1 — `discussion_detail` carries the full message history at once.
const discussionsProject = ref<string | null>(null)
const discussions = ref<Record<string, Discussion[]>>({})
const currentDiscussions = computed<Discussion[]>(() =>
  discussionsProject.value ? (discussions.value[discussionsProject.value] ?? []) : [],
)
const activeDiscussionId = ref<string | null>(null)
const activeDiscussion = ref<Discussion | null>(null)
// The opened discussion's history, normalized into chat bubbles for ChatMessages.
const discussionMessages = ref<ChatMsg[]>([])
// Highest message seq rendered for the open discussion — dedupes the live
// `discussion_message` stream against the `discussion_detail` snapshot.
const discussionMaxSeq = ref(0)
// Live run-state of each discussion's orchestration (id → running/paused),
// decoupled from the persisted status. Absent = no live run; driven by the
// `discussion_run_status` event. Drives the Pause/Resume control + composer mode.
const discussionRunState = ref<Record<string, 'running' | 'paused'>>({})
// Live research-phase state of each discussion (id → running), runtime-only and
// decoupled from status: driven by `research_run_status` and reconciled from the
// `discussions` list's `researchStates` snapshot. Present = the read-only research
// run is live → the right pane shows the research stream and Start stays hidden.
const researchState = ref<Record<string, 'running'>>({})
// The open discussion's research stream, normalized into chat bubbles. Runtime-only
// (research messages are never persisted), so it resets on switch and is not replayed
// on reconnect — only liveness is reconciled. `researchMaxSeq` dedupes the stream.
const researchMessages = ref<ChatMsg[]>([])
const researchMaxSeq = ref(0)
// Transient in-flight/failed status of dispatched agents, per discussion (id →
// pending agents + errors). Runtime-only; driven by `discussion_dispatch_status`
// and cleared by the reply message / run `ended` / discussion switch. Not persisted
// and not reconciled on reconnect (starts empty, self-heals) — see discussion-view.
const discussionDispatch = ref<Record<string, DispatchView>>({})
// Draft for the discussion composer (human speak / follow-up question).
const discussionInput = ref('')

// ---- Schedules view (read path) ----
// Mirrors the discussion view: shows a project's schedule list (left) and the
// selected schedule's detail (right). No live session involved — R1 is read-only.
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
// Execution logs per schedule, fetched on demand via `get_schedule_detail` and
// re-fetched whenever the schedule list is broadcast (i.e. after each run).
const scheduleLogs = ref<Record<string, ScheduleExecutionLog[]>>({})
const selectedScheduleLogs = computed<ScheduleExecutionLog[]>(() =>
  selectedScheduleId.value ? (scheduleLogs.value[selectedScheduleId.value] ?? []) : [],
)
// One execution's agent-session transcript, fetched on demand when the user
// expands "View session" on an llm-type history item. Keyed by executionId.
const executionTranscripts = ref<Record<string, TranscriptItem[]>>({})
// Second-level selection: which execution log within the selected schedule is
// active. Cleared when the schedule changes (user picks a different schedule).
const selectedExecutionId = ref<string | null>(null)
const selectedExecution = computed<ScheduleExecutionLog | null>(() => {
  if (!selectedExecutionId.value) return null
  return selectedScheduleLogs.value.find((l) => l.id === selectedExecutionId.value) ?? null
})

// Schedule-form tool manifest: cached per vendor, cleared on form close.
const scheduleToolManifest = ref<Record<string, ToolManifestEntry[] | null>>({})
const scheduleToolManifestLoading = ref(false)
const scheduleToolManifestError = ref<string | null>(null)

const VIEW_MODE_KEY = 'c3.viewMode'
const REQ_PROJECT_KEY = 'c3.intentsProject'
const DISC_PROJECT_KEY = 'c3.discussionsProject'
const DISC_ID_KEY = 'c3.discussionId'
const SCHED_PROJECT_KEY = 'c3.schedulesProject'
const CURRENT_WS_KEY = 'c3.currentWorkspace'

// Read the persisted current-workspace path (null when unset/unavailable).
function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(CURRENT_WS_KEY)
  } catch {
    return null
  }
}

// Persist the current-workspace selection so a hard refresh restores it.
function persistCurrentWorkspace() {
  try {
    if (currentWorkspace.value) localStorage.setItem(CURRENT_WS_KEY, currentWorkspace.value)
    else localStorage.removeItem(CURRENT_WS_KEY)
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// Persist the intent-view selection so a hard refresh restores it (Vue's
// in-memory state already survives a WS reconnect; this only covers reload).
function persistViewMode() {
  try {
    localStorage.setItem(VIEW_MODE_KEY, activeTab.value)
    if (intentsProject.value) localStorage.setItem(REQ_PROJECT_KEY, intentsProject.value)
    if (discussionsProject.value) localStorage.setItem(DISC_PROJECT_KEY, discussionsProject.value)
    if (activeDiscussionId.value) localStorage.setItem(DISC_ID_KEY, activeDiscussionId.value)
    else localStorage.removeItem(DISC_ID_KEY)
    if (schedulesProject.value) localStorage.setItem(SCHED_PROJECT_KEY, schedulesProject.value)
    else localStorage.removeItem(SCHED_PROJECT_KEY)
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// After `ready`, re-enter the intent view if a hard refresh left us there.
function maybeRestoreIntents(list: WorkspaceInfo[]) {
  let saved: { mode: string | null; proj: string | null }
  try {
    saved = {
      mode: localStorage.getItem(VIEW_MODE_KEY),
      proj: localStorage.getItem(REQ_PROJECT_KEY),
    }
  } catch {
    return
  }
  if (saved.mode === 'intents' && saved.proj && list.some((w) => w.path === saved.proj)) {
    activeTab.value = 'intents'
    intentsProject.value = saved.proj
    client?.send({ type: 'open_intent_chat', projectPath: saved.proj })
    client?.send({ type: 'list_intent_sessions', projectPath: saved.proj })
  }
}

// After `ready`, re-enter the discussion view if a hard refresh left us there,
// re-fetching the list and (if one was open) re-opening that discussion.
function maybeRestoreDiscussions(list: WorkspaceInfo[]) {
  let saved: { mode: string | null; proj: string | null; id: string | null }
  try {
    saved = {
      mode: localStorage.getItem(VIEW_MODE_KEY),
      proj: localStorage.getItem(DISC_PROJECT_KEY),
      id: localStorage.getItem(DISC_ID_KEY),
    }
  } catch {
    return
  }
  if (saved.mode === 'discussion' && saved.proj && list.some((w) => w.path === saved.proj)) {
    activeTab.value = 'discussion'
    discussionsProject.value = saved.proj
    client?.send({ type: 'list_discussions', projectPath: saved.proj })
    if (saved.id) {
      activeDiscussionId.value = saved.id
      client?.send({ type: 'open_discussion', discussionId: saved.id })
    }
  }
}

// After `ready`, re-enter the schedules view if a hard refresh left us there,
// re-fetching the list so the left panel is populated.
function maybeRestoreSchedules(list: WorkspaceInfo[]) {
  let saved: { mode: string | null; proj: string | null }
  try {
    saved = {
      mode: localStorage.getItem(VIEW_MODE_KEY),
      proj: localStorage.getItem(SCHED_PROJECT_KEY),
    }
  } catch {
    return
  }
  if (saved.mode === 'schedules' && saved.proj && list.some((w) => w.path === saved.proj)) {
    activeTab.value = 'schedules'
    schedulesProject.value = saved.proj
    selectedScheduleId.value = null
    client?.send({ type: 'list_schedules', workspacePath: saved.proj })
  }
}

// ---- System settings (agent config) ----
const settingsOpen = ref(false)
// Latest server settings; SettingsPanel deep-copies this into its own draft.
const serverSettings = ref<SystemSettings | null>(null)
// Runtime companions that ride the `settings` message (ADR-0012 / ADR-0015): each
// vendor's host-CLI presence (drives the new-session picker greying) + the
// session→agent binding counts (drives the "default change isn't retroactive" note).
const hostStatus = ref<VendorHostStatus[]>([])
const bindingStats = ref<SessionBindingStats | null>(null)

// Per-vendor session-lifecycle capability ledger (ADR-0011 addendum), riding the
// `settings` message as a top-level companion alongside `hostStatus` /
// `bindingStats`. Drives the session list's row-action gating by capability
// *state* — with zero `if (vendor === …)`. Null until the first `settings`
// reply arrives; the list degrades optimistically then.
const sessionCapabilities = ref<Record<VendorId, SessionCapabilities> | null>(null)

// Per-vendor external-skill mount support (ADR-0016/0017). Rides the `settings`
// message as an optional companion; absent → defaults to `full` for every vendor
// (no UI greying). Seeded from the `settings.skillSupport` field.
const skillSupport = ref<Record<VendorId, SkillSupportState> | null>(null)

// Per-vendor binary AdapterCapability ledger (interrupt / … / taskStore). Rides the
// `settings` message as an optional companion; absent → assume every capability
// present (no gating, old-session safe). Seeded from `settings.vendorCapabilities`.
const vendorCapabilities = ref<Record<VendorId, Record<AdapterCapability, boolean>> | null>(null)

// Each vendor's mode catalog (2026-06-07-012), seeded from `settings.vendorModes`.
// Drives the mode picker by the active session's vendor; absent (older server) →
// the built-in Claude fallback list keeps today's five-mode UX.
const vendorModes = ref<Record<VendorId, VendorModeCatalog> | null>(null)

// The current pending skill-load approval request, or null when idle. The
// SkillApprovalModal renders against this; the user's decision is sent back as
// `skill_load_approval_resolve` and clears it.
const skillApprovalRequest = ref<ApprovalRequest | null>(null)

// ---- Workspace setting ----
const workspaceSettingOpen = ref(false)
const currentWorkspaceSetting = ref<WorkspaceSettingType | null>(null)
// Server-probed default branch riding the `workspace_setting` load reply; the
// settings form uses it to pre-fill `defaultMainBranch`. Cleared with the setting.
const detectedMainBranch = ref<string | null>(null)

// First-class OpenCode server reachability (2026-06-07-003): a snapshot rides every
// connection's `ready`, and each up/down/retrying transition pushes `opencode_status`.
// Drives the session list's offline warning; `'none'` (unregistered) is treated as
// "no warning" since opencode then simply isn't an available vendor here.
const opencodeStatus = ref<OpencodeServerStatus>({ reachability: 'none', retrying: false })

// ---- New-session agent picker (the "+" modal) ----
const newSessionOpen = ref(false)
// The workspace the pending modal will create a session in.
const newSessionWorkspace = ref<string | null>(null)
// The active session's resolved agent vendor (from `session_selected`), for the
// title vendor dot. Null for comm sessions / when unset.
const activeVendor = ref<VendorId | null>(null)
// Whether the active session's vendor exposes the SDK task surface (`taskStore`).
// Gates the TaskPanel: a vendor without it never derives a task list, so the panel
// stays hidden. Defaults to `true` when capabilities are unknown — older servers
// (no `vendorCapabilities`), comm/pending sessions (no vendor), or a vendor missing
// from the ledger — so the panel degrades open, never wrongly suppressed.
const taskStoreAvailable = computed(() => {
  const caps = vendorCapabilities.value
  const vendor = activeVendor.value
  if (!caps || !vendor) return true
  return caps[vendor]?.taskStore ?? true
})
// The active session's same-vendor agent-switcher data (from `session_selected`),
// for the title-bar switcher. Always populated for real sessions so the status bar
// can display the correct agent name (the title-bar group itself hides when there
// are no candidates and the agent is available). Null for pending/comm sessions.
const activeAgentSwitch = ref<SessionAgentSwitch | null>(null)

// The mode-picker options for the viewed session: the active vendor's catalog when
// known, else the built-in Claude fallback. `{ value: token, label }` for BaseDropdown.
const modeOptions = computed(() => {
  const vendor = activeVendor.value
  const catalog = vendor ? vendorModes.value?.[vendor] : undefined
  const list = catalog
    ? catalog.modes.map((m) => ({ token: m.token, labelCode: m.labelCode }))
    : CLAUDE_MODE_FALLBACK
  return list.map((m) => ({ value: m.token, label: modeLabel(m.labelCode) }))
})

// The time zone schedule cron fields are interpreted in for the live preview /
// upcoming-runs list, so the client computes the same instants the server does.
// Falls back to the browser's own zone until the server settings arrive (which
// is also the server's default for a fresh install — see settings.ts).
const scheduleTimezone = computed(
  () => serverSettings.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
)

function openSettings() {
  settingsOpen.value = true
  client?.send({ type: 'get_settings' })
}

function openWorkspaceSetting() {
  workspaceSettingOpen.value = true
  const path = currentWorkspace.value
  if (path) client?.send({ type: 'load_workspace_setting', projectPath: path })
}

function saveWorkspaceSetting(config: WorkspaceSettingType) {
  const path = currentWorkspace.value
  if (path) client?.send({ type: 'save_workspace_setting', projectPath: path, config })
  workspaceSettingOpen.value = false
}

function saveSettings(settings: SystemSettings) {
  client?.send({ type: 'save_settings', settings })
  settingsOpen.value = false
}

// ---- UI language (runtime switch; decoupled from voiceLang) ----

// A transient, auto-dismissing global toast. Minimal by design (single message,
// error-only today); the language-switch rollback surfaces failures through it.
const toast = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 4000)
}

/**
 * Switch the UI language at runtime (no page reload): flip vue-i18n locale +
 * <html lang>, persist to localStorage, then push the change to the server
 * (authoritative source). If the WS send fails, roll the UI back and toast.
 */
function setLocale(next: UiLang) {
  const prev = i18n.global.locale.value as Locale
  if (next === prev) return
  applyLocale(next)
  setStoredLocale(next)
  try {
    if (!client) throw new Error('no connection')
    const base: SystemSettings = serverSettings.value ?? {
      agents: [],
      defaultAgentId: SYSTEM_AGENT_ID,
    }
    const settings: SystemSettings = { ...base, uiLang: next }
    client.send({ type: 'save_settings', settings })
    serverSettings.value = settings
  } catch {
    applyLocale(prev)
    setStoredLocale(prev)
    showToast(t('error.uiLang.saveFailed'))
  }
}

let client: ReturnType<typeof createWsClient> | null = null

onMounted(() => {
  client = createWsClient({
    onMessage: handleMessage,
    onStatus: (s) => (status.value = s),
    // Present the persisted session token on the handshake (`?token=`); read
    // per-connect so reconnects after login/logout carry the right token.
    getToken: auth.currentToken,
    // After a reconnect the server has a fresh per-connection view (`viewing`
    // reset). Re-select the active session so its history + live stream replay
    // and this connection re-attaches as a viewer.
    onReopen: () => {
      // In the intent view, resume the comm session (the server re-binds
      // the project's persisted `is_current` chat); otherwise re-select normally.
      if (activeTab.value === 'intents' && intentsProject.value) {
        client?.send({ type: 'open_intent_chat', projectPath: intentsProject.value })
        client?.send({ type: 'list_intent_sessions', projectPath: intentsProject.value })
      } else if (activeTab.value === 'discussion' && discussionsProject.value) {
        // Re-fetch the list and re-open the viewed discussion (read path, no
        // live session to re-bind — just re-pull the persisted history).
        client?.send({ type: 'list_discussions', projectPath: discussionsProject.value })
        if (activeDiscussionId.value)
          client?.send({ type: 'open_discussion', discussionId: activeDiscussionId.value })
      } else if (activeTab.value === 'schedules' && schedulesProject.value) {
        // Re-fetch the schedule list (read path, no live session) + settings (for
        // the timezone-aware next-run preview).
        client?.send({ type: 'list_schedules', workspacePath: schedulesProject.value })
        client?.send({ type: 'get_settings' })
      } else if (viewMode.value === 'workcenter') {
        // Re-fetch the pending event list (read path, no live session).
        if (currentWorkspace.value)
          client?.send({ type: 'list_wait_user_events', projectPath: currentWorkspace.value })
      } else if (activeWorkspace.value && activeSession.value) {
        client?.send({
          type: 'select_session',
          workspacePath: activeWorkspace.value,
          sessionId: activeSession.value,
        })
      }
      // Reconnect is a high-risk window for a stale status; pull a fresh snapshot.
      client?.send({ type: 'request_session_status' })
    },
  })

  // Let the auth store fire `login` / `logout` over this connection.
  auth.bindSender(client.send)

  // Session-layer status heartbeat: periodically pull the authoritative snapshot
  // so the UI reconciles even when the server's event-driven broadcast is dropped.
  const hbTimer = setInterval(() => {
    client?.send({ type: 'request_session_status' })
  }, 15_000)

  // While the user stays on the 「会话」(console) tab — i.e. the session list is
  // visible — re-fetch the current workspace's sessions every 10s so newly
  // created/removed sessions appear without a manual refresh. Skipped when the
  // tab is hidden or no workspace is selected to avoid useless traffic.
  const sessionsTimer = setInterval(() => {
    if (activeTab.value === 'console' && currentWorkspace.value) {
      refreshSessions(currentWorkspace.value)
    }
  }, 10_000)

  // Tab restored from background → fetch fresh status (browsers may deprioritise
  // WebSocket messages for backgrounded tabs).
  const onVis = () => {
    if (document.visibilityState === 'visible') {
      client?.send({ type: 'request_session_status' })
    }
  }
  document.addEventListener('visibilitychange', onVis)

  // Cleanup on unmount. Vue 3 allows lifecycle hooks within hooks — the inner
  // onUnmounted registers against the component, not the outer onMounted.
  onUnmounted(() => {
    clearInterval(hbTimer)
    clearInterval(sessionsTimer)
    document.removeEventListener('visibilitychange', onVis)
  })
})

function add(m: ChatBody) {
  messages.value.push({ ...m, id: nextId++ } as ChatMsg)
}

function transcriptToChat(item: TranscriptItem): ChatBody {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.text }
    case 'assistant':
      return { kind: 'assistant', text: item.text }
    case 'tool_use':
      return {
        kind: 'tool-use',
        toolUseId: item.toolUseId,
        toolName: item.toolName,
        input: item.input,
      }
    case 'tool_result':
      return {
        kind: 'tool-result',
        toolUseId: item.toolUseId,
        content: item.content,
        isError: item.isError,
      }
    case 'notice':
      return { kind: 'system', text: item.text }
  }
}

function handleMessage(msg: ServerToClient) {
  switch (msg.type) {
    case 'login_result':
      auth.handleLoginResult(msg.result)
      break
    case 'unauthenticated': {
      // The WS analogue of HTTP 401 — drop the local session, show the login
      // gate, and surface why (session expired / invalid / sign-in required).
      auth.handleUnauthenticated(msg.reason)
      const reasonKey =
        msg.reason === 'expired'
          ? 'auth.session.expired'
          : msg.reason === 'invalid'
            ? 'auth.session.invalid'
            : 'auth.session.missing'
      showToast(t(reasonKey))
      break
    }
    case 'ready':
      workspaces.value = msg.workspaces
      // Close workspace setting on reconnect — workspace may have changed.
      workspaceSettingOpen.value = false
      currentWorkspaceSetting.value = null
      detectedMainBranch.value = null
      applyStatuses(msg.statuses)
      // Restore the persisted current workspace (or fall back to most-recent),
      // then load its sessions for the sidebar.
      currentWorkspace.value = resolveCurrentWorkspace(readStoredWorkspace(), msg.workspaces)
      persistCurrentWorkspace()
      ensureSessions(currentWorkspace.value)
      // Pull settings up front so the new-session agent picker has the agent list +
      // per-vendor host-CLI status ready before the user clicks "+".
      client?.send({ type: 'get_settings' })
      // Restore the intent / discussion / schedules view if a hard refresh left us in it.
      maybeRestoreIntents(msg.workspaces)
      maybeRestoreDiscussions(msg.workspaces)
      maybeRestoreSchedules(msg.workspaces)
      break
    case 'workspaces': {
      workspaces.value = msg.workspaces
      // If the current workspace was removed, fall back to the most-recent one.
      const resolved = resolveCurrentWorkspace(currentWorkspace.value, msg.workspaces)
      if (resolved !== currentWorkspace.value) {
        currentWorkspace.value = resolved
        persistCurrentWorkspace()
        ensureSessions(resolved)
      }
      break
    }
    case 'session_status':
      applyStatuses(msg.statuses)
      break
    case 'opencode_status':
      opencodeStatus.value = msg.status
      break
    case 'sessions':
      sessionsByWorkspace.value = {
        ...sessionsByWorkspace.value,
        [msg.workspacePath]: msg.sessions,
      }
      break
    case 'session_selected':
      activeWorkspace.value = msg.workspacePath
      activeSession.value = msg.sessionId
      activeTitle.value = msg.title
      // The resolved agent vendor for the title dot (absent on comm sessions).
      activeVendor.value = msg.vendor ?? null
      // The same-vendor agent switcher data (absent ⇒ no switcher).
      activeAgentSwitch.value = msg.agentSwitch ?? null
      mode.value = msg.mode
      codexPolicy.value = msg.codexPolicy ?? null
      // Remember this as the console tab's own session ONLY when the selection
      // originated on the console tab. Comm-session selections (open/new/refine
      // intent chat) always arrive while the intent tab is active, so
      // they never pollute the console pointer.
      if (activeTab.value === 'console') {
        consoleSession.value = { workspacePath: msg.workspacePath, sessionId: msg.sessionId }
      }
      messages.value = []
      nextId = 1
      // Commands are per-cwd; drop the old set so the next `/` refetches.
      availableCommands.value = []
      // Seed this session's live status from the authoritative snapshot the server
      // computed at selection time. The composer lock derives from sessionStatus,
      // which is otherwise only fed by async broadcasts — so without this seed a
      // background-running session selected between two heartbeats shows "ready"
      // and lets the user submit into a live turn (server then rejects it with "A
      // turn is already running"). Later broadcasts keep it current.
      sessionStatus.value = { ...sessionStatus.value, [msg.sessionId]: msg.status }
      // History (on-disk baseline) renders first; the live buffer tail, if any,
      // follows as normal stream events (user_text/assistant_text/…).
      activity.value = { phase: 'idle' }
      // A (re)select re-derives status from the authoritative snapshot; clear any
      // stale danger flag so a re-entered/resumed session doesn't show a leftover
      // 「continue」 control (the flag re-arms only on a fresh `turn_end`).
      clearSideEffectPending(msg.sessionId)
      // Resolve the agent prefix from the session's bound agent (via agentSwitch)
      // rather than always showing the default. Falls back to 0 when the session
      // has no specific bound agent (comm/intent sessions, pending sessions).
      currentAgentIndexBySession.value = {
        ...currentAgentIndexBySession.value,
        [msg.sessionId]: resolveAgentIndex(serverSettings.value, msg.agentSwitch?.current.id),
      }
      // Reset the task panel on every (re)select; the server re-sends the derived
      // `task_list` (cold baseline snapshot, then any live buffer tail) right after
      // this message, so the panel rebuilds from the wire, not from history parsing.
      taskModel.value = emptyTaskModel()
      for (const item of msg.history) {
        add(transcriptToChat(item))
      }
      // When on the intents tab, keep the middle-column selection in sync with
      // the viewed session (the `intent_sessions` push may not have arrived yet).
      if (activeTab.value === 'intents') {
        selectedIntentSessionId.value = msg.sessionId
      }
      break
    case 'session_started':
      if (activeSession.value === msg.clientId) {
        activeAgentSwitch.value = msg.agentSwitch ?? null
        activeSession.value = msg.sessionId
        // Carry the agent degradation index from the pending clientId to the real
        // sessionId, so the status bar continues showing the correct agent after
        // the bind. Also re-resolve from agentSwitch if available (the pending
        // session may not have had one yet).
        const prevIdx = currentAgentIndexBySession.value[msg.clientId] ?? 0
        const resolved = resolveAgentIndex(serverSettings.value, msg.agentSwitch?.current.id)
        currentAgentIndexBySession.value = {
          ...currentAgentIndexBySession.value,
          [msg.sessionId]: Math.max(prevIdx, resolved),
        }
        delete currentAgentIndexBySession.value[msg.clientId]
        client?.send({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId })
      }
      break
    case 'session_agent_changed': {
      if (msg.sessionId !== activeSession.value) break
      if (!msg.ok) {
        // Cross-vendor rejection — vendor is frozen (AC-R17). The console only
        // offers same-vendor candidates, so this is a defensive path; surface it
        // and leave the switcher on its current agent.
        showToast(t('session.titleBar.agent.changeFailed'))
        break
      }
      // Re-target succeeded: rebuild the switcher locally so the dropdown shows the
      // new current (the old current rejoins the candidates). The next turn resumes
      // with it. A freshly-chosen candidate was host-present ⇒ no longer unavailable.
      // Also update the agent degradation index so the status bar shows the new agent.
      const s = activeAgentSwitch.value
      if (s) {
        const all = [s.current, ...s.candidates]
        const picked = all.find((c) => c.id === msg.agentId)
        if (picked) {
          activeAgentSwitch.value = {
            current: picked,
            candidates: all.filter((c) => c.id !== msg.agentId),
            currentUnavailable: false,
          }
          currentAgentIndexBySession.value = {
            ...currentAgentIndexBySession.value,
            [msg.sessionId]: resolveAgentIndex(serverSettings.value, msg.agentId),
          }
        }
      }
      break
    }
    case 'mode_changed':
      mode.value = msg.mode
      codexPolicy.value = msg.codexPolicy ?? null
      break
    case 'commands':
      availableCommands.value = msg.commands
      break
    case 'workspace_setting':
      currentWorkspaceSetting.value = msg.config
      detectedMainBranch.value = msg.detectedMainBranch ?? null
      break
    case 'settings':
      serverSettings.value = msg.settings
      hostStatus.value = msg.hostStatus
      bindingStats.value = msg.bindingStats
      sessionCapabilities.value = msg.sessionCapabilities
      vendorCapabilities.value = msg.vendorCapabilities ?? null
      vendorModes.value = msg.vendorModes ?? null
      skillSupport.value = msg.skillSupport ?? null
      // Server is the single source of truth for UI language. Reconcile exactly
      // once and only when it disagrees with the live locale, to avoid a
      // save→settings→apply→save loop and any flicker.
      if (msg.settings.uiLang && msg.settings.uiLang !== i18n.global.locale.value) {
        applyLocale(msg.settings.uiLang)
        setStoredLocale(msg.settings.uiLang)
      }
      break
    case 'skill_load_approval_request':
      skillApprovalRequest.value = {
        requestId: msg.requestId,
        kind: msg.kind,
        id: msg.id,
        vendor: msg.vendor,
        repo: msg.repo,
        ref: msg.ref,
        detail: msg.detail,
      }
      break
    case 'intents':
      intents.value = { ...intents.value, [msg.projectPath]: msg.items }
      break
    case 'intent_sessions':
      intentSessions.value = { ...intentSessions.value, [msg.projectPath]: msg.items }
      // Authoritatively reconcile the live run-state from the snapshot — only
      // active runs are present. Survives refresh/reconnect.
      if (msg.runStates) {
        intentSessionRunStates.value = msg.runStates
      }
      // Update the selected session id when the list changes.
      if (msg.projectPath === intentsProject.value && msg.items.length > 0) {
        const active = msg.items.find((s) => s.sessionId === activeSession.value)
        if (active) {
          selectedIntentSessionId.value = active.sessionId
          // Sync the right-panel title with the DB title. Auto-title derivation
          // or manual rename broadcasts `intent_sessions` AFTER the initial
          // `session_selected` set `activeTitle` to the fallback "New Intent";
          // this keeps the right-panel header in sync without a re-select.
          if (active.title) {
            activeTitle.value = active.title
          }
        } else if (activeSession.value) {
          selectedIntentSessionId.value = activeSession.value
        } else {
          selectedIntentSessionId.value = msg.items[0].sessionId
        }
      }
      break
    case 'automation_status':
      automation.value = { ...automation.value, [msg.status.projectPath]: msg.status }
      break
    case 'discussions': {
      discussions.value = { ...discussions.value, [msg.projectPath]: msg.items }
      // Authoritatively reconcile the live run-state for THIS list's discussions from the
      // snapshot (only active runs present). This survives refresh/reconnect — a freshly
      // (re)connected view misses the transition-only `discussion_run_status` events, and a
      // soft reconnect may have missed an `ended`. Only listed ids are touched, so other
      // projects' run-state entries are left intact (see `reconcileRunState`).
      discussionRunState.value = reconcileRunState(
        discussionRunState.value,
        msg.items,
        msg.runStates,
      )
      // Same authoritative reconcile for the research phase (id → running). Survives
      // refresh/reconnect mid-research so the right pane stays on the research stream
      // and Start stays hidden (see `reconcileResearchState`).
      researchState.value = reconcileResearchState(
        researchState.value,
        msg.items,
        msg.researchStates,
      )
      // Keep the open discussion's status/conclusion in sync with the refreshed
      // list (the engine pushes this on every state change).
      if (activeDiscussionId.value) {
        const updated = msg.items.find((d) => d.id === activeDiscussionId.value)
        if (updated) activeDiscussion.value = updated
      }
      break
    }
    case 'schedules':
      schedules.value = { ...schedules.value, [msg.workspacePath]: msg.items }
      // After a run completes the server re-broadcasts the list; refresh the open
      // schedule's execution logs so history stays current without manual reload.
      if (
        activeTab.value === 'schedules' &&
        schedulesProject.value === msg.workspacePath &&
        selectedScheduleId.value
      ) {
        client?.send({ type: 'get_schedule_detail', scheduleId: selectedScheduleId.value })
      }
      break
    case 'schedule_detail':
      scheduleLogs.value = { ...scheduleLogs.value, [msg.schedule.id]: msg.logs }
      break
    case 'schedule_tool_manifest':
      scheduleToolManifest.value = { ...scheduleToolManifest.value, [msg.vendor]: msg.tools }
      scheduleToolManifestLoading.value = false
      scheduleToolManifestError.value = null
      break
    case 'execution_transcript':
      executionTranscripts.value = {
        ...executionTranscripts.value,
        [msg.executionId]: msg.items,
      }
      break
    case 'discussion_detail': {
      activeDiscussion.value = msg.discussion
      activeDiscussionId.value = msg.discussion.id
      // Render the persisted history as read-only chat bubbles (own id space).
      // The speaker resolver needs the configured agents + default agent id so
      // each message can show its 「icon + name」 small line; `serverSettings`
      // may be null on first paint — the resolver tolerates an empty list and
      // falls back to the generic icons (see discussion-view).
      const agents = serverSettings.value?.agents ?? []
      const defaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
      discussionMessages.value = discussionMessagesToChat(
        msg.messages,
        agents,
        defaultAgentId,
        t,
      ).map((b, i) => ({
        ...b,
        id: i + 1,
      }))
      discussionMaxSeq.value = msg.messages.length ? msg.messages[msg.messages.length - 1].seq : 0
      // Research messages are runtime-only (never in `discussion_detail`); reset the
      // stream on every open/switch so a reconnect mid-research shows only the live
      // tail (liveness comes from the `researchStates` snapshot).
      researchMessages.value = []
      researchMaxSeq.value = 0
      persistViewMode()
      break
    }
    case 'discussion_message': {
      // A landed reply clears its author's in-flight (pending) status — the snappy
      // primary clear for the message path (redundant with the server's `cleared`).
      const cleared = clearDispatchAgent(
        discussionDispatch.value[msg.discussionId],
        msg.message.speakerAgentId,
      )
      if (cleared !== discussionDispatch.value[msg.discussionId])
        discussionDispatch.value = { ...discussionDispatch.value, [msg.discussionId]: cleared! }
      // Live append while the organizer engine runs. Only for the open discussion,
      // and only messages newer than what the snapshot already rendered.
      if (
        msg.discussionId === activeDiscussionId.value &&
        msg.message.seq > discussionMaxSeq.value
      ) {
        discussionMaxSeq.value = msg.message.seq
        // Same agents / default-agent id as the snapshot path above; see that
        // comment for the `serverSettings.value` null tolerance.
        const liveAgents = serverSettings.value?.agents ?? []
        const liveDefaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
        discussionMessages.value.push({
          ...discussionMessageToChat(msg.message, liveAgents, liveDefaultAgentId, t),
          id: discussionMessages.value.length + 1,
        })
      }
      break
    }
    case 'discussion_dispatch_status': {
      // Transient in-flight/failed status of dispatched agents (pending → cleared/
      // failed). Aggregate per discussion; never persisted.
      discussionDispatch.value = {
        ...discussionDispatch.value,
        [msg.discussionId]: applyDispatchStatus(discussionDispatch.value[msg.discussionId], msg),
      }
      break
    }
    case 'discussion_run_status': {
      // Track the live run-state; `ended` drops the entry (fall back to status).
      const next = { ...discussionRunState.value }
      if (msg.state === 'ended') delete next[msg.discussionId]
      else next[msg.discussionId] = msg.state
      discussionRunState.value = next
      // The run ending clears any lingering dispatch status for that discussion.
      if (msg.state === 'ended' && discussionDispatch.value[msg.discussionId]) {
        const d = { ...discussionDispatch.value }
        delete d[msg.discussionId]
        discussionDispatch.value = d
      }
      break
    }
    case 'research_message': {
      // Live append of a research turn while the read-only research agent works.
      // Only for the open discussion, and only items newer than what's rendered.
      if (msg.discussionId === activeDiscussionId.value && msg.message.seq > researchMaxSeq.value) {
        researchMaxSeq.value = msg.message.seq
        researchMessages.value.push({
          ...researchMessageToChat(msg.message, {
            researcher: t('discussion.speaker.researcher'),
            tool: (toolName) => t('discussion.research.toolActivity', { tool: toolName }),
          }),
          id: researchMessages.value.length + 1,
        })
      }
      break
    }
    case 'research_run_status': {
      // Track research liveness; `ended` drops the entry (the phase flips to the
      // discussion stream, which the server auto-starts on success).
      const next = { ...researchState.value }
      if (msg.state === 'ended') delete next[msg.discussionId]
      else next[msg.discussionId] = 'running'
      researchState.value = next
      break
    }
    case 'user_text':
      add({ kind: 'user', text: msg.text })
      activity.value = { phase: 'thinking' }
      break
    case 'assistant_text':
      add({ kind: 'assistant', text: msg.text })
      activity.value = { phase: 'thinking' }
      break
    case 'notice':
      // A turn that produced no visible output (thinking-only). Render the muted
      // line; the following `turn_end` settles activity to idle.
      add({ kind: 'system', text: msg.text })
      break
    case 'tool_use':
      add({
        kind: 'tool-use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        input: msg.input,
        // Audit hint from the driver path: vendor rule engine auto-allowed this
        // tool (no permission_request raised) → render the "pre-approved" color.
        ...(msg.preApproved ? { preApproved: true } : {}),
        // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      activity.value = { phase: 'tool', toolName: msg.toolName }
      break
    case 'tool_result':
      add({
        kind: 'tool-result',
        toolUseId: msg.toolUseId,
        content: msg.content,
        isError: msg.isError,
        // Carry the user-interaction flag from the matched tool-use
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      // Tool returned — the model is now deciding the next step (the "stuck
      // after grep" moment the status bar exists to make visible).
      activity.value = { phase: 'thinking' }
      break
    // Task-list wire path (2026-06-07-009): server-derived, replaces client-side
    // tool_result parsing. `task_list` = full snapshot; the per-task variants are
    // single upsert/delete (native push from vendors that support it). The fold is
    // the pure `applyTaskEvent` (unit-tested in lib/task-list.test.ts).
    case 'task_list':
    case 'task_created':
    case 'task_updated':
    case 'task_deleted':
      taskModel.value = applyTaskEvent(taskModel.value, msg)
      break
    case 'permission_request':
      add({
        kind: 'permission',
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        decision: null,
        consensus: msg.consensus,
        // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
        ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
      })
      activity.value = { phase: 'awaiting' }
      break
    case 'consensus_auto':
      add({
        kind: 'consensus',
        toolName: msg.toolName,
        input: msg.input,
        outcome: msg.outcome,
      })
      activity.value = { phase: 'thinking' }
      break
    case 'turn_end':
      // A turn finished — the session stays active for the next prompt. The
      // input unlocks via sessionStatus (server broadcasts idle). Only surface a
      // line on error; a normal completion just frees the input.
      if (msg.reason === 'error') {
        add({
          kind: 'system',
          text: t('session.turn.error', { error: msg.error ?? t('common.unknown.label') }),
        })
        activity.value = { phase: 'error', message: msg.error ?? 'unknown' }
        // Danger state (AS-R19): the side-effect gate refused auto-resume. Flag
        // the session so the status bar shows the confirm + manual 「continue」.
        if (msg.side_effect_pending && activeSession.value) {
          sideEffectPendingBySession.value = {
            ...sideEffectPendingBySession.value,
            [activeSession.value]: true,
          }
        }
      } else {
        activity.value = { phase: 'idle' }
      }
      break
    case 'team_upgraded':
      // The viewed session became a persistent agent team. Mark it so the
      // composer stays usable across turns; reconnects replay this from the
      // buffer, so re-entering a team session restores the flag.
      if (activeSession.value) {
        teamSessions.value = new Set(teamSessions.value).add(activeSession.value)
      }
      add({ kind: 'system', text: t('session.team.upgraded') })
      break
    case 'agent_failed':
      // The current agent hit a rate-limit/auth/connection error — the server
      // is trying the next agent in the degradation chain. Surface which agent
      // failed and why.
      add({
        kind: 'system',
        text: t('session.agent.failed', { agentName: msg.agentName, error: msg.error }),
      })
      // The failed agent (msg.agentId) is handing off to the next in the chain —
      // advance the viewed session's prefix to match what's now running.
      if (activeSession.value) {
        const sid = activeSession.value
        currentAgentIndexBySession.value = {
          ...currentAgentIndexBySession.value,
          [sid]: advanceOnFailure(
            serverSettings.value,
            currentAgentIndexBySession.value[sid] ?? 0,
            msg.agentId,
          ),
        }
      }
      break
    case 'all_agents_failed':
      // Every agent in the degradation chain failed. The turn ends with error.
      add({ kind: 'system', text: `— ${msg.message} —` })
      // Honestly note any cross-vendor fallback that was skipped (it cannot resume
      // this session's context, so it was never tried) — see 2026-06-06-006.
      if (msg.crossVendorSkipped && msg.crossVendorSkipped.length > 0) {
        add({
          kind: 'system',
          text: t('session.agent.crossVendorSkipped', {
            count: msg.crossVendorSkipped.length,
            agents: msg.crossVendorSkipped.map((a) => a.agentName).join(', '),
          }),
        })
      }
      break
    case 'error':
      // Machine-readable code translated locally via the web i18n catalog (spec 003).
      add({ kind: 'system', text: `— ${translateUiError(msg.error)} —` })
      break
    case 'wait_user_events':
      workcenterEvents.value = msg.items
      break
  }
}

// Replace the status map and fire a notification when a *background* session
// newly enters `awaiting_permission` (one you're not currently looking at).
function applyStatuses(statuses: SessionRunStatus[]) {
  const prev = sessionStatus.value
  for (const s of statuses) {
    if (
      s.status === 'awaiting_permission' &&
      prev[s.sessionId] !== 'awaiting_permission' &&
      s.sessionId !== activeSession.value
    ) {
      notifyAwaitingPermission(s.sessionId)
    }
  }
  const next: Record<string, SessionStatus> = {}
  for (const s of statuses) next[s.sessionId] = s.status
  sessionStatus.value = next
  // A team session that drops to idle (or vanishes) has ended — clear its flag so
  // the composer reverts to normal locking on the next turn.
  if (teamSessions.value.size) {
    const live = new Set(
      [...teamSessions.value].filter((id) => {
        const st = next[id]
        return st === 'team' || st === 'running' || st === 'awaiting_permission'
      }),
    )
    if (live.size !== teamSessions.value.size) teamSessions.value = live
  }
  // Level-triggered flush backstop: every status broadcast/reconcile re-checks the
  // viewed session, so a queue still flushes even if the running→idle transition
  // was missed (the `watch` below is edge-triggered and would skip it). Idempotent
  // — `shouldFlush` gates on idle+non-empty and `onSubmit` optimistically re-locks.
  flushIfReady()
}

function sessionTitleById(id: string): string {
  for (const list of Object.values(sessionsByWorkspace.value)) {
    const s = list.find((x) => x.sessionId === id)
    if (s) return s.title
  }
  return t('session.fallback.label')
}

// Browser notification for a background session needing approval. Lazily asks
// for permission the first time (no-op if the user has denied notifications).
function notifyAwaitingPermission(id: string) {
  if (typeof Notification === 'undefined') return
  const show = () =>
    new Notification(t('permission.notification.title'), {
      body: t('permission.notification.body', { title: sessionTitleById(id) }),
    })
  if (Notification.permission === 'granted') show()
  else if (Notification.permission !== 'denied')
    Notification.requestPermission().then((p) => {
      if (p === 'granted') show()
    })
}

// ---- Workspace / sidebar actions ----
// Force a fresh `list_sessions` for a workspace, bypassing the `ensureSessions`
// lazy cache. The `sessions` reply merges by `workspacePath`, so this refreshes
// only the target workspace's slice — other workspaces' caches are untouched.
function refreshSessions(path: string | null) {
  if (path) client?.send({ type: 'list_sessions', workspacePath: path })
}

// Lazily fetch a workspace's session list (once) for the sidebar.
function ensureSessions(path: string | null) {
  if (path && !sessionsByWorkspace.value[path]) refreshSessions(path)
}

// Switch the global current workspace. The view always lands on the 「会话」
// (console) tab and the target's session list is force-refreshed (a cached,
// possibly-stale list is re-fetched). Session re-binding stays with
// `switchToConsoleTab`/`consoleEntryTarget` — no new selection strategy.
function selectWorkspace(path: string) {
  const fx = workspaceSwitchEffects(path, currentWorkspace.value)
  if (fx.noop) return
  currentWorkspace.value = path
  persistCurrentWorkspace()
  workspaceSettingOpen.value = false
  currentWorkspaceSetting.value = null
  detectedMainBranch.value = null
  if (fx.refreshSessions) refreshSessions(path)
  if (fx.enterConsole) switchToConsoleTab()
}

function addWorkspace(path: string) {
  client?.send({ type: 'add_workspace', path })
}

function removeWorkspace(path: string) {
  client?.send({ type: 'remove_workspace', path })
}

// The "+" now opens the agent picker instead of creating immediately, so the new
// session can be bound to a chosen vendor/agent (or Auto). A fresh `get_settings`
// makes sure the picker shows the current agent list + host-CLI status.
function openNewSession(path: string) {
  newSessionWorkspace.value = path
  newSessionOpen.value = true
  client?.send({ type: 'get_settings' })
}

// Confirm the picker: create the session, optionally carrying the chosen agent as
// its pending intent. `agentId === null` ⇒ Auto (no intent, server falls back to
// the default agent).
function confirmNewSession(agentId: string | null) {
  const path = newSessionWorkspace.value
  newSessionOpen.value = false
  if (!path) return
  enterConsole()
  client?.send({
    type: 'create_session',
    workspacePath: path,
    ...(agentId ? { agentId } : {}),
  })
}

// The picker's "binary not in PATH → go to detection" link: close the picker and
// open settings (its diagnostics section lists every vendor's host-CLI status).
function openSettingsFromPicker() {
  newSessionOpen.value = false
  openSettings()
}

function selectSession(path: string, sessionId: string) {
  enterConsole()
  // Pin the console tab's pointer up front so it stays correct even on the
  // already-viewing early-return (no `session_selected` reply to record it).
  consoleSession.value = { workspacePath: path, sessionId }
  if (sessionId === activeSession.value) return
  client?.send({ type: 'select_session', workspacePath: path, sessionId })
}

// ---- Tab / intent actions ----
// Top-bar tab click: console switches back to the chat page; intents opens
// the current workspace's intent page (no-op without a workspace).
function onSelectTab(key: string) {
  if (key === 'intents') {
    if (currentWorkspace.value) openIntents(currentWorkspace.value)
    return
  }
  if (key === 'discussion') {
    if (currentWorkspace.value) openDiscussions(currentWorkspace.value)
    return
  }
  if (key === 'schedules') {
    if (currentWorkspace.value) openSchedules(currentWorkspace.value)
    return
  }
  switchToConsoleTab()
}

// Flip to the console tab WITHOUT re-binding a session. Used by the explicit
// session selectors (`selectSession`/`createSession`/`openDevSession`), which
// flip the tab and then select a specific session themselves — re-binding here
// would double-select / pick the wrong one.
function enterConsole() {
  if (activeTab.value !== 'console') {
    activeTab.value = 'console'
    persistViewMode()
  }
}

// Top-bar 「会话」tab click: flip to the console tab AND re-bind the chat column
// to the console tab's OWN session. Only re-binds when arriving from another tab
// (the chat column may currently show the intent comm session); clicking
// the already-active console tab is a no-op for the view. Arriving from another
// tab also force-refreshes the current workspace's session list, so a cached,
// possibly-stale sidebar list is re-fetched on entry.
function switchToConsoleTab() {
  const fx = consoleTabEntryEffects(activeTab.value !== 'console')
  enterConsole()
  if (fx.rebind) bindConsoleSession()
  if (fx.refreshSessions) refreshSessions(currentWorkspace.value)
}

// Resolve and apply the console tab's session on (re)entry: re-select the
// remembered one (or fall back to the workspace's first), or clear to empty.
function bindConsoleSession() {
  const target = consoleEntryTarget(
    consoleSession.value,
    currentWorkspace.value,
    currentSessions.value,
  )
  if (target.kind === 'empty') {
    clearViewedSession()
    return
  }
  const ref = target.ref
  // Already viewing it (e.g. fallback resolved to the current session) — nothing
  // to re-fetch.
  if (activeSession.value === ref.sessionId && activeWorkspace.value === ref.workspacePath) return
  client?.send({
    type: 'select_session',
    workspacePath: ref.workspacePath,
    sessionId: ref.sessionId,
  })
}

// Reset the viewed chat column to the empty state (no session). Mirrors the
// `session_selected` reset minus the history replay; used when the console tab
// has no session to show, so the intent comm session never lingers.
function clearViewedSession() {
  activeWorkspace.value = null
  activeSession.value = null
  activeTitle.value = ''
  activeVendor.value = null
  activeAgentSwitch.value = null
  messages.value = []
  nextId = 1
  availableCommands.value = []
  activity.value = { phase: 'idle' }
  taskModel.value = emptyTaskModel()
}

function openIntents(path: string) {
  activeTab.value = 'intents'
  intentsProject.value = path
  persistViewMode()
  // The response carries both the comm `session_selected` and the list.
  client?.send({ type: 'open_intent_chat', projectPath: path })
  // Populate the middle-column intent session list.
  client?.send({ type: 'list_intent_sessions', projectPath: path })
}

// Enter the discussion view for a project: fetch its discussion list and reset
// the right pane (no discussion opened until the user clicks one). Read path.
function openDiscussions(path: string) {
  activeTab.value = 'discussion'
  discussionsProject.value = path
  activeDiscussionId.value = null
  activeDiscussion.value = null
  discussionMessages.value = []
  discussionMaxSeq.value = 0
  discussionInput.value = ''
  persistViewMode()
  client?.send({ type: 'list_discussions', projectPath: path })
}

// Click a discussion in the list: pull its detail (discussion + full history).
function openDiscussion(discussionId: string) {
  if (discussionId === activeDiscussionId.value) return
  activeDiscussionId.value = discussionId
  discussionInput.value = ''
  // Reset any stale dispatch (in-flight/failed) status for the freshly-opened
  // discussion — it loads a clean transcript and re-populates from live events.
  if (discussionDispatch.value[discussionId]) {
    const d = { ...discussionDispatch.value }
    delete d[discussionId]
    discussionDispatch.value = d
  }
  persistViewMode()
  client?.send({ type: 'open_discussion', discussionId })
}

// "+" form submit in the discussion list: create a discussion. The server
// persists a draft and immediately replies with `discussion_detail` (so the right
// pane opens the new discussion without a click), pushes the refreshed list, then
// completes its context via a read-only research agent and — on success —
// auto-starts the orchestration. The title bar reads "Researching…" until then
// and flips to "Running" once the engine starts; no extra client wiring needed.
function createDiscussion(payload: { type: string; goal: string; context: string }) {
  if (!discussionsProject.value) return
  client?.send({
    type: 'create_discussion',
    projectPath: discussionsProject.value,
    discussionType: payload.type,
    goal: payload.goal,
    context: payload.context,
  })
}

// Enter the schedules view for a project: fetch its schedule list and reset the
// right pane (no schedule selected until the user clicks one). Read path.
function openSchedules(path: string) {
  activeTab.value = 'schedules'
  schedulesProject.value = path
  selectedScheduleId.value = null
  persistViewMode()
  client?.send({ type: 'list_schedules', workspacePath: path })
  // Pull settings so the next-run preview uses the configured `timezone` rather
  // than the browser-zone fallback (settings aren't fetched elsewhere on entry).
  client?.send({ type: 'get_settings' })
}

// Click a schedule in the list: switch the right panel to show its detail and
// fetch its execution logs (reply arrives as `schedule_detail`).
function onSelectSchedule(id: string) {
  selectedScheduleId.value = id
  selectedExecutionId.value = null
  client?.send({ type: 'get_schedule_detail', scheduleId: id })
}

// Expand "View session" on an llm-type history item: fetch its transcript once
// (reply arrives as `execution_transcript`). Re-fetch is harmless but avoided —
// ScheduleDetail only emits this when it has no cached transcript yet.
function onLoadExecutionSession(executionId: string) {
  if (!selectedScheduleId.value) return
  client?.send({
    type: 'get_execution_transcript',
    scheduleId: selectedScheduleId.value,
    executionId,
  })
}

// Second-level selection: pick one execution from the selected schedule's log
// list to view in the right-panel tabbed detail. Clears when schedule changes.
function onSelectExecution(id: string) {
  selectedExecutionId.value = id
}

// 列表行的 enable/disable 开关:映射到 update_schedule 的 status(无独立 pause/resume
// 协议消息)。enabled → active(评估),disabled → paused(跳过评估)。
function onToggleScheduleEnabled(id: string, enabled: boolean) {
  updateSchedule(id, { status: enabled ? 'active' : 'paused' })
}

// ---- Schedule create/edit form (write path) ----
// The modal serves both create (target = null) and edit (target = a schedule).
// On save it sends create_schedule / update_schedule; the server then
// broadcasts a fresh `schedules` list, which refreshes the view automatically.
const scheduleFormOpen = ref(false)
const scheduleFormTarget = ref<Schedule | null>(null)

function openScheduleForm(target: Schedule | null) {
  scheduleFormTarget.value = target
  scheduleFormOpen.value = true
}

// Clear cached tool manifest when the form closes so a fresh open refetches.
watch(scheduleFormOpen, (open) => {
  if (!open) {
    scheduleToolManifest.value = {}
    scheduleToolManifestLoading.value = false
    scheduleToolManifestError.value = null
  }
})

function createSchedule(input: CreateScheduleInput) {
  client?.send({ type: 'create_schedule', workspacePath: input.workspacePath, input })
}

function updateSchedule(id: string, input: UpdateScheduleInput) {
  client?.send({ type: 'update_schedule', scheduleId: id, input })
}

function onLoadScheduleToolManifest(vendor: string) {
  if (!schedulesProject.value || !vendor) return
  // Return cached result immediately if we already have it.
  if (scheduleToolManifest.value[vendor]) {
    scheduleToolManifestLoading.value = false
    scheduleToolManifestError.value = null
    return
  }
  scheduleToolManifestLoading.value = true
  scheduleToolManifestError.value = null
  client?.send({
    type: 'get_schedule_tool_manifest',
    vendor: vendor as VendorId,
    workspacePath: schedulesProject.value,
  })
}

// "Start" in the discussion title bar (draft only): kick off the organizer
// engine. Messages then stream in live via `discussion_message`; the status
// flips through the refreshed `discussions` list.
function startDiscussion() {
  const id = activeDiscussionId.value
  if (!id) return
  client?.send({ type: 'start_discussion', discussionId: id })
}

// The open discussion's live run-state ('running' | 'paused' | undefined).
const activeDiscussionRunState = computed<'running' | 'paused' | undefined>(() =>
  activeDiscussionId.value ? discussionRunState.value[activeDiscussionId.value] : undefined,
)

// The open discussion's transient dispatch (in-flight/failed) status, rendered in
// the chat tail. Empty when nothing is dispatched.
const activeDiscussionDispatch = computed<DispatchView>(() => {
  const id = activeDiscussionId.value
  return (id && discussionDispatch.value[id]) || { pending: [], errors: [] }
})

// Whether the open discussion's research run is live (drives the right-pane phase
// and the Start fallback).
const activeResearchLive = computed<boolean>(() =>
  activeDiscussionId.value ? researchState.value[activeDiscussionId.value] === 'running' : false,
)

// Right-pane phase: the live research stream, or the discussion stream.
const activeDiscussionPhase = computed<DiscussionPhase>(() =>
  discussionPhase(activeResearchLive.value),
)

// Manual Start fallback visibility: a draft whose research has ended/died and whose
// orchestration has not started (e.g. research failed and never auto-started).
const showStart = computed<boolean>(() => {
  const d = activeDiscussion.value
  if (!d) return false
  const discussionLive =
    activeDiscussionRunState.value !== undefined ||
    d.status === 'in_progress' ||
    d.status === 'completed'
  return showDiscussionStart(d.status, activeResearchLive.value, discussionLive)
})

// Pause / resume the live orchestration of the open discussion.
function pauseDiscussion() {
  const id = activeDiscussionId.value
  if (id) client?.send({ type: 'pause_discussion', discussionId: id })
}
function resumeDiscussion() {
  const id = activeDiscussionId.value
  if (id) client?.send({ type: 'resume_discussion', discussionId: id })
}

// Submit the discussion composer. While in_progress → human interjection
// (server pauses, injects, resumes); while completed → drive a new round.
function submitDiscussionInput() {
  const id = activeDiscussionId.value
  const text = discussionInput.value.trim()
  const status = activeDiscussion.value?.status
  if (!id || !text || !status) return
  if (status === 'in_progress') {
    client?.send({ type: 'discussion_speak', discussionId: id, text })
  } else if (status === 'completed') {
    client?.send({ type: 'continue_discussion', discussionId: id, text })
  } else {
    return
  }
  discussionInput.value = ''
}

// "Convert to Intent" in a completed discussion's title bar: bridge its
// conclusion into the intent domain. Switch to the Intents tab (the
// reply carries the seeded comm session via `session_selected` plus the list),
// then ask the server to restart a comm session seeded with the conclusion.
function convertDiscussionToIntent() {
  const d = activeDiscussion.value
  if (!d || d.status !== 'completed') return
  intentsProject.value = d.projectPath
  activeTab.value = 'intents'
  persistViewMode()
  client?.send({ type: 'discussion_to_intent', discussionId: d.id })
}

// "+" in the intent title bar: start a brand-new comm session. The server
// resets the prior is_current row, marks the new one current, and replies with a
// session_selected (empty history) — handleMessage clears the dialog accordingly.
function newIntentChat() {
  if (!intentsProject.value) return
  client?.send({ type: 'new_intent_chat', projectPath: intentsProject.value })
}

// "Switch to an intent session": select an existing intent communication session
// by id. The server replies with `session_selected` loading its history.
function selectIntentSession(sessionId: string) {
  if (!intentsProject.value) return
  selectedIntentSessionId.value = sessionId
  client?.send({ type: 'open_intent_chat', projectPath: intentsProject.value, sessionId })
}

// Rename an intent communication session.
function renameIntentSession(sessionId: string, title: string) {
  if (!intentsProject.value) return
  client?.send({
    type: 'rename_intent_session',
    projectPath: intentsProject.value,
    sessionId,
    title,
  })
}

// Delete an intent communication session. The server promotes the next latest
// session as `is_current` (or none if this was the only one).
function deleteIntentSession(sessionId: string) {
  if (!intentsProject.value) return
  client?.send({ type: 'delete_intent_session', projectPath: intentsProject.value, sessionId })
}

function setIntentFilter(status: IntentStatus | null) {
  if (!intentsProject.value) return
  client?.send({
    type: 'list_intents',
    projectPath: intentsProject.value,
    ...(status ? { status } : {}),
  })
}

function refineIntent(intentId: string) {
  if (!intentsProject.value) return
  client?.send({
    type: 'refine_intent',
    projectPath: intentsProject.value,
    intentId,
  })
}

function createPr(intentId: string) {
  if (!intentsProject.value) return
  client?.send({
    type: 'create_pr',
    projectPath: intentsProject.value,
    intentId,
  })
}

function startDevelopment(intentId: string, hasUnfinishedDeps: boolean) {
  if (!intentsProject.value) return
  if (hasUnfinishedDeps && !window.confirm(t('intent.startDev.confirmUnfinishedDeps'))) return
  client?.send({
    type: 'start_development',
    projectPath: intentsProject.value,
    intentId,
  })
}

function openDevSession(sessionId: string) {
  if (!intentsProject.value) return
  enterConsole()
  consoleSession.value = { workspacePath: intentsProject.value, sessionId }
  client?.send({ type: 'select_session', workspacePath: intentsProject.value, sessionId })
}

function setIntentStatus(intentId: string, status: IntentStatus) {
  client?.send({ type: 'update_intent_status', intentId, status })
}

function setIntentAutomate(intentId: string, automateOn: boolean) {
  client?.send({ type: 'set_intent_automate', intentId, automate: automateOn })
}

function updateIntentDeps(intentId: string, deps: { dependsOnId: string; depType: DepType }[]) {
  client?.send({ type: 'update_intent_deps', intentId, deps })
}

function startAutomation() {
  if (!intentsProject.value) return
  client?.send({ type: 'start_automation', projectPath: intentsProject.value })
}

function stopAutomation() {
  if (!intentsProject.value) return
  client?.send({ type: 'stop_automation', projectPath: intentsProject.value })
}

function deleteSession(path: string, sessionId: string) {
  // Drop the console pointer if it referenced the deleted session, so the next
  // console entry falls back to the list's first session (or empty) instead of
  // re-selecting a gone session.
  if (consoleSession.value?.sessionId === sessionId) consoleSession.value = null
  client?.send({ type: 'delete_session', workspacePath: path, sessionId })
}

function renameSession(path: string, sessionId: string, title: string) {
  client?.send({ type: 'rename_session', workspacePath: path, sessionId, title })
}

// ---- Chat actions ----
function onSubmit(text: string) {
  if (!client || !hasActiveSession.value) return
  client.send({ type: 'user_prompt', text })
  // Optimistic lock; the server confirms via `session_status`. The prompt bubble
  // arrives as a `user_text` echo so every viewer (and switch-back) renders it.
  sessionStatus.value = { ...sessionStatus.value, [activeSession.value as string]: 'running' }
  // Clear any held error and show progress immediately (don't wait for the echo).
  activity.value = { phase: 'thinking' }
  // A new turn is starting — the danger state (if any) is being resolved by this
  // very continue/prompt; drop the flag so the 「continue」 control disappears.
  clearSideEffectPending(activeSession.value as string)
}

// Manual continue from the side-effect danger state (AS-R19): resume the same
// session by sending an ordinary prompt — the next turn `resume`s the SDK session
// with full context. A fixed "continue" nudge (locale-independent: it's a prompt
// to Claude, not UI copy) is enough; the backend reuses the same session.
function onContinue() {
  onSubmit('continue')
}

function stopRun() {
  client?.send({ type: 'stop_run' })
}

// Re-sync the viewed session's status/history (re-select it). Useful when a
// status looks stale; it resyncs the view, it can't revive a wedged SDK run.
function refreshStatus() {
  if (!activeWorkspace.value || !activeSession.value) return
  client?.send({
    type: 'select_session',
    workspacePath: activeWorkspace.value,
    sessionId: activeSession.value,
  })
}

function setMode(next: ModeToken) {
  if (!client || next === mode.value || !hasActiveSession.value) return
  // Optimistic; server echoes a `mode_changed` that confirms it.
  mode.value = next
  client.send({ type: 'set_mode', mode: next })
}

function setCodexPolicy(policy: CodexPolicy) {
  if (!client || !hasActiveSession.value) return
  // Optimistic; server echoes a `mode_changed` with codexPolicy that confirms it.
  codexPolicy.value = policy
  client.send({ type: 'set_mode', mode: policy })
}

// Re-target the viewed session's agent to another same-vendor one (ADR-0015). The
// server rewrites the fact and replies `session_agent_changed`; the next turn
// resumes with it. No optimistic update — we wait for the reply so a (defensive)
// cross-vendor rejection leaves the switcher untouched.
function onSetSessionAgent(agentId: string) {
  if (!client || !activeSession.value) return
  client.send({ type: 'set_session_agent', sessionId: activeSession.value, agentId })
}

function respond(m: PermissionMsg, decision: 'allow' | 'deny') {
  if (!client || m.decision) return
  client.send({ type: 'permission_response', requestId: m.requestId, decision })
  m.decision = decision
}

function submitAsk(m: PermissionMsg, answers: Record<string, string>) {
  if (!client || m.decision) return
  client.send({ type: 'permission_response', requestId: m.requestId, decision: 'allow', answers })
  m.decision = 'allow'
}

// WorkCenter event actions (WaitUserInvolveEvent → permission_response, no m.decision gating).
function respondWorkcenter(event: WaitUserInvolveEvent, decision: 'allow' | 'deny') {
  if (!client || !event.requestId) return
  client.send({ type: 'permission_response', requestId: event.requestId, decision })
  // Mark it done locally so the badge drops immediately.
  event.status = 'done'
}
function submitAskWorkcenter(event: WaitUserInvolveEvent, answers: Record<string, string>) {
  if (!client || !event.requestId) return
  client.send({
    type: 'permission_response',
    requestId: event.requestId,
    decision: 'allow',
    answers,
  })
  event.status = 'done'
}

// Jump from a WorkCenter event to its source tab + item.

function jumpToSource(event: WaitUserInvolveEvent) {
  const path = event.projectPath || currentWorkspace.value
  if (!path || !client) return
  switch (event.source) {
    case 'session':
      enterConsole()
      if (event.sourceId)
        client.send({ type: 'select_session', workspacePath: path, sessionId: event.sourceId })
      break
    case 'intent':
      activeTab.value = 'intents'
      intentsProject.value = path
      persistViewMode()
      client.send({ type: 'open_intent_chat', projectPath: path })
      client.send({ type: 'list_intent_sessions', projectPath: path })
      break
    case 'discussion':
      openDiscussions(path)
      if (event.sourceId) openDiscussion(event.sourceId)
      break
    case 'schedule':
      openSchedules(path)
      if (event.sourceId) onSelectSchedule(event.sourceId)
      break
  }
}

function listCommands() {
  client?.send({ type: 'list_commands' })
}

// ---- Skill-load approval (mount layer 2/3) ----

function approveSkillLoad(requestId: string) {
  client?.send({ type: 'skill_load_approval_resolve', requestId, decision: 'approve' })
  skillApprovalRequest.value = null
}

function cancelSkillLoad(requestId: string) {
  client?.send({ type: 'skill_load_approval_resolve', requestId, decision: 'cancel' })
  skillApprovalRequest.value = null
}

function dismissSkillApproval() {
  // The `.gitignore` gate blocks the first external-skill mount; dismissing the
  // modal without deciding would leave the backend hanging. We do NOT auto-cancel
  // here because the user may switch away and come back. The modal stays open until
  // a decision is made.
}
</script>

<template>
  <!-- Login gate (ADR-0023): when the server says this connection is
       unauthenticated, the gate replaces the whole app. The toast lives outside
       the gate (at root) so a "session expired" notice shows over it too. -->
  <Login v-if="authStatus === 'login-required'" />
  <template v-else>
    <AppHeader
      :workspaces="workspaces"
      :current-workspace="currentWorkspace"
      :status="status"
      :tabs="HEADER_TABS"
      :active-tab="activeTab"
      :tabs-enabled="currentWorkspace !== null"
      :view-mode="viewMode"
      :show-logout="authStatus === 'authenticated'"
      @select-tab="onSelectTab"
      @update:view-mode="setViewMode"
      @open-settings="openSettings"
      @open-workspace-setting="openWorkspaceSetting"
      @add-workspace="addWorkspace"
      @select-workspace="selectWorkspace"
      @remove-workspace="removeWorkspace"
      @logout="auth.logout"
    />

    <div class="body">
      <template v-if="viewMode === 'workspace'">
        <Works
          v-if="activeTab === 'console'"
          ref="composer"
          :current-workspace="currentWorkspace"
          :sessions="currentSessions"
          :session-status="sessionStatus"
          :active-workspace="activeWorkspace"
          :active-session="activeSession"
          :active-title="activeTitle"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          :vendor-session-caps="sessionCapabilities ?? undefined"
          :opencode-status="opencodeStatus"
          :has-active-session="hasActiveSession"
          :mode="mode"
          :mode-options="modeOptions"
          :codex-policy="codexPolicy"
          :messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          @create-session="openNewSession"
          @refresh-sessions="() => refreshSessions(currentWorkspace)"
          @select-session="selectSession"
          @delete-session="deleteSession"
          @rename-session="renameSession"
          @set-mode="setMode"
          @set-codex-policy="setCodexPolicy"
          @set-session-agent="onSetSessionAgent"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @submit="onSubmit"
          @enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
        />

        <Intents
          v-else-if="activeTab === 'intents' && intentsProject"
          ref="composer"
          :project="intentsProject"
          :intents="currentIntents"
          :automation="currentAutomation"
          :intent-sessions="currentIntentSessions"
          :selected-intent-session-id="selectedIntentSessionId"
          :intent-session-run-states="intentSessionRunStates"
          :active-title="activeTitle"
          :has-active-session="hasActiveSession"
          :messages="messages"
          :actionable-permission-id="actionablePermId"
          :task-model="taskModel"
          :has-task-store="taskStoreAvailable"
          :running="running"
          :team-active="activeIsTeam"
          :connection="status"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="currentQueue"
          :available-commands="availableCommands"
          :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
          :vendor="activeVendor"
          :agent-switch="activeAgentSwitch"
          @filter="setIntentFilter"
          @refine="refineIntent"
          @start-dev="startDevelopment"
          @open-dev="openDevSession"
          @set-status="setIntentStatus"
          @set-automate="setIntentAutomate"
          @update-deps="updateIntentDeps"
          @create-pr="createPr"
          @start-automation="startAutomation"
          @stop-automation="stopAutomation"
          @new-intent="newIntentChat"
          @select-intent-session="selectIntentSession"
          @new-intent-session="newIntentChat"
          @rename-intent-session="renameIntentSession"
          @delete-intent-session="deleteIntentSession"
          @set-session-agent="onSetSessionAgent"
          @respond="respond"
          @submit-ask="submitAsk"
          @refresh="refreshStatus"
          @edit-queued="onEditQueued"
          @delete-queued="onDeleteQueued"
          @submit="onSubmit"
          @enqueue="onEnqueue"
          @stop="stopRun"
          @continue="onContinue"
          @list-commands="listCommands"
        />

        <Discussions
          v-else-if="activeTab === 'discussion' && discussionsProject"
          :discussions="currentDiscussions"
          :active-id="activeDiscussionId"
          :run-state="discussionRunState"
          :active-discussion="activeDiscussion"
          :active-run-state="activeDiscussionRunState"
          :messages="discussionMessages"
          :research-messages="researchMessages"
          :phase="activeDiscussionPhase"
          :show-start="showStart"
          :dispatch="activeDiscussionDispatch"
          :input="discussionInput"
          @open="openDiscussion"
          @create="createDiscussion"
          @start="startDiscussion"
          @pause="pauseDiscussion"
          @resume="resumeDiscussion"
          @convert="convertDiscussionToIntent"
          @update:input="discussionInput = $event"
          @submit-input="submitDiscussionInput"
        />

        <Schedules
          v-else-if="activeTab === 'schedules' && schedulesProject"
          :schedules="currentSchedules"
          :active-id="selectedScheduleId"
          :schedule="selectedSchedule"
          :logs="selectedScheduleLogs"
          :transcripts="executionTranscripts"
          :form-open="scheduleFormOpen"
          :form-target="scheduleFormTarget"
          :workspace-path="schedulesProject ?? ''"
          :timezone="scheduleTimezone"
          :execution-id="selectedExecutionId"
          :execution="selectedExecution"
          :tool-manifest="scheduleToolManifest"
          :tool-manifest-loading="scheduleToolManifestLoading"
          :tool-manifest-error="scheduleToolManifestError"
          :host-status="hostStatus"
          @select="onSelectSchedule"
          @open-form="openScheduleForm"
          @toggle-enabled="onToggleScheduleEnabled"
          @load-session="onLoadExecutionSession"
          @select-execution="onSelectExecution"
          @close-form="scheduleFormOpen = false"
          @create="createSchedule"
          @update="updateSchedule"
          @load-tool-manifest="onLoadScheduleToolManifest"
        />
      </template>

      <WorkCenter
        v-else
        :events="workcenterEvents"
        :current-workspace="currentWorkspace"
        @respond="respondWorkcenter"
        @submit-ask="submitAskWorkcenter"
        @jump-to-source="jumpToSource"
      />
    </div>

    <NewSessionModal
      :open="newSessionOpen"
      :agents="serverSettings?.agents ?? []"
      :default-agent-id="serverSettings?.defaultAgentId ?? null"
      :host-status="hostStatus"
      @confirm="confirmNewSession"
      @close="newSessionOpen = false"
      @goto-settings="openSettingsFromPicker"
    />

    <SystemSettingsPage
      :open="settingsOpen"
      :settings="serverSettings"
      :host-status="hostStatus"
      :binding-stats="bindingStats"
      @close="settingsOpen = false"
      @save="saveSettings"
      @set-ui-lang="setLocale"
    />

    <WorkspaceSettingPage
      :open="workspaceSettingOpen"
      :workspace-setting="currentWorkspaceSetting"
      :detected-main-branch="detectedMainBranch"
      :current-workspace="currentWorkspace"
      :vendor-modes="vendorModes"
      :system-sandboxes="serverSettings?.sandboxes ?? []"
      @close="workspaceSettingOpen = false"
      @save="saveWorkspaceSetting"
    />

    <SkillApprovalModal
      :open="skillApprovalRequest !== null"
      :approval="skillApprovalRequest"
      @approve="approveSkillLoad"
      @cancel="cancelSkillLoad"
      @close="dismissSkillApproval"
    />
  </template>

  <div v-if="toast" class="toast" role="status">{{ toast }}</div>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  max-width: 90vw;
  padding: 10px 16px;
  border-radius: 8px;
  background: #b00020;
  color: #fff;
  font-size: 13px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
</style>
