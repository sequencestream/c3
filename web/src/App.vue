<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { createWsClient } from './lib/ws'
import type { PermissionMode, ServerToClient } from '@ccc/shared/protocol'

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

function handleMessage(msg: ServerToClient) {
  switch (msg.type) {
    case 'ready':
      mode.value = msg.mode
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
  }
}

function submit() {
  const t = input.value.trim()
  if (!t || !client || running.value) return
  add({ kind: 'user', text: t })
  client.send({ type: 'user_prompt', text: t })
  input.value = ''
  running.value = true
}

function onModeChange(e: Event) {
  const next = (e.target as HTMLSelectElement).value as PermissionMode
  if (!client || next === mode.value) return
  // Optimistic; server echoes a `mode_changed` that confirms it.
  mode.value = next
  client.send({ type: 'set_mode', mode: next })
}

function respond(m: PermissionMsg, decision: 'allow' | 'deny') {
  if (!client || m.decision) return
  client.send({
    type: 'permission_response',
    requestId: m.requestId,
    decision,
  })
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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <header>
    <h1>c3 — Claude Code Center</h1>
    <div class="header-right">
      <label class="mode">
        mode
        <select :value="mode" @change="onModeChange">
          <option v-for="m in MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <span class="status" :class="status === 'open' ? 'ok' : 'err'">
        {{ status }}
      </span>
    </div>
  </header>

  <main ref="mainEl">
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
        <div v-else class="decided">— {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —</div>
      </template>
      <template v-else>
        {{ m.text }}
      </template>
    </div>
  </main>

  <footer>
    <textarea
      v-model="input"
      :placeholder="running ? 'running…' : 'Type a prompt — ⌘/Ctrl+Enter to send'"
      :disabled="running"
      @keydown="onKey"
    />
    <button :disabled="running || !input.trim()" @click="submit">Send</button>
  </footer>
</template>
