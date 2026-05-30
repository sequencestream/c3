<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { createWsClient } from './lib/ws'
import AppHeader from './components/AppHeader.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import ChatMessages from './components/ChatMessages.vue'
import MessageInput from './components/MessageInput.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import type { ChatBody, ChatMsg, PermissionMsg } from './lib/chat-types'
import type {
  PermissionMode,
  ServerToClient,
  SessionInfo,
  SessionRunStatus,
  SessionStatus,
  SlashCommandInfo,
  SystemSettings,
  TranscriptItem,
  WorkspaceInfo,
} from '@ccc/shared/protocol'

const messages = ref<ChatMsg[]>([])
const status = ref<'connecting' | 'open' | 'closed'>('connecting')
// Live run status per session (sidebar badges + input lock for the viewed one).
// Source of truth: server `ready.statuses` + `session_status` broadcasts.
const sessionStatus = ref<Record<string, SessionStatus>>({})
const mode = ref<PermissionMode>('default')
const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']
const modeOptions = MODES.map((m) => ({ value: m, label: m }))
let nextId = 1

// Sidebar / session state
const workspaces = ref<WorkspaceInfo[]>([])
const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
const expandedWorkspaces = ref<Set<string>>(new Set())
const activeWorkspace = ref<string | null>(null)
const activeSession = ref<string | null>(null)
const activeTitle = ref<string>('')

const activeWorkspaceName = computed(
  () => workspaces.value.find((w) => w.path === activeWorkspace.value)?.name ?? '',
)
const hasActiveSession = computed(() => activeSession.value !== null)

// Status of one session (idle when unknown).
function statusOf(sessionId: string): SessionStatus {
  return sessionStatus.value[sessionId] ?? 'idle'
}

// The viewed session is "running" (input locked) whenever it isn't idle —
// covers both an executing turn and one blocked awaiting a permission decision.
const running = computed(
  () => hasActiveSession.value && statusOf(activeSession.value as string) !== 'idle',
)

// Available commands/skills for the active session's cwd (fetched lazily on the
// first `/`). Cleared on session switch so the next `/` refetches for the new cwd.
const availableCommands = ref<SlashCommandInfo[]>([])

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

let client: ReturnType<typeof createWsClient> | null = null

onMounted(() => {
  client = createWsClient({
    onMessage: handleMessage,
    onStatus: (s) => (status.value = s),
    // After a reconnect the server has a fresh per-connection view (`viewing`
    // reset). Re-select the active session so its history + live stream replay
    // and this connection re-attaches as a viewer.
    onReopen: () => {
      if (activeWorkspace.value && activeSession.value) {
        client?.send({
          type: 'select_session',
          workspacePath: activeWorkspace.value,
          sessionId: activeSession.value,
        })
      }
    },
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
  }
}

function handleMessage(msg: ServerToClient) {
  switch (msg.type) {
    case 'ready':
      workspaces.value = msg.workspaces
      applyStatuses(msg.statuses)
      // Auto-expand the most-recent workspace for an immediate session list.
      if (msg.workspaces.length > 0) toggleWorkspace(msg.workspaces[0].path, true)
      break
    case 'workspaces':
      workspaces.value = msg.workspaces
      break
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
      messages.value = []
      nextId = 1
      // Commands are per-cwd; drop the old set so the next `/` refetches.
      availableCommands.value = []
      // History (on-disk baseline) renders first; the live buffer tail, if any,
      // follows as normal stream events (user_text/assistant_text/…). `running`
      // is derived from sessionStatus, kept current by session_status broadcasts.
      for (const item of msg.history) add(transcriptToChat(item))
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
      break
    case 'user_text':
      add({ kind: 'user', text: msg.text })
      break
    case 'assistant_text':
      add({ kind: 'assistant', text: msg.text })
      break
    case 'tool_use':
      add({ kind: 'tool-use', toolUseId: msg.toolUseId, toolName: msg.toolName, input: msg.input })
      break
    case 'tool_result':
      add({
        kind: 'tool-result',
        toolUseId: msg.toolUseId,
        content: msg.content,
        isError: msg.isError,
      })
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
      break
    case 'consensus_auto':
      add({
        kind: 'consensus',
        toolName: msg.toolName,
        input: msg.input,
        outcome: msg.outcome,
      })
      break
    case 'turn_end':
      // A turn finished — the session stays active for the next prompt. The
      // input unlocks via sessionStatus (server broadcasts idle). Only surface a
      // line on error; a normal completion just frees the input.
      if (msg.reason === 'error') {
        add({ kind: 'system', text: `— error: ${msg.error ?? 'unknown'} —` })
      }
      break
    case 'error':
      add({ kind: 'system', text: `— ${msg.message} —` })
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
}

function sessionTitleById(id: string): string {
  for (const list of Object.values(sessionsByWorkspace.value)) {
    const s = list.find((x) => x.sessionId === id)
    if (s) return s.title
  }
  return 'A background session'
}

// Browser notification for a background session needing approval. Lazily asks
// for permission the first time (no-op if the user has denied notifications).
function notifyAwaitingPermission(id: string) {
  if (typeof Notification === 'undefined') return
  const show = () =>
    new Notification('c3 — permission needed', {
      body: `${sessionTitleById(id)} is waiting for your approval.`,
    })
  if (Notification.permission === 'granted') show()
  else if (Notification.permission !== 'denied')
    Notification.requestPermission().then((p) => {
      if (p === 'granted') show()
    })
}

// ---- Sidebar actions ----
function toggleWorkspace(path: string, forceOpen = false) {
  const next = new Set(expandedWorkspaces.value)
  const willOpen = forceOpen || !next.has(path)
  if (willOpen) {
    next.add(path)
    if (!sessionsByWorkspace.value[path])
      client?.send({ type: 'list_sessions', workspacePath: path })
  } else {
    next.delete(path)
  }
  expandedWorkspaces.value = next
}

function addWorkspace(path: string) {
  client?.send({ type: 'add_workspace', path })
}

function removeWorkspace(path: string) {
  client?.send({ type: 'remove_workspace', path })
}

function createSession(path: string) {
  client?.send({ type: 'create_session', workspacePath: path })
}

function selectSession(path: string, sessionId: string) {
  if (sessionId === activeSession.value) return
  client?.send({ type: 'select_session', workspacePath: path, sessionId })
}

function deleteSession(path: string, sessionId: string) {
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
}

function stopRun() {
  client?.send({ type: 'stop_run' })
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
    :has-active-session="hasActiveSession"
    :active-workspace-name="activeWorkspaceName"
    :active-title="activeTitle"
    :mode="mode"
    :mode-options="modeOptions"
    :status="status"
    @set-mode="setMode"
    @open-settings="openSettings"
  />

  <div class="body">
    <SessionSidebar
      :workspaces="workspaces"
      :sessions-by-workspace="sessionsByWorkspace"
      :session-status="sessionStatus"
      :expanded-workspaces="expandedWorkspaces"
      :active-workspace="activeWorkspace"
      :active-session="activeSession"
      :active-title="activeTitle"
      @toggle-workspace="toggleWorkspace"
      @add-workspace="addWorkspace"
      @remove-workspace="removeWorkspace"
      @create-session="createSession"
      @select-session="selectSession"
      @delete-session="deleteSession"
      @rename-session="renameSession"
    />

    <div class="content">
      <ChatMessages
        :messages="messages"
        :has-active-session="hasActiveSession"
        @respond="respond"
        @submit-ask="submitAsk"
      />
      <MessageInput
        :running="running"
        :has-active-session="hasActiveSession"
        :available-commands="availableCommands"
        @submit="onSubmit"
        @stop="stopRun"
        @list-commands="listCommands"
      />
    </div>
  </div>

  <SettingsPanel
    :open="settingsOpen"
    :settings="serverSettings"
    @close="settingsOpen = false"
    @save="saveSettings"
  />
</template>
