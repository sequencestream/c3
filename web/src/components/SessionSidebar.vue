<script setup lang="ts">
/*
 * SessionSidebar.vue — 左侧工作区 / 会话列表。
 *
 * 列表数据与展开态由 App 提供；分页（每工作区可见条数）是侧栏自身的 UI 状态。
 * 增删改等动作经事件上抛（含 prompt/confirm 交互），由 App 统一发往服务端。
 */
import { ref } from 'vue'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { SessionInfo, SessionStatus, WorkspaceInfo } from '@ccc/shared/protocol'

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  sessionsByWorkspace: Record<string, SessionInfo[]>
  sessionStatus: Record<string, SessionStatus>
  expandedWorkspaces: Set<string>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
}>()

const emit = defineEmits<{
  'toggle-workspace': [path: string]
  'add-workspace': [path: string]
  'remove-workspace': [path: string]
  'create-session': [path: string]
  'select-session': [path: string, sessionId: string]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
}>()

// How many sessions are visible per workspace; grows by SESSION_PAGE on demand.
const SESSION_PAGE = 10
const sessionLimitByWorkspace = ref<Record<string, number>>({})

// Status of one session (idle when unknown). Drives sidebar badges.
function statusOf(sessionId: string): SessionStatus {
  return props.sessionStatus[sessionId] ?? 'idle'
}

function isPending(id: string | null): boolean {
  return !!id && id.startsWith(PENDING_SESSION_PREFIX)
}

function sessionsOf(path: string): SessionInfo[] {
  return props.sessionsByWorkspace[path] ?? []
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

function addWorkspace() {
  const path = window.prompt('Workspace directory (absolute path):')?.trim()
  if (path) emit('add-workspace', path)
}

function removeWorkspace(path: string) {
  if (window.confirm(`Remove workspace from sidebar?\n${path}\n\n(Sessions on disk are kept.)`))
    emit('remove-workspace', path)
}

function deleteSession(path: string, sessionId: string) {
  if (window.confirm('Delete this session and its transcript? This cannot be undone.'))
    emit('delete-session', path, sessionId)
}

function renameSession(path: string, sessionId: string, current: string) {
  const title = window.prompt('Rename session:', current)?.trim()
  if (title) emit('rename-session', path, sessionId, title)
}
</script>

<template>
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
          <button class="ws-toggle" @click="emit('toggle-workspace', w.path)">
            <span class="caret">{{ expandedWorkspaces.has(w.path) ? '▾' : '▸' }}</span>
            <span class="ws-name" :title="w.path">{{ w.name }}</span>
          </button>
          <span class="ws-actions">
            <button class="icon-btn" title="New session" @click="emit('create-session', w.path)">
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
            @click="emit('select-session', w.path, s.sessionId)"
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
</template>
