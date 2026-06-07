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
import type {
  SessionCapabilities,
  SessionCapability,
  SessionInfo,
  SessionStatus,
  VendorId,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'

const { t, d } = useTypedI18n()

const props = defineProps<{
  currentWorkspace: string | null
  sessions: SessionInfo[]
  sessionStatus: Record<string, SessionStatus>
  activeWorkspace: string | null
  activeSession: string | null
  activeTitle: string
  /**
   * Per-vendor session-lifecycle capability ledger (ADR-0011). Drives row-action
   * gating by capability *state*, not by vendor — see {@link rowAction}. Absent
   * (pre-`settings`) ⇒ optimistic enable, so the list never locks on first paint.
   */
  vendorSessionCaps?: Partial<Record<VendorId, SessionCapabilities>>
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

// 面板展开态:持久化 UI 状态(同 RequirementList 的折叠范式)。展开态把侧栏宽度翻倍,
// 便于阅读较长的会话标题;收缩态回到默认窄宽。跨页面切换后保持原状。
const expanded = usePersistentToggle('c3.sessionListExpanded')

function toggleExpand(): void {
  expanded.value = !expanded.value
}

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

// Localized month/day prefix from a session's last-modified time (e.g. en "05/28").
function datePrefix(ms: number): string {
  return d(ms, 'short')
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
  if (window.confirm(t('session.list.deleteConfirm')))
    emit('delete-session', props.currentWorkspace, sessionId)
}

function renameSession(sessionId: string, current: string) {
  if (!props.currentWorkspace) return
  const title = window.prompt(t('session.list.renamePrompt'), current)?.trim()
  if (title) emit('rename-session', props.currentWorkspace, sessionId, title)
}

/** How a row action renders, derived purely from the vendor's capability state. */
interface RowAction {
  /** Render the button at all (`none` ⇒ the vendor structurally cannot — hide it). */
  visible: boolean
  /** Greyed-out, non-interactive (`temporarily-unavailable`). */
  disabled: boolean
  /** Tooltip text (the action's own label, or the "temporarily unavailable" note). */
  tooltip: string
}

// Capability-state → row-action rendering, the ONE place degradation is decided —
// zero `if (vendor === …)`. A new vendor whose ledger reports `none`/`temporarily-
// unavailable` is degraded correctly here without touching this function.
//   full | partial          → enabled (partial still works, just lossy elsewhere)
//   temporarily-unavailable → visible but disabled, with the unavailable tooltip
//   none                    → hidden (the vendor's SDK has no such operation)
//   undefined (pre-settings)→ optimistic enable (back-compat / first paint)
function rowAction(s: SessionInfo, op: Extract<SessionCapability, 'rename' | 'delete'>): RowAction {
  const label = op === 'rename' ? t('session.row.rename.tooltip') : t('session.row.delete.tooltip')
  const state = props.vendorSessionCaps?.[s.vendor]?.[op]
  if (state === 'none') return { visible: false, disabled: true, tooltip: label }
  if (state === 'temporarily-unavailable')
    return { visible: true, disabled: true, tooltip: t('session.row.unavailable.tooltip') }
  return { visible: true, disabled: false, tooltip: label }
}
</script>

<template>
  <aside class="sidebar" :class="{ expanded }">
    <div class="sidebar-head">
      <div class="sidebar-head-left">
        <button
          type="button"
          class="sidebar-collapse-btn"
          :title="
            expanded
              ? t('session.list.toggle.collapse.tooltip')
              : t('session.list.toggle.expand.tooltip')
          "
          :aria-pressed="expanded"
          data-testid="session-list-toggle"
          @click="toggleExpand"
        >
          {{ expanded ? '⇤' : '⇥' }}
        </button>
        <span class="sidebar-title">{{ t('session.list.title.label') }}</span>
      </div>
      <span v-if="currentWorkspace" class="sidebar-actions">
        <button
          class="icon-btn"
          :title="t('session.list.refresh.tooltip')"
          data-testid="session-list-refresh"
          @click="refreshSessions"
        >
          ⟳
        </button>
        <button
          class="icon-btn"
          :title="t('session.list.new.tooltip')"
          data-testid="session-list-new"
          @click="createSession"
        >
          ＋
        </button>
      </span>
    </div>
    <div class="ws-list">
      <p v-if="!currentWorkspace" class="empty-hint" data-testid="session-list-empty">
        {{ t('session.list.noWorkspace') }}
      </p>
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
        <p v-if="sessions.length === 0" class="empty-hint sub">{{ t('session.list.empty') }}</p>
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
            ><span v-if="s.isToolSession" class="session-tool-badge">{{
              t('session.list.toolBadge.label')
            }}</span
            >{{ s.title }}</span
          >
          <span class="session-actions">
            <button
              v-if="rowAction(s, 'rename').visible"
              class="icon-btn"
              :title="rowAction(s, 'rename').tooltip"
              :disabled="rowAction(s, 'rename').disabled"
              data-testid="session-row-rename"
              @click.stop="renameSession(s.sessionId, s.title)"
            >
              ✎
            </button>
            <button
              v-if="rowAction(s, 'delete').visible"
              class="icon-btn"
              :title="rowAction(s, 'delete').tooltip"
              :disabled="rowAction(s, 'delete').disabled"
              data-testid="session-row-delete"
              @click.stop="deleteSession(s.sessionId)"
            >
              🗑
            </button>
          </span>
        </div>
        <button
          v-if="hasMoreSessions()"
          class="session-more"
          :title="t('session.list.more.tooltip')"
          @click="showMoreSessions"
        >
          {{ t('session.list.more.label') }}
        </button>
      </div>
    </div>
  </aside>
</template>
