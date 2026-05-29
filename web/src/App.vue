<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { createWsClient } from './lib/ws'
import type {
  PermissionMode,
  ServerToClient,
  SessionInfo,
  TranscriptItem,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'

type ChatBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-use'; toolName: string; input: unknown }
  | { kind: 'tool-result'; content: string; isError: boolean }
  | {
      kind: 'permission'
      requestId: string
      toolName: string
      input: unknown
      decision: 'allow' | 'deny' | null
    }
  | { kind: 'system'; text: string }
type ChatMsg = ChatBody & { id: number }
type PermissionMsg = Extract<ChatMsg, { kind: 'permission' }>

const messages = ref<ChatMsg[]>([])
const input = ref('')
const status = ref<'connecting' | 'open' | 'closed'>('connecting')
const running = ref(false)
const mode = ref<PermissionMode>('default')
const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']
const mainEl = ref<HTMLElement | null>(null)
const expanded = ref<Set<number>>(new Set())
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

let client: ReturnType<typeof createWsClient> | null = null

onMounted(() => {
  client = createWsClient(handleMessage, (s) => (status.value = s))
})

function add(m: ChatBody) {
  messages.value.push({ ...m, id: nextId++ } as ChatMsg)
  nextTick(() => {
    if (mainEl.value) mainEl.value.scrollTop = mainEl.value.scrollHeight
  })
}

function transcriptToChat(item: TranscriptItem): ChatBody {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.text }
    case 'assistant':
      return { kind: 'assistant', text: item.text }
    case 'tool_use':
      return { kind: 'tool-use', toolName: item.toolName, input: item.input }
    case 'tool_result':
      return { kind: 'tool-result', content: item.content, isError: item.isError }
  }
}

function handleMessage(msg: ServerToClient) {
  switch (msg.type) {
    case 'ready':
      workspaces.value = msg.workspaces
      // Auto-expand the most-recent workspace for an immediate session list.
      if (msg.workspaces.length > 0) toggleWorkspace(msg.workspaces[0].path, true)
      break
    case 'workspaces':
      workspaces.value = msg.workspaces
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
      running.value = false
      messages.value = []
      nextId = 1
      for (const item of msg.history) add(transcriptToChat(item))
      break
    case 'session_started':
      if (activeSession.value === msg.clientId) activeSession.value = msg.sessionId
      break
    case 'mode_changed':
      mode.value = msg.mode
      break
    case 'assistant_text':
      add({ kind: 'assistant', text: msg.text })
      break
    case 'tool_use':
      add({ kind: 'tool-use', toolName: msg.toolName, input: msg.input })
      break
    case 'tool_result':
      add({ kind: 'tool-result', content: msg.content, isError: msg.isError })
      break
    case 'permission_request':
      add({
        kind: 'permission',
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        decision: null,
      })
      break
    case 'session_end':
      running.value = false
      add({
        kind: 'system',
        text:
          msg.reason === 'complete'
            ? '— session complete —'
            : `— error: ${msg.error ?? 'unknown'} —`,
      })
      break
    case 'error':
      add({ kind: 'system', text: `— ${msg.message} —` })
      break
  }
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

function addWorkspace() {
  const path = window.prompt('Workspace directory (absolute path):')?.trim()
  if (path) client?.send({ type: 'add_workspace', path })
}

function removeWorkspace(path: string) {
  if (window.confirm(`Remove workspace from sidebar?\n${path}\n\n(Sessions on disk are kept.)`))
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
  if (window.confirm('Delete this session and its transcript? This cannot be undone.'))
    client?.send({ type: 'delete_session', workspacePath: path, sessionId })
}

function renameSession(path: string, sessionId: string, current: string) {
  const title = window.prompt('Rename session:', current)?.trim()
  if (title) client?.send({ type: 'rename_session', workspacePath: path, sessionId, title })
}

function sessionsOf(path: string): SessionInfo[] {
  return sessionsByWorkspace.value[path] ?? []
}

// ---- Chat actions ----
function submit() {
  const t = input.value.trim()
  if (!t || !client || running.value || !hasActiveSession.value) return
  add({ kind: 'user', text: t })
  client.send({ type: 'user_prompt', text: t })
  input.value = ''
  running.value = true
}

function onModeChange(e: Event) {
  const next = (e.target as HTMLSelectElement).value as PermissionMode
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

function fmt(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// Collapse a multi-line string into a single line (newlines/extra whitespace removed).
// Truncation with "..." is handled by CSS (text-overflow: ellipsis).
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isExpanded(id: number): boolean {
  return expanded.value.has(id)
}

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function isPending(id: string | null): boolean {
  return !!id && id.startsWith(PENDING_SESSION_PREFIX)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <header>
    <h1 v-if="!hasActiveSession">c3 — Claude Code Center</h1>
    <div v-else class="crumbs">
      <span class="crumb-ws">{{ activeWorkspaceName }}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-session">{{ activeTitle }}</span>
    </div>
    <div class="header-right">
      <label class="mode">
        mode
        <select :value="mode" :disabled="!hasActiveSession" @change="onModeChange">
          <option v-for="m in MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <span class="status" :class="status === 'open' ? 'ok' : 'err'">
        {{ status }}
      </span>
    </div>
  </header>

  <div class="body">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="sidebar-title">Workspaces</span>
        <button class="icon-btn" title="Add workspace" @click="addWorkspace">+</button>
      </div>
      <div class="ws-list">
        <p v-if="workspaces.length === 0" class="empty-hint">
          No workspaces yet. Click + to add a directory.
        </p>
        <div v-for="w in workspaces" :key="w.path" class="ws">
          <div class="ws-row">
            <button class="ws-toggle" @click="toggleWorkspace(w.path)">
              <span class="caret">{{ expandedWorkspaces.has(w.path) ? '▾' : '▸' }}</span>
              <span class="ws-name" :title="w.path">{{ w.name }}</span>
            </button>
            <span class="ws-actions">
              <button class="icon-btn" title="New session" @click="createSession(w.path)">
                ＋
              </button>
              <button class="icon-btn" title="Remove workspace" @click="removeWorkspace(w.path)">
                ✕
              </button>
            </span>
          </div>
          <div v-if="expandedWorkspaces.has(w.path)" class="session-list">
            <div
              v-if="isPending(activeSession) && activeWorkspace === w.path"
              class="session active pending"
            >
              <span class="session-title">{{ activeTitle }}</span>
            </div>
            <p v-if="sessionsOf(w.path).length === 0" class="empty-hint sub">No sessions.</p>
            <div
              v-for="s in sessionsOf(w.path)"
              :key="s.sessionId"
              class="session"
              :class="{ active: s.sessionId === activeSession }"
              @click="selectSession(w.path, s.sessionId)"
            >
              <span class="session-title" :title="s.title">{{ s.title }}</span>
              <span class="session-actions">
                <button
                  class="icon-btn"
                  title="Rename"
                  @click.stop="renameSession(w.path, s.sessionId, s.title)"
                >
                  ✎
                </button>
                <button
                  class="icon-btn"
                  title="Delete"
                  @click.stop="deleteSession(w.path, s.sessionId)"
                >
                  🗑
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <div class="content">
      <main ref="mainEl">
        <p v-if="!hasActiveSession" class="empty-main">
          Select a session, or create a new one in a workspace.
        </p>
        <div
          v-for="m in messages"
          :key="m.id"
          class="msg"
          :class="m.kind + (m.kind === 'tool-result' && m.isError ? ' error' : '')"
        >
          <template v-if="m.kind === 'tool-use'">
            <div class="label tool-label" @click="toggle(m.id)">
              <span class="caret">{{ isExpanded(m.id) ? '▾' : '▸' }}</span>
              tool_use · {{ m.toolName }}
            </div>
            <pre v-if="isExpanded(m.id)" class="tool-body">{{ fmt(m.input) }}</pre>
            <div v-else class="tool-oneline" @click="toggle(m.id)">{{ oneLine(fmt(m.input)) }}</div>
          </template>
          <template v-else-if="m.kind === 'tool-result'">
            <div class="label tool-label" @click="toggle(m.id)">
              <span class="caret">{{ isExpanded(m.id) ? '▾' : '▸' }}</span>
              tool_result {{ m.isError ? '(error)' : '' }}
            </div>
            <pre v-if="isExpanded(m.id)" class="tool-body">{{ m.content }}</pre>
            <div v-else class="tool-oneline" @click="toggle(m.id)">{{ oneLine(m.content) }}</div>
          </template>
          <template v-else-if="m.kind === 'permission'">
            <div class="label">
              Allow tool: <code>{{ m.toolName }}</code> ?
            </div>
            <pre v-if="isExpanded(m.id)" class="tool-body">{{ fmt(m.input) }}</pre>
            <div v-else class="tool-oneline" @click="toggle(m.id)">{{ oneLine(fmt(m.input)) }}</div>
            <div v-if="m.decision === null" class="actions">
              <button class="deny" @click="respond(m, 'deny')">Deny</button>
              <button @click="respond(m, 'allow')">Allow</button>
            </div>
            <div v-else class="decided">
              — {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —
            </div>
          </template>
          <template v-else>
            {{ m.text }}
          </template>
        </div>
      </main>

      <footer>
        <textarea
          v-model="input"
          :placeholder="
            !hasActiveSession
              ? 'Select or create a session to start'
              : running
                ? 'running…'
                : 'Type a prompt — ⌘/Ctrl+Enter to send'
          "
          :disabled="running || !hasActiveSession"
          @keydown="onKey"
        />
        <button :disabled="running || !input.trim() || !hasActiveSession" @click="submit">
          Send
        </button>
      </footer>
    </div>
  </div>
</template>
