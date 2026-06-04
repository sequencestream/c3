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
import Sessions from './pages/sessions/Sessions.vue'
import Requirements from './pages/requirements/Requirements.vue'
import Discussions from './pages/discussions/Discussions.vue'
import Schedules from './pages/schedules/Schedules.vue'
import SystemSettingsPage from './pages/systemsettings/SystemSettings.vue'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  reconcileRunState,
  applyDispatchStatus,
  clearDispatchAgent,
  type DispatchView,
} from './lib/discussion-view'
import { applyTaskTool, emptyTaskModel, isTaskTool, type TaskListModel } from './lib/task-list'
import {
  consoleEntryTarget,
  consoleTabEntryEffects,
  workspaceSwitchEffects,
  type SessionRef,
} from './lib/tab-view'
import type { ChatBody, ChatMsg, PermissionMsg, RunActivity } from './lib/chat-types'
import type {
  AutomationStatus,
  CreateScheduleInput,
  Discussion,
  PermissionMode,
  Requirement,
  Schedule,
  ScheduleExecutionLog,
  UpdateScheduleInput,
  RequirementStatus,
  ServerToClient,
  SessionInfo,
  SessionRunStatus,
  SessionStatus,
  SlashCommandInfo,
  SystemSettings,
  TranscriptItem,
  UiLang,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { applyLocale, setStoredLocale, i18n, useTypedI18n, type Locale } from './i18n'
import { translateUiError } from './i18n/errors'
import { useModeLabel } from './composables/useModeLabel'

const { t } = useTypedI18n()
const modeLabel = useModeLabel()

const messages = ref<ChatMsg[]>([])
const status = ref<'connecting' | 'open' | 'closed'>('connecting')
// Live run status per session (sidebar badges + input lock for the viewed one).
// Source of truth: server `ready.statuses` + `session_status` broadcasts.
const sessionStatus = ref<Record<string, SessionStatus>>({})
const mode = ref<PermissionMode>('default')
const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']
const modeOptions = computed(() => MODES.map((m) => ({ value: m, label: modeLabel(m) })))
let nextId = 1

// Inferred "current task list" of the viewed session (client-only, like RunActivity;
// see lib/task-list.ts). Reset on session_selected, then fed by correlating each task
// tool_use with its tool_result by toolUseId — across both history replay and the live
// stream, so the two paths converge on the same model. `taskToolPending` holds a task
// tool_use's (toolName, input) until its tool_result arrives.
const taskModel = ref<TaskListModel>(emptyTaskModel())
let taskToolPending = new Map<string, { toolName: string; input: unknown }>()

function feedTaskUse(toolName: string, toolUseId: string | undefined, input: unknown) {
  if (!toolUseId || !isTaskTool(toolName)) return
  taskToolPending.set(toolUseId, { toolName, input })
}

function feedTaskResult(toolUseId: string | undefined, content: string, isError: boolean) {
  if (!toolUseId) return
  const pending = taskToolPending.get(toolUseId)
  if (!pending) return
  taskToolPending.delete(toolUseId)
  taskModel.value = applyTaskTool(taskModel.value, pending.toolName, pending.input, {
    content,
    isError,
  })
}

// Sidebar / session state
const workspaces = ref<WorkspaceInfo[]>([])
const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
// The single global "current workspace" the sidebar reflects; decoupled from the
// viewed session's workspace (`activeWorkspace`). Persisted to localStorage.
const currentWorkspace = ref<string | null>(null)
const activeWorkspace = ref<string | null>(null)
const activeSession = ref<string | null>(null)
const activeTitle = ref<string>('')

// The 「会话」(console) tab remembers its OWN last-viewed session, independent of
// the 「需求」tab's comm session — so switching tabs never crosses chat content.
// The viewed state (`activeSession`/`messages`/…) reflects whichever tab is
// active; this pointer lets `switchToConsoleTab` re-bind the console tab's
// session (the server only streams to the currently-viewed session, so we
// re-`select_session` on switch rather than caching a stale `messages`). The
// requirement tab needs no symmetric pointer: its comm session is server-tracked
// (`is_current` per project) and recovered by re-sending `open_requirement_chat`.
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
// The active page container (Sessions / Requirements) exposes `prefill`; this ref
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

// Available commands/skills for the active session's cwd (fetched lazily on the
// first `/`). Cleared on session switch so the next `/` refetches for the new cwd.
const availableCommands = ref<SlashCommandInfo[]>([])

// ---- Top-bar tabs ----
// `activeTab` is the explicit top-bar tab selection that drives which page the
// content area shows. The list is data so a future tab (e.g. 「讨论」) is just
// one more entry here + one branch in the body. The requirement tab's comm
// session IS the viewed session, so it shares the chat column; only the left
// requirement list is extra.
type TabKey = 'console' | 'requirements' | 'discussion' | 'schedules'
const HEADER_TABS = computed<{ key: TabKey; label: string }[]>(() => [
  { key: 'console', label: t('nav.tab.console.label') },
  { key: 'requirements', label: t('nav.tab.requirements.label') },
  { key: 'discussion', label: t('nav.tab.discussion.label') },
  { key: 'schedules', label: t('nav.tab.schedules.label') },
])
const activeTab = ref<TabKey>('console')
const requirementsProject = ref<string | null>(null)
// Per-project requirement lists (the server pushes `requirements`; we ignore
// projects we aren't viewing).
const requirements = ref<Record<string, Requirement[]>>({})

const currentRequirements = computed<Requirement[]>(() =>
  requirementsProject.value ? (requirements.value[requirementsProject.value] ?? []) : [],
)

// Per-project automation-orchestrator status (server pushes `automation_status`).
const automation = ref<Record<string, AutomationStatus>>({})
const currentAutomation = computed<AutomationStatus | null>(() =>
  requirementsProject.value ? (automation.value[requirementsProject.value] ?? null) : null,
)

// ---- Discussion view (read path) ----
// Mirrors the requirement view: the discussion tab shows a project's discussion
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

const VIEW_MODE_KEY = 'c3.viewMode'
const REQ_PROJECT_KEY = 'c3.requirementsProject'
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

// Persist the requirement-view selection so a hard refresh restores it (Vue's
// in-memory state already survives a WS reconnect; this only covers reload).
function persistViewMode() {
  try {
    localStorage.setItem(VIEW_MODE_KEY, activeTab.value)
    if (requirementsProject.value) localStorage.setItem(REQ_PROJECT_KEY, requirementsProject.value)
    if (discussionsProject.value) localStorage.setItem(DISC_PROJECT_KEY, discussionsProject.value)
    if (activeDiscussionId.value) localStorage.setItem(DISC_ID_KEY, activeDiscussionId.value)
    else localStorage.removeItem(DISC_ID_KEY)
    if (schedulesProject.value) localStorage.setItem(SCHED_PROJECT_KEY, schedulesProject.value)
    else localStorage.removeItem(SCHED_PROJECT_KEY)
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// After `ready`, re-enter the requirement view if a hard refresh left us there.
function maybeRestoreRequirements(list: WorkspaceInfo[]) {
  let saved: { mode: string | null; proj: string | null }
  try {
    saved = {
      mode: localStorage.getItem(VIEW_MODE_KEY),
      proj: localStorage.getItem(REQ_PROJECT_KEY),
    }
  } catch {
    return
  }
  if (saved.mode === 'requirements' && saved.proj && list.some((w) => w.path === saved.proj)) {
    activeTab.value = 'requirements'
    requirementsProject.value = saved.proj
    client?.send({ type: 'open_requirement_chat', projectPath: saved.proj })
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

function openSettings() {
  settingsOpen.value = true
  client?.send({ type: 'get_settings' })
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
    // After a reconnect the server has a fresh per-connection view (`viewing`
    // reset). Re-select the active session so its history + live stream replay
    // and this connection re-attaches as a viewer.
    onReopen: () => {
      // In the requirement view, resume the comm session (the server re-binds
      // the project's persisted `is_current` chat); otherwise re-select normally.
      if (activeTab.value === 'requirements' && requirementsProject.value) {
        client?.send({ type: 'open_requirement_chat', projectPath: requirementsProject.value })
      } else if (activeTab.value === 'discussion' && discussionsProject.value) {
        // Re-fetch the list and re-open the viewed discussion (read path, no
        // live session to re-bind — just re-pull the persisted history).
        client?.send({ type: 'list_discussions', projectPath: discussionsProject.value })
        if (activeDiscussionId.value)
          client?.send({ type: 'open_discussion', discussionId: activeDiscussionId.value })
      } else if (activeTab.value === 'schedules' && schedulesProject.value) {
        // Re-fetch the schedule list (read path, no live session).
        client?.send({ type: 'list_schedules', workspacePath: schedulesProject.value })
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

  // Session-layer status heartbeat: periodically pull the authoritative snapshot
  // so the UI reconciles even when the server's event-driven broadcast is dropped.
  const hbTimer = setInterval(() => {
    client?.send({ type: 'request_session_status' })
  }, 15_000)

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
    case 'ready':
      workspaces.value = msg.workspaces
      applyStatuses(msg.statuses)
      // Restore the persisted current workspace (or fall back to most-recent),
      // then load its sessions for the sidebar.
      currentWorkspace.value = resolveCurrentWorkspace(readStoredWorkspace(), msg.workspaces)
      persistCurrentWorkspace()
      ensureSessions(currentWorkspace.value)
      // Restore the requirement / discussion / schedules view if a hard refresh left us in it.
      maybeRestoreRequirements(msg.workspaces)
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
      mode.value = msg.mode
      // Remember this as the console tab's own session ONLY when the selection
      // originated on the console tab. Comm-session selections (open/new/refine
      // requirement chat) always arrive while the requirement tab is active, so
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
      // Task panel re-infers from scratch on every (re)select so replay matches live.
      taskModel.value = emptyTaskModel()
      taskToolPending = new Map()
      for (const item of msg.history) {
        add(transcriptToChat(item))
        if (item.kind === 'tool_use') feedTaskUse(item.toolName, item.toolUseId, item.input)
        else if (item.kind === 'tool_result')
          feedTaskResult(item.toolUseId, item.content, item.isError)
      }
      break
    case 'session_started':
      if (activeSession.value === msg.clientId) activeSession.value = msg.sessionId
      break
    case 'mode_changed':
      mode.value = msg.mode
      break
    case 'commands':
      availableCommands.value = msg.commands
      break
    case 'settings':
      serverSettings.value = msg.settings
      // Server is the single source of truth for UI language. Reconcile exactly
      // once and only when it disagrees with the live locale, to avoid a
      // save→settings→apply→save loop and any flicker.
      if (msg.settings.uiLang && msg.settings.uiLang !== i18n.global.locale.value) {
        applyLocale(msg.settings.uiLang)
        setStoredLocale(msg.settings.uiLang)
      }
      break
    case 'requirements':
      requirements.value = { ...requirements.value, [msg.projectPath]: msg.items }
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
      add({ kind: 'tool-use', toolUseId: msg.toolUseId, toolName: msg.toolName, input: msg.input })
      feedTaskUse(msg.toolName, msg.toolUseId, msg.input)
      activity.value = { phase: 'tool', toolName: msg.toolName }
      break
    case 'tool_result':
      add({
        kind: 'tool-result',
        toolUseId: msg.toolUseId,
        content: msg.content,
        isError: msg.isError,
      })
      feedTaskResult(msg.toolUseId, msg.content, msg.isError)
      // Tool returned — the model is now deciding the next step (the "stuck
      // after grep" moment the status bar exists to make visible).
      activity.value = { phase: 'thinking' }
      break
    case 'permission_request':
      add({
        kind: 'permission',
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        decision: null,
        consensus: msg.consensus,
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
      break
    case 'all_agents_failed':
      // Every agent in the degradation chain failed. The turn ends with error.
      add({ kind: 'system', text: `— ${msg.message} —` })
      break
    case 'error':
      // Machine-readable code translated locally via the web i18n catalog (spec 003).
      add({ kind: 'system', text: `— ${translateUiError(msg.error)} —` })
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
  if (fx.refreshSessions) refreshSessions(path)
  if (fx.enterConsole) switchToConsoleTab()
}

function addWorkspace(path: string) {
  client?.send({ type: 'add_workspace', path })
}

function removeWorkspace(path: string) {
  client?.send({ type: 'remove_workspace', path })
}

function createSession(path: string) {
  enterConsole()
  client?.send({ type: 'create_session', workspacePath: path })
}

function selectSession(path: string, sessionId: string) {
  enterConsole()
  // Pin the console tab's pointer up front so it stays correct even on the
  // already-viewing early-return (no `session_selected` reply to record it).
  consoleSession.value = { workspacePath: path, sessionId }
  if (sessionId === activeSession.value) return
  client?.send({ type: 'select_session', workspacePath: path, sessionId })
}

// ---- Tab / requirement actions ----
// Top-bar tab click: console switches back to the chat page; requirements opens
// the current workspace's requirement page (no-op without a workspace).
function onSelectTab(key: string) {
  if (key === 'requirements') {
    if (currentWorkspace.value) openRequirements(currentWorkspace.value)
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
// (the chat column may currently show the requirement comm session); clicking
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
// has no session to show, so the requirement comm session never lingers.
function clearViewedSession() {
  activeWorkspace.value = null
  activeSession.value = null
  activeTitle.value = ''
  messages.value = []
  nextId = 1
  availableCommands.value = []
  activity.value = { phase: 'idle' }
  taskModel.value = emptyTaskModel()
  taskToolPending = new Map()
}

function openRequirements(path: string) {
  activeTab.value = 'requirements'
  requirementsProject.value = path
  persistViewMode()
  // The response carries both the comm `session_selected` and the list.
  client?.send({ type: 'open_requirement_chat', projectPath: path })
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
}

// Click a schedule in the list: switch the right panel to show its detail and
// fetch its execution logs (reply arrives as `schedule_detail`).
function onSelectSchedule(id: string) {
  selectedScheduleId.value = id
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

function createSchedule(input: CreateScheduleInput) {
  client?.send({ type: 'create_schedule', workspacePath: input.workspacePath, input })
}

function updateSchedule(id: string, input: UpdateScheduleInput) {
  client?.send({ type: 'update_schedule', scheduleId: id, input })
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

// "Convert to Requirement" in a completed discussion's title bar: bridge its
// conclusion into the requirement domain. Switch to the Requirements tab (the
// reply carries the seeded comm session via `session_selected` plus the list),
// then ask the server to restart a comm session seeded with the conclusion.
function convertDiscussionToRequirement() {
  const d = activeDiscussion.value
  if (!d || d.status !== 'completed') return
  requirementsProject.value = d.projectPath
  activeTab.value = 'requirements'
  persistViewMode()
  client?.send({ type: 'discussion_to_requirement', discussionId: d.id })
}

// "+" in the requirement title bar: start a brand-new comm session. The server
// resets the prior is_current row, marks the new one current, and replies with a
// session_selected (empty history) — handleMessage clears the dialog accordingly.
function newRequirementChat() {
  if (!requirementsProject.value) return
  client?.send({ type: 'new_requirement_chat', projectPath: requirementsProject.value })
}

function setRequirementFilter(status: RequirementStatus | null) {
  if (!requirementsProject.value) return
  client?.send({
    type: 'list_requirements',
    projectPath: requirementsProject.value,
    ...(status ? { status } : {}),
  })
}

function refineRequirement(requirementId: string) {
  if (!requirementsProject.value) return
  client?.send({
    type: 'refine_requirement',
    projectPath: requirementsProject.value,
    requirementId,
  })
}

function startDevelopment(requirementId: string, hasUnfinishedDeps: boolean) {
  if (!requirementsProject.value) return
  if (hasUnfinishedDeps && !window.confirm(t('requirement.startDev.confirmUnfinishedDeps'))) return
  client?.send({
    type: 'start_development',
    projectPath: requirementsProject.value,
    requirementId,
  })
}

function openDevSession(sessionId: string) {
  if (!requirementsProject.value) return
  enterConsole()
  consoleSession.value = { workspacePath: requirementsProject.value, sessionId }
  client?.send({ type: 'select_session', workspacePath: requirementsProject.value, sessionId })
}

function setRequirementStatus(requirementId: string, status: RequirementStatus) {
  client?.send({ type: 'update_requirement_status', requirementId, status })
}

function setRequirementAutomate(requirementId: string, automateOn: boolean) {
  client?.send({ type: 'set_requirement_automate', requirementId, automate: automateOn })
}

function startAutomation() {
  if (!requirementsProject.value) return
  client?.send({ type: 'start_automation', projectPath: requirementsProject.value })
}

function stopAutomation() {
  if (!requirementsProject.value) return
  client?.send({ type: 'stop_automation', projectPath: requirementsProject.value })
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

function setMode(next: PermissionMode) {
  if (!client || next === mode.value || !hasActiveSession.value) return
  // Optimistic; server echoes a `mode_changed` that confirms it.
  mode.value = next
  client.send({ type: 'set_mode', mode: next })
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

function listCommands() {
  client?.send({ type: 'list_commands' })
}
</script>

<template>
  <AppHeader
    :workspaces="workspaces"
    :current-workspace="currentWorkspace"
    :status="status"
    :tabs="HEADER_TABS"
    :active-tab="activeTab"
    :tabs-enabled="currentWorkspace !== null"
    @select-tab="onSelectTab"
    @open-settings="openSettings"
    @add-workspace="addWorkspace"
    @select-workspace="selectWorkspace"
    @remove-workspace="removeWorkspace"
  />

  <div class="body">
    <Sessions
      v-if="activeTab === 'console'"
      ref="composer"
      :current-workspace="currentWorkspace"
      :sessions="currentSessions"
      :session-status="sessionStatus"
      :active-workspace="activeWorkspace"
      :active-session="activeSession"
      :active-title="activeTitle"
      :has-active-session="hasActiveSession"
      :mode="mode"
      :mode-options="modeOptions"
      :messages="messages"
      :actionable-permission-id="actionablePermId"
      :task-model="taskModel"
      :running="running"
      :team-active="activeIsTeam"
      :connection="status"
      :activity="activity"
      :queue="currentQueue"
      :available-commands="availableCommands"
      :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
      @create-session="createSession"
      @refresh-sessions="() => refreshSessions(currentWorkspace)"
      @select-session="selectSession"
      @delete-session="deleteSession"
      @rename-session="renameSession"
      @set-mode="setMode"
      @respond="respond"
      @submit-ask="submitAsk"
      @refresh="refreshStatus"
      @edit-queued="onEditQueued"
      @delete-queued="onDeleteQueued"
      @submit="onSubmit"
      @enqueue="onEnqueue"
      @stop="stopRun"
      @list-commands="listCommands"
    />

    <Requirements
      v-else-if="activeTab === 'requirements' && requirementsProject"
      ref="composer"
      :project="requirementsProject"
      :requirements="currentRequirements"
      :automation="currentAutomation"
      :active-title="activeTitle"
      :has-active-session="hasActiveSession"
      :messages="messages"
      :actionable-permission-id="actionablePermId"
      :task-model="taskModel"
      :running="running"
      :team-active="activeIsTeam"
      :connection="status"
      :activity="activity"
      :queue="currentQueue"
      :available-commands="availableCommands"
      :voice-lang="serverSettings?.voiceLang ?? 'zh-CN'"
      @filter="setRequirementFilter"
      @refine="refineRequirement"
      @start-dev="startDevelopment"
      @open-dev="openDevSession"
      @set-status="setRequirementStatus"
      @set-automate="setRequirementAutomate"
      @start-automation="startAutomation"
      @stop-automation="stopAutomation"
      @new-requirement="newRequirementChat"
      @respond="respond"
      @submit-ask="submitAsk"
      @refresh="refreshStatus"
      @edit-queued="onEditQueued"
      @delete-queued="onDeleteQueued"
      @submit="onSubmit"
      @enqueue="onEnqueue"
      @stop="stopRun"
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
      :dispatch="activeDiscussionDispatch"
      :input="discussionInput"
      @open="openDiscussion"
      @create="createDiscussion"
      @start="startDiscussion"
      @pause="pauseDiscussion"
      @resume="resumeDiscussion"
      @convert="convertDiscussionToRequirement"
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
      @select="onSelectSchedule"
      @open-form="openScheduleForm"
      @toggle-enabled="onToggleScheduleEnabled"
      @load-session="onLoadExecutionSession"
      @close-form="scheduleFormOpen = false"
      @create="createSchedule"
      @update="updateSchedule"
    />
  </div>

  <SystemSettingsPage
    :open="settingsOpen"
    :settings="serverSettings"
    @close="settingsOpen = false"
    @save="saveSettings"
    @set-ui-lang="setLocale"
  />

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
