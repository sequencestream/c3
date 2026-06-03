<script setup lang="ts">
/*
 * SessionList.vue — 「会话」tab 的左栏:当前工作区的会话列表。
 *
 * 工作区的新增/切换/移除已收敛到顶部的 WorkspaceSwitcher;本组件只呈现 currentWorkspace
 * 的会话列表(只在「会话」tab 渲染,与「需求」tab 的 RequirementList 左栏对称)。会话分页
 * (每次可见条数)是组件自身的 UI 状态;增删改经事件上抛(含 prompt/confirm 交互),
 * 由 App 统一发往服务端。
 */
import { ref } from 'vue'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { SessionInfo, SessionStatus } from '@ccc/shared/protocol'

const props = defineProps<{
  currentWorkspace: string | null
  sessions: SessionInfo[]
  sessionStatus: Record<string, SessionStatus>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
}>()

const emit = defineEmits<{
  'create-session': [path: string]
  'refresh-sessions': []
  'select-session': [path: string, sessionId: string]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
}>()

// How many sessions are visible; grows by SESSION_PAGE on demand.
const SESSION_PAGE = 10
const sessionLimit = ref(SESSION_PAGE)

// Status of one session (idle when unknown). Drives list badges.
function statusOf(sessionId: string): SessionStatus {
  return props.sessionStatus[sessionId] ?? 'idle'
}

function isPending(id: string | null): boolean {
  return !!id && id.startsWith(PENDING_SESSION_PREFIX)
}

// Whether the active (pending) session belongs to the current workspace —
// so its pending row shows in this list (currentWorkspace may differ from the
// viewed session's workspace once they're decoupled).
function pendingInCurrent(): boolean {
  return (
    isPending(props.activeSession) &&
    props.activeWorkspace === props.currentWorkspace &&
    props.currentWorkspace !== null
  )
}

// "MM/DD" prefix from a session's last-modified time, e.g. "05/28".
function datePrefix(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}`
}

// Sessions actually rendered, capped to the current limit.
function visibleSessions(): SessionInfo[] {
  return props.sessions.slice(0, sessionLimit.value)
}

function hasMoreSessions(): boolean {
  return props.sessions.length > sessionLimit.value
}

function showMoreSessions() {
  sessionLimit.value += SESSION_PAGE
}

function createSession() {
  if (props.currentWorkspace) emit('create-session', props.currentWorkspace)
}

function refreshSessions() {
  if (props.currentWorkspace) emit('refresh-sessions')
}

function deleteSession(sessionId: string) {
  if (!props.currentWorkspace) return
  if (window.confirm('Delete this session and its transcript? This cannot be undone.'))
    emit('delete-session', props.currentWorkspace, sessionId)
}

function renameSession(sessionId: string, current: string) {
  if (!props.currentWorkspace) return
  const title = window.prompt('Rename session:', current)?.trim()
  if (title) emit('rename-session', props.currentWorkspace, sessionId, title)
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <span class="sidebar-title">Sessions</span>
      <span v-if="currentWorkspace" class="sidebar-actions">
        <button class="icon-btn" title="Refresh sessions" @click="refreshSessions">⟳</button>
        <button class="icon-btn" title="New session" @click="createSession">＋</button>
      </span>
    </div>
    <div class="ws-list">
      <p v-if="!currentWorkspace" class="empty-hint">No workspace selected.</p>
      <div v-else class="session-list">
        <div v-if="pendingInCurrent()" class="session active pending">
          <span
            v-if="statusOf(activeSession as string) !== 'idle'"
            class="session-status"
            :class="statusOf(activeSession as string)"
            :title="statusOf(activeSession as string)"
          ></span>
          <span class="session-title">{{ activeTitle }}</span>
        </div>
        <p v-if="sessions.length === 0" class="empty-hint sub">No sessions.</p>
        <div
          v-for="s in visibleSessions()"
          :key="s.sessionId"
          class="session"
          :class="{
            active: s.sessionId === activeSession,
            awaiting: statusOf(s.sessionId) === 'awaiting_permission',
          }"
          @click="emit('select-session', currentWorkspace as string, s.sessionId)"
        >
          <span
            v-if="statusOf(s.sessionId) !== 'idle'"
            class="session-status"
            :class="statusOf(s.sessionId)"
            :title="statusOf(s.sessionId)"
          ></span>
          <span class="session-title" :title="s.title"
            ><span class="session-date">{{ datePrefix(s.lastModified) }}</span
            ><span v-if="s.isToolSession" class="session-tool-badge">TOOL</span>{{ s.title }}</span
          >
          <span class="session-actions">
            <button
              class="icon-btn"
              title="Rename"
              @click.stop="renameSession(s.sessionId, s.title)"
            >
              ✎
            </button>
            <button class="icon-btn" title="Delete" @click.stop="deleteSession(s.sessionId)">
              🗑
            </button>
          </span>
        </div>
        <button
          v-if="hasMoreSessions()"
          class="session-more"
          title="Show more sessions"
          @click="showMoreSessions"
        >
          ▾ more
        </button>
      </div>
    </div>
  </aside>
</template>
