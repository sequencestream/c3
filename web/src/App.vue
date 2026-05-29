<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { createWsClient } from './lib/ws'
import type {
  PermissionMode,
  ServerToClient,
  SessionInfo,
  SlashCommandInfo,
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
type TextMsg = Extract<ChatMsg, { kind: 'user' | 'assistant' | 'system' }>

/**
 * A rendered chat block: either a free-standing text message, or a *batch* of
 * consecutive tool messages (tool-use / tool-result / permission) bounded by
 * text output. A batch is collapsed by default and shows a `Name.count` summary.
 */
type Block =
  | { type: 'text'; key: string; msg: TextMsg }
  | {
      type: 'batch'
      key: string
      id: number
      msgs: ChatMsg[]
      summary: string
      hasPending: boolean
    }

const messages = ref<ChatMsg[]>([])
const input = ref('')
const status = ref<'connecting' | 'open' | 'closed'>('connecting')
const running = ref(false)
const mode = ref<PermissionMode>('default')
const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']
const mainEl = ref<HTMLElement | null>(null)
const expanded = ref<Set<number>>(new Set())
const expandedBatches = ref<Set<number>>(new Set())
let nextId = 1

// Sidebar / session state
const workspaces = ref<WorkspaceInfo[]>([])
const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
const expandedWorkspaces = ref<Set<string>>(new Set())
// How many sessions are visible per workspace; grows by SESSION_PAGE on demand.
const SESSION_PAGE = 10
const sessionLimitByWorkspace = ref<Record<string, number>>({})
const activeWorkspace = ref<string | null>(null)
const activeSession = ref<string | null>(null)
const activeTitle = ref<string>('')

const activeWorkspaceName = computed(
  () => workspaces.value.find((w) => w.path === activeWorkspace.value)?.name ?? '',
)
const hasActiveSession = computed(() => activeSession.value !== null)

// ---- Slash-command autocomplete ----
// Available commands/skills for the active session's cwd (fetched lazily on the
// first `/`). Cleared on session switch so the next `/` refetches for the new cwd.
const availableCommands = ref<SlashCommandInfo[]>([])
const inputEl = ref<HTMLTextAreaElement | null>(null)
const slashIndex = ref(0)
const slashDismissed = ref(false)
const slashMenuEl = ref<HTMLElement | null>(null)
const slashItemEls = ref<(HTMLElement | null)[]>([])
function setSlashItemRef(el: Element | { $el: Element } | null, i: number) {
  slashItemEls.value[i] = (el && '$el' in el ? el.$el : el) as HTMLElement | null
}
// Keep the highlighted command vertically centered in the scroll viewport.
watch(slashIndex, (i) => {
  nextTick(() => {
    const menu = slashMenuEl.value
    const item = slashItemEls.value[i]
    if (!menu || !item) return
    menu.scrollTop = item.offsetTop - menu.clientHeight / 2 + item.clientHeight / 2
  })
})

// The filter text when the input is a slash command being typed at the start
// (leading `/`, no whitespace yet). `null` ⇒ not in slash mode (closed menu).
const slashQuery = computed<string | null>(() => {
  const v = input.value
  if (!v.startsWith('/')) return null
  const rest = v.slice(1)
  if (/\s/.test(rest)) return null // a space means args are being typed — close
  return rest
})

const menuCommands = computed<SlashCommandInfo[]>(() => {
  if (slashQuery.value === null || slashDismissed.value) return []
  const q = slashQuery.value.toLowerCase()
  return availableCommands.value.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  )
})
const slashOpen = computed(() => menuCommands.value.length > 0)

watch(input, (v) => {
  slashIndex.value = 0
  if (v.startsWith('/')) {
    if (availableCommands.value.length === 0) client?.send({ type: 'list_commands' })
  } else {
    slashDismissed.value = false
  }
})

function applyCommand(c: SlashCommandInfo) {
  input.value = `/${c.name} `
  slashDismissed.value = true
  nextTick(() => inputEl.value?.focus())
}

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

const TOOL_KINDS = new Set(['tool-use', 'tool-result', 'permission'])

/**
 * Group the flat message list into render blocks: text messages pass through;
 * runs of tool messages between text become one collapsible batch.
 */
const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  let batch: ChatMsg[] = []
  const flush = () => {
    if (batch.length === 0) return
    const msgs = batch
    batch = []
    // `Name.count` per distinct tool, in first-seen order. Count tool-use calls;
    // fall back to permission tool names when a batch has no executed tool-use.
    const counts = new Map<string, number>()
    for (const m of msgs)
      if (m.kind === 'tool-use') counts.set(m.toolName, (counts.get(m.toolName) ?? 0) + 1)
    if (counts.size === 0)
      for (const m of msgs)
        if (m.kind === 'permission') counts.set(m.toolName, (counts.get(m.toolName) ?? 0) + 1)
    const summary = [...counts].map(([name, n]) => `${name}.${n}`).join('  ')
    const hasPending = msgs.some((m) => m.kind === 'permission' && m.decision === null)
    out.push({ type: 'batch', key: `b${msgs[0].id}`, id: msgs[0].id, msgs, summary, hasPending })
  }
  for (const m of messages.value) {
    if (TOOL_KINDS.has(m.kind)) {
      batch.push(m)
    } else {
      flush()
      out.push({ type: 'text', key: `t${m.id}`, msg: m as TextMsg })
    }
  }
  flush()
  return out
})

function isBatchOpen(b: Extract<Block, { type: 'batch' }>): boolean {
  // A pending permission forces the batch open so the prompt can't be missed.
  return expandedBatches.value.has(b.id) || b.hasPending
}

function toggleBatch(id: number): void {
  const next = new Set(expandedBatches.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedBatches.value = next
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
      // Commands are per-cwd; drop the old set so the next `/` refetches.
      availableCommands.value = []
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
    case 'turn_end':
      // A turn finished — the session stays active for the next prompt. Only
      // surface a line on error; a normal completion just frees the input.
      running.value = false
      if (msg.reason === 'error') {
        add({ kind: 'system', text: `— error: ${msg.error ?? 'unknown'} —` })
      }
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

// "MM/DD" prefix from a session's last-modified time, e.g. "05/28".
function datePrefix(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}`
}

// Sessions actually rendered for a workspace, capped to the current limit.
function visibleSessionsOf(path: string): SessionInfo[] {
  const limit = sessionLimitByWorkspace.value[path] ?? SESSION_PAGE
  return sessionsOf(path).slice(0, limit)
}

// Whether there are more sessions to reveal beyond the current limit.
function hasMoreSessions(path: string): boolean {
  const limit = sessionLimitByWorkspace.value[path] ?? SESSION_PAGE
  return sessionsOf(path).length > limit
}

// Reveal the next page of sessions for a workspace.
function showMoreSessions(path: string) {
  const limit = sessionLimitByWorkspace.value[path] ?? SESSION_PAGE
  sessionLimitByWorkspace.value = {
    ...sessionLimitByWorkspace.value,
    [path]: limit + SESSION_PAGE,
  }
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
  // While the slash menu is open it owns navigation/selection keys so they
  // don't fall through to the ⌘/Ctrl+Enter submit path.
  if (slashOpen.value) {
    const n = menuCommands.value.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value + 1) % n
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value - 1 + n) % n
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applyCommand(menuCommands.value[slashIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashDismissed.value = true
      return
    }
  }
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
              v-for="s in visibleSessionsOf(w.path)"
              :key="s.sessionId"
              class="session"
              :class="{ active: s.sessionId === activeSession }"
              @click="selectSession(w.path, s.sessionId)"
            >
              <span class="session-title" :title="s.title"
                ><span class="session-date">{{ datePrefix(s.lastModified) }}</span
                >{{ s.title }}</span
              >
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
            <button
              v-if="hasMoreSessions(w.path)"
              class="session-more"
              title="Show more sessions"
              @click="showMoreSessions(w.path)"
            >
              ▾ more
            </button>
          </div>
        </div>
      </div>
    </aside>

    <div class="content">
      <main ref="mainEl">
        <p v-if="!hasActiveSession" class="empty-main">
          Select a session, or create a new one in a workspace.
        </p>
        <template v-for="b in blocks" :key="b.key">
          <div v-if="b.type === 'text'" class="msg" :class="b.msg.kind">
            {{ b.msg.text }}
          </div>
          <div v-else class="batch" :class="{ open: isBatchOpen(b) }">
            <div class="batch-head" @click="toggleBatch(b.id)">
              <span class="caret">{{ isBatchOpen(b) ? '▾' : '▸' }}</span>
              <span class="batch-summary">{{ b.summary || 'tools' }}</span>
            </div>
            <div v-if="isBatchOpen(b)" class="batch-body">
              <div
                v-for="m in b.msgs"
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
                  <div v-else class="tool-oneline" @click="toggle(m.id)">
                    {{ oneLine(fmt(m.input)) }}
                  </div>
                </template>
                <template v-else-if="m.kind === 'tool-result'">
                  <div class="label tool-label" @click="toggle(m.id)">
                    <span class="caret">{{ isExpanded(m.id) ? '▾' : '▸' }}</span>
                    tool_result {{ m.isError ? '(error)' : '' }}
                  </div>
                  <pre v-if="isExpanded(m.id)" class="tool-body">{{ m.content }}</pre>
                  <div v-else class="tool-oneline" @click="toggle(m.id)">
                    {{ oneLine(m.content) }}
                  </div>
                </template>
                <template v-else-if="m.kind === 'permission'">
                  <div class="label">
                    Allow tool: <code>{{ m.toolName }}</code> ?
                  </div>
                  <pre v-if="isExpanded(m.id)" class="tool-body">{{ fmt(m.input) }}</pre>
                  <div v-else class="tool-oneline" @click="toggle(m.id)">
                    {{ oneLine(fmt(m.input)) }}
                  </div>
                  <div v-if="m.decision === null" class="actions">
                    <button class="deny" @click="respond(m, 'deny')">Deny</button>
                    <button @click="respond(m, 'allow')">Allow</button>
                  </div>
                  <div v-else class="decided">
                    — {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>
      </main>

      <footer>
        <div v-if="slashOpen" ref="slashMenuEl" class="slash-menu">
          <div
            v-for="(c, i) in menuCommands"
            :key="c.name"
            :ref="(el) => setSlashItemRef(el, i)"
            class="slash-item"
            :class="{ active: i === slashIndex }"
            @mousedown.prevent="applyCommand(c)"
            @mouseenter="slashIndex = i"
          >
            <span class="slash-name">/{{ c.name }}</span>
            <span v-if="c.argumentHint" class="slash-hint">{{ c.argumentHint }}</span>
            <span class="slash-desc">{{ c.description }}</span>
          </div>
        </div>
        <textarea
          ref="inputEl"
          v-model="input"
          :placeholder="
            !hasActiveSession
              ? 'Select or create a session to start'
              : running
                ? 'running…'
                : 'Type a prompt — ⌘/Ctrl+Enter to send, / for commands'
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
