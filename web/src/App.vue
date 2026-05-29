<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { createWsClient } from './lib/ws'
import type {
  AgentConfig,
  AnyConsensusOutcome,
  AskConsensusOutcome,
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
import { PENDING_SESSION_PREFIX, SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

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
      /** Agents' opinions when consensus ran but was split. */
      consensus?: AnyConsensusOutcome
      /** Per-question answer draft for the AskUserQuestion panel (q index → choice). */
      askDraft?: Record<number, { labels: string[]; custom: string }>
    }
  | {
      kind: 'consensus'
      toolName: string
      input: unknown
      outcome: AnyConsensusOutcome
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
// Live run status per session (sidebar badges + input lock for the viewed one).
// Source of truth: server `ready.statuses` + `session_status` broadcasts.
const sessionStatus = ref<Record<string, SessionStatus>>({})
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

// Status of one session (idle when unknown). Drives sidebar badges.
function statusOf(sessionId: string): SessionStatus {
  return sessionStatus.value[sessionId] ?? 'idle'
}

// The viewed session is "running" (input locked) whenever it isn't idle —
// covers both an executing turn and one blocked awaiting a permission decision.
const running = computed(
  () => hasActiveSession.value && statusOf(activeSession.value as string) !== 'idle',
)

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

// ---- System settings (agent config) ----
const settingsOpen = ref(false)
// A local, editable copy of the server settings; committed on Save.
const settingsDraft = ref<SystemSettings>({
  agents: [],
  defaultAgentId: SYSTEM_AGENT_ID,
  consensus: { enabled: false },
})

function openSettings() {
  settingsOpen.value = true
  client?.send({ type: 'get_settings' })
}

function closeSettings() {
  settingsOpen.value = false
}

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a fresh uuid on normalize).
  const id = `new-${Date.now()}-${settingsDraft.value.agents.length}`
  settingsDraft.value.agents.push({ id, name: '', baseUrl: '', apiKey: '', model: '' })
}

function removeAgent(id: string) {
  if (id === SYSTEM_AGENT_ID) return
  settingsDraft.value.agents = settingsDraft.value.agents.filter((a) => a.id !== id)
  if (settingsDraft.value.defaultAgentId === id)
    settingsDraft.value.defaultAgentId = SYSTEM_AGENT_ID
}

function isSystemAgent(a: AgentConfig): boolean {
  return a.id === SYSTEM_AGENT_ID
}

function saveSettings() {
  client?.send({ type: 'save_settings', settings: settingsDraft.value })
  settingsOpen.value = false
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

const TOOL_KINDS = new Set(['tool-use', 'tool-result', 'permission', 'consensus'])

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
      // Deep-copy so edits to the draft don't mutate the rendered server state.
      settingsDraft.value = {
        agents: msg.settings.agents.map((a) => ({ ...a })),
        defaultAgentId: msg.settings.defaultAgentId,
        consensus: { enabled: msg.settings.consensus?.enabled ?? false },
      }
      break
    case 'user_text':
      add({ kind: 'user', text: msg.text })
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
        consensus: msg.consensus,
        ...(msg.toolName === 'AskUserQuestion'
          ? { askDraft: initAskDraft(msg.input, msg.consensus) }
          : {}),
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
  client.send({ type: 'user_prompt', text: t })
  input.value = ''
  // Optimistic lock; the server confirms via `session_status`. The prompt bubble
  // arrives as a `user_text` echo so every viewer (and switch-back) renders it.
  sessionStatus.value = { ...sessionStatus.value, [activeSession.value as string]: 'running' }
}

function stopRun() {
  client?.send({ type: 'stop_run' })
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

// ---- AskUserQuestion answer panel ----

interface AskOption {
  label: string
  description?: string
}
interface AskQuestionView {
  index: number
  question: string
  header: string
  multiSelect: boolean
  options: AskOption[]
}

/** Read the questions out of an AskUserQuestion tool input (loose, defensive). */
function askQuestionsOf(input: unknown): AskQuestionView[] {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs)) return []
  return qs.map((q, index) => {
    const o = q as Partial<AskQuestionView>
    return {
      index,
      question: typeof o.question === 'string' ? o.question : '',
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: (o as { multiSelect?: boolean }).multiSelect === true,
      options: Array.isArray(o.options)
        ? (o.options as AskOption[]).map((op) => ({
            label: String(op.label ?? ''),
            description: op.description,
          }))
        : [],
    }
  })
}

function isAskConsensus(c: AnyConsensusOutcome | undefined): c is AskConsensusOutcome {
  return !!c && c.kind === 'ask'
}

/** The per-question roll-up for a given question index, when consensus is the ask shape. */
function questionConsensus(c: AnyConsensusOutcome | undefined, qIndex: number) {
  return isAskConsensus(c) ? c.perQuestion.find((p) => p.index === qIndex) : undefined
}

/** Names (+reason) of voters who chose `label` for question `qIndex`. */
function agentsForOption(c: AnyConsensusOutcome | undefined, qIndex: number, label: string) {
  const qc = questionConsensus(c, qIndex)
  if (!qc) return [] as { agentName: string; reason: string }[]
  return qc.answers
    .filter((a) => !a.abstain && a.optionLabels.includes(label))
    .map((a) => ({ agentName: a.agentName, reason: a.reason }))
}

/** Voters who answered question `qIndex` with a custom (non-option) reply. */
function agentsForCustom(c: AnyConsensusOutcome | undefined, qIndex: number) {
  const qc = questionConsensus(c, qIndex)
  if (!qc) return [] as { agentName: string; custom: string; reason: string }[]
  return qc.answers
    .filter((a) => !a.abstain && a.optionLabels.length === 0 && a.custom)
    .map((a) => ({ agentName: a.agentName, custom: a.custom ?? '', reason: a.reason }))
}

/** Build the initial answer draft, pre-filling questions the agents agreed on. */
function initAskDraft(input: unknown, consensus: AnyConsensusOutcome | undefined) {
  const draft: Record<number, { labels: string[]; custom: string }> = {}
  for (const q of askQuestionsOf(input)) {
    const qc = questionConsensus(consensus, q.index)
    const labels =
      qc && qc.unanimous && qc.agreed
        ? qc.agreed
            .split(',')
            .map((s) => s.trim())
            .filter((l) => q.options.some((o) => o.label === l))
        : []
    draft[q.index] = { labels, custom: '' }
  }
  return draft
}

function isOptionChosen(m: PermissionMsg, qIndex: number, label: string): boolean {
  return m.askDraft?.[qIndex]?.labels.includes(label) ?? false
}

function toggleAskOption(m: PermissionMsg, q: AskQuestionView, label: string) {
  if (m.decision || !m.askDraft) return
  const slot = m.askDraft[q.index]
  if (q.multiSelect) {
    const i = slot.labels.indexOf(label)
    if (i >= 0) slot.labels.splice(i, 1)
    else slot.labels.push(label)
  } else {
    slot.labels = slot.labels[0] === label ? [] : [label]
  }
}

/** Every question must have at least one option chosen or a custom reply. */
function askCustomOf(m: PermissionMsg, qIndex: number): string {
  return m.askDraft?.[qIndex]?.custom ?? ''
}

function setAskCustom(m: PermissionMsg, qIndex: number, value: string) {
  if (m.askDraft?.[qIndex]) m.askDraft[qIndex].custom = value
}

function isAskAnswered(m: PermissionMsg): boolean {
  const qs = askQuestionsOf(m.input)
  if (qs.length === 0) return false
  return qs.every((q) => {
    const slot = m.askDraft?.[q.index]
    return !!slot && (slot.labels.length > 0 || slot.custom.trim().length > 0)
  })
}

function submitAsk(m: PermissionMsg) {
  if (!client || m.decision || !isAskAnswered(m)) return
  const answers: Record<string, string> = {}
  for (const q of askQuestionsOf(m.input)) {
    const slot = m.askDraft![q.index]
    answers[q.question] = slot.labels.length > 0 ? slot.labels.join(', ') : slot.custom.trim()
  }
  client.send({ type: 'permission_response', requestId: m.requestId, decision: 'allow', answers })
  m.decision = 'allow'
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
      <button class="icon-btn settings-btn" title="System settings" @click="openSettings">⚙</button>
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
              <span
                v-if="statusOf(activeSession as string) !== 'idle'"
                class="session-status"
                :class="statusOf(activeSession as string)"
                :title="statusOf(activeSession as string)"
              ></span>
              <span class="session-title">{{ activeTitle }}</span>
            </div>
            <p v-if="sessionsOf(w.path).length === 0" class="empty-hint sub">No sessions.</p>
            <div
              v-for="s in visibleSessionsOf(w.path)"
              :key="s.sessionId"
              class="session"
              :class="{
                active: s.sessionId === activeSession,
                awaiting: statusOf(s.sessionId) === 'awaiting_permission',
              }"
              @click="selectSession(w.path, s.sessionId)"
            >
              <span
                v-if="statusOf(s.sessionId) !== 'idle'"
                class="session-status"
                :class="statusOf(s.sessionId)"
                :title="statusOf(s.sessionId)"
              ></span>
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
                  <!-- AskUserQuestion: per-question answer panel -->
                  <template v-if="m.toolName === 'AskUserQuestion'">
                    <div class="label">
                      🙋 回答提问 · <code>AskUserQuestion</code>
                      <span v-if="m.consensus" class="consensus-badge split">多 agent 建议</span>
                    </div>
                    <div v-if="m.consensus" class="consensus-summary ask-summary">
                      🤝 {{ m.consensus.summary }}
                    </div>
                    <div class="ask-panel">
                      <div v-for="q in askQuestionsOf(m.input)" :key="q.index" class="ask-q">
                        <div class="ask-q-head">
                          <span v-if="q.header" class="ask-q-header">{{ q.header }}</span>
                          {{ q.question }}
                        </div>
                        <div class="ask-options">
                          <label
                            v-for="o in q.options"
                            :key="o.label"
                            class="ask-option"
                            :class="{
                              chosen: isOptionChosen(m, q.index, o.label),
                              locked: !!m.decision,
                            }"
                          >
                            <input
                              :type="q.multiSelect ? 'checkbox' : 'radio'"
                              :name="`q-${m.id}-${q.index}`"
                              :checked="isOptionChosen(m, q.index, o.label)"
                              :disabled="!!m.decision"
                              @change="toggleAskOption(m, q, o.label)"
                            />
                            <span class="ask-option-body">
                              <span class="ask-option-label">{{ o.label }}</span>
                              <span v-if="o.description" class="ask-option-desc">{{
                                o.description
                              }}</span>
                            </span>
                            <span class="ask-agents">
                              <span
                                v-for="a in agentsForOption(m.consensus, q.index, o.label)"
                                :key="a.agentName"
                                class="ask-agent-badge"
                                :title="a.reason"
                                >{{ a.agentName }}</span
                              >
                            </span>
                          </label>
                        </div>
                        <div
                          v-for="a in agentsForCustom(m.consensus, q.index)"
                          :key="a.agentName"
                          class="ask-custom-hint"
                          :title="a.reason"
                        >
                          {{ a.agentName }}：{{ a.custom }}
                        </div>
                        <input
                          v-if="m.decision === null"
                          class="ask-custom"
                          type="text"
                          placeholder="自定义回复（覆盖上面的选择）"
                          :value="askCustomOf(m, q.index)"
                          @input="
                            setAskCustom(m, q.index, ($event.target as HTMLInputElement).value)
                          "
                        />
                      </div>
                    </div>
                    <div v-if="m.decision === null" class="actions">
                      <button class="deny" @click="respond(m, 'deny')">Deny</button>
                      <button :disabled="!isAskAnswered(m)" @click="submitAsk(m)">提交答案</button>
                    </div>
                    <div v-else class="decided">
                      — {{ m.decision === 'allow' ? 'answered' : 'denied' }} —
                    </div>
                  </template>

                  <!-- Every other tool: allow / deny -->
                  <template v-else>
                    <div class="label">
                      Allow tool: <code>{{ m.toolName }}</code> ?
                    </div>
                    <pre v-if="isExpanded(m.id)" class="tool-body">{{ fmt(m.input) }}</pre>
                    <div v-else class="tool-oneline" @click="toggle(m.id)">
                      {{ oneLine(fmt(m.input)) }}
                    </div>
                    <div
                      v-if="m.consensus && m.consensus.kind === 'tool'"
                      class="consensus consensus-split"
                    >
                      <div class="consensus-summary">
                        🤝 多 agent 意见分歧：{{ m.consensus.summary }}
                      </div>
                      <ul class="consensus-votes">
                        <li v-for="v in m.consensus.votes" :key="v.agentId">
                          <span class="vote-name">{{ v.agentName }}</span>
                          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
                          <span class="vote-reason">{{ v.reason }}</span>
                        </li>
                      </ul>
                    </div>
                    <div v-if="m.decision === null" class="actions">
                      <button class="deny" @click="respond(m, 'deny')">Deny</button>
                      <button @click="respond(m, 'allow')">Allow</button>
                    </div>
                    <div v-else class="decided">
                      — {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —
                    </div>
                  </template>
                </template>
                <template v-else-if="m.kind === 'consensus'">
                  <!-- AskUserQuestion: per-question auto-answer -->
                  <template v-if="m.outcome.kind === 'ask'">
                    <div class="label">
                      🤝 多 agent 共识 · <code>{{ m.toolName }}</code>
                      <span class="consensus-badge allow">逐题自动作答</span>
                    </div>
                    <div class="consensus">
                      <div class="consensus-summary">{{ m.outcome.summary }}</div>
                      <ul class="consensus-questions">
                        <li v-for="q in m.outcome.perQuestion" :key="q.index">
                          <div class="cq-head">
                            <span v-if="q.header" class="ask-q-header">{{ q.header }}</span>
                            <span class="cq-agreed" :class="{ split: !q.unanimous }">{{
                              q.unanimous ? q.agreed : '（分歧→人工）'
                            }}</span>
                          </div>
                          <div class="cq-votes">
                            <span v-for="a in q.answers" :key="a.agentId" class="cq-vote">
                              <span class="vote-name">{{ a.agentName }}</span>
                              <span class="vote-reason">{{
                                a.abstain ? '弃权' : a.optionLabels.join('/') || a.custom
                              }}</span>
                            </span>
                          </div>
                        </li>
                      </ul>
                    </div>
                  </template>

                  <!-- Every other tool: allow / deny verdict -->
                  <template v-else>
                    <div class="label">
                      🤝 多 agent 共识 ·
                      <code>{{ m.toolName }}</code>
                      <span class="consensus-badge" :class="m.outcome.decision ?? 'split'">{{
                        m.outcome.decision === 'allow'
                          ? '自动允许'
                          : m.outcome.decision === 'deny'
                            ? '自动拒绝'
                            : '分歧'
                      }}</span>
                    </div>
                    <div class="consensus">
                      <div class="consensus-summary">{{ m.outcome.summary }}</div>
                      <ul class="consensus-votes">
                        <li v-for="v in m.outcome.votes" :key="v.agentId">
                          <span class="vote-name">{{ v.agentName }}</span>
                          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
                          <span class="vote-reason">{{ v.reason }}</span>
                        </li>
                      </ul>
                    </div>
                  </template>
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
        <button v-if="running" class="stop-btn" title="Stop the running turn" @click="stopRun">
          Stop
        </button>
        <button v-else :disabled="!input.trim() || !hasActiveSession" @click="submit">Send</button>
      </footer>
    </div>
  </div>

  <div v-if="settingsOpen" class="settings-page">
    <div class="settings-head">
      <h2>System Settings</h2>
      <button class="icon-btn" title="Close" @click="closeSettings">✕</button>
    </div>
    <div class="settings-body">
      <p class="settings-section-title">Agents</p>
      <p class="settings-hint">
        New sessions launch Claude Code with the default agent. The system agent uses no overrides
        (your existing <code>claude</code> login) and cannot be edited or removed.
      </p>
      <div class="agent-table">
        <div class="agent-row agent-row-head">
          <span class="col-default">Default</span>
          <span class="col-name">Name</span>
          <span class="col-url">Base URL</span>
          <span class="col-key">API Key</span>
          <span class="col-model">Model</span>
          <span class="col-actions"></span>
        </div>
        <div v-for="a in settingsDraft.agents" :key="a.id" class="agent-row">
          <label class="col-default">
            <input
              type="radio"
              name="default-agent"
              :value="a.id"
              :checked="settingsDraft.defaultAgentId === a.id"
              @change="settingsDraft.defaultAgentId = a.id"
            />
          </label>
          <input
            v-model="a.name"
            class="agent-field col-name"
            :placeholder="isSystemAgent(a) ? 'System' : 'Agent name'"
            :disabled="isSystemAgent(a)"
          />
          <input
            v-model="a.baseUrl"
            class="agent-field col-url"
            :placeholder="isSystemAgent(a) ? '—' : 'ANTHROPIC_BASE_URL'"
            :disabled="isSystemAgent(a)"
          />
          <input
            v-model="a.apiKey"
            class="agent-field col-key"
            type="password"
            autocomplete="off"
            :placeholder="isSystemAgent(a) ? '—' : 'API key'"
            :disabled="isSystemAgent(a)"
          />
          <input
            v-model="a.model"
            class="agent-field col-model"
            :placeholder="isSystemAgent(a) ? '—' : 'e.g. claude-opus-4-8'"
            :disabled="isSystemAgent(a)"
          />
          <span class="col-actions">
            <button
              v-if="!isSystemAgent(a)"
              class="icon-btn"
              title="Remove agent"
              @click="removeAgent(a.id)"
            >
              🗑
            </button>
            <span v-else class="agent-badge">built-in</span>
          </span>
        </div>
      </div>
      <button class="agent-add" @click="addAgent">+ Add agent</button>

      <p class="settings-section-title">Consensus</p>
      <p class="settings-hint">
        When enabled, every permission prompt is first put to the
        <em>other</em> configured agents. They each judge the tool call from the recent context and
        vote allow/deny with a reason; the session's own agent summarizes. If they all agree it
        auto-resolves, otherwise you decide with their opinions shown. Needs at least one agent
        besides the session's own.
      </p>
      <label v-if="settingsDraft.consensus" class="consensus-toggle">
        <input v-model="settingsDraft.consensus.enabled" type="checkbox" />
        Enable multi-agent consensus voting
      </label>
    </div>
    <div class="settings-foot">
      <button class="ghost" @click="closeSettings">Cancel</button>
      <button @click="saveSettings">Save</button>
    </div>
  </div>
</template>
