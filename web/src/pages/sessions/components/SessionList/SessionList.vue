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
  OpencodeServerStatus,
  SessionCapabilities,
  SessionCapability,
  SessionInfo,
  SessionStatus,
  VendorId,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'

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
  /**
   * Live reachability of the supervised OpenCode server (2026-06-07-003). When it is
   * `temporarily-unavailable` the list shows an offline/reconnecting warning so a cold
   * server reads as honest degrade, not a broken list. Absent / `none` ⇒ no warning.
   */
  opencodeStatus?: OpencodeServerStatus
}>()

// The OpenCode server is registered but currently unreachable (down / starting /
// retrying) — drives the list-head offline warning. `none` (unregistered) shows nothing.
function opencodeOffline(): boolean {
  return props.opencodeStatus?.reachability === 'temporarily-unavailable'
}

const emit = defineEmits<{
  'create-session': [path: string]
  'refresh-sessions': []
  'select-session': [path: string, sessionId: string]
  'delete-session': [path: string, sessionId: string]
  'rename-session': [path: string, sessionId: string, title: string]
  /** Resume an unenumerable session (Codex) by a pasted native id; `vendor` is the hint. */
  'resume-session': [path: string, sessionId: string, vendor: VendorId]
}>()

// Stable vendor order for both the dots and the filter chips.
const VENDOR_ORDER: readonly VendorId[] = ['claude', 'codex', 'opencode']

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

// ---- Vendor filter chips (client-side, default all-shown) ----
// We track the set of *hidden* vendors (not shown): an empty set means "all
// shown", so a vendor appearing for the first time defaults to visible without
// any seeding. The unified timeline is never hard-grouped by vendor — chips only
// filter which vendors take part in the single newest-first stream.
const hiddenVendors = ref<Set<VendorId>>(new Set())

// The vendors actually present in this workspace's list, in stable order — the
// chips to render. Hidden when fewer than two (nothing to filter between).
function vendorChips(): VendorId[] {
  const seen = new Set<VendorId>(props.sessions.map((s) => s.vendor))
  return VENDOR_ORDER.filter((v) => seen.has(v))
}

function isVendorOn(v: VendorId): boolean {
  return !hiddenVendors.value.has(v)
}

function toggleVendor(v: VendorId): void {
  const next = new Set(hiddenVendors.value)
  if (next.has(v)) next.delete(v)
  else next.add(v)
  hiddenVendors.value = next
}

// The single time-ordered stream after the vendor filter (server already sorts
// newest-first with Codex's missing-time 0 sunk to the bottom).
function filteredSessions(): SessionInfo[] {
  if (hiddenVendors.value.size === 0) return props.sessions
  return props.sessions.filter((s) => !hiddenVendors.value.has(s.vendor))
}

// The localized "title provided by {vendor}" note for the ⓘ marker — titles are
// not normalized across vendors, so each row says whose title it shows.
function titleSource(vendor: VendorId): string {
  return t('session.list.titleSource', { vendor: VENDOR_LABEL[vendor] })
}

// Sessions actually rendered, capped to the current limit.
function visibleSessions(): SessionInfo[] {
  return filteredSessions().slice(0, sessionLimit.value)
}

function hasMoreSessions(): boolean {
  return filteredSessions().length > sessionLimit.value
}

// ---- Codex resume-by-id (honest fallback for an unenumerable vendor) ----
// Codex sessions cannot be listed (no SDK listing API), so the user pastes a
// native session id to resume one the projection has never seen.
const codexResumeId = ref('')

function submitCodexResume(): void {
  const id = codexResumeId.value.trim()
  if (!id || !props.currentWorkspace) return
  emit('resume-session', props.currentWorkspace, id, 'codex')
  codexResumeId.value = ''
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
        <div
          v-if="opencodeOffline()"
          class="opencode-offline"
          role="status"
          data-testid="opencode-offline"
        >
          <span class="opencode-offline-dot"></span>
          {{ t('session.list.opencodeOffline', { vendor: VENDOR_LABEL.opencode }) }}
        </div>
        <div v-if="vendorChips().length > 1" class="vendor-filter" data-testid="vendor-filter">
          <button
            v-for="v in vendorChips()"
            :key="v"
            type="button"
            class="vendor-chip"
            :class="{ off: !isVendorOn(v) }"
            :aria-pressed="isVendorOn(v)"
            :data-testid="`vendor-chip-${v}`"
            @click="toggleVendor(v)"
          >
            <span class="vendor-dot" :style="{ backgroundColor: VENDOR_COLOR[v] }"></span>
            {{ VENDOR_LABEL[v] }}
          </button>
        </div>
        <div v-if="pendingInCurrent()" class="session active pending">
          <span
            v-if="statusOf(activeSession as string) !== 'idle'"
            class="session-status"
            :class="statusOf(activeSession as string)"
            :title="statusOf(activeSession as string)"
          ></span>
          <span class="session-title">{{ activeTitle }}</span>
        </div>
        <p v-if="filteredSessions().length === 0" class="empty-hint sub">
          {{ t('session.list.empty') }}
        </p>
        <div
          v-for="s in visibleSessions()"
          :key="s.sessionId"
          class="session"
          :class="{
            active: s.sessionId === activeSession,
            awaiting: statusOf(s.sessionId) === 'awaiting_permission',
            orphaned: s.state === 'orphaned',
          }"
          :title="s.state === 'orphaned' ? t('session.list.orphaned.tooltip') : undefined"
          @click="
            s.state !== 'orphaned'
              ? emit('select-session', currentWorkspace as string, s.sessionId)
              : undefined
          "
        >
          <span
            class="vendor-dot session-vendor-dot"
            :style="{ backgroundColor: VENDOR_COLOR[s.vendor] }"
            :title="VENDOR_LABEL[s.vendor]"
            data-testid="session-vendor-dot"
          ></span>
          <span
            v-if="statusOf(s.sessionId) !== 'idle'"
            class="session-status"
            :class="statusOf(s.sessionId)"
            :title="statusOf(s.sessionId)"
          ></span>
          <span class="session-title" :title="s.title"
            ><span v-if="s.lastModified > 0" class="session-date">{{
              datePrefix(s.lastModified)
            }}</span
            ><span v-if="s.isToolSession" class="session-tool-badge">{{
              t('session.list.toolBadge.label')
            }}</span
            ><span v-if="s.state === 'stale'" class="session-tool-badge">{{
              t('session.list.stale.label')
            }}</span
            >{{ s.title }}</span
          ><span class="session-title-source" :title="titleSource(s.vendor)">ⓘ</span>
          <span v-if="s.state === 'ghost'" class="session-actions">
            <button
              class="icon-btn"
              :title="t('session.list.ghost.retry')"
              data-testid="session-row-retry"
              @click.stop="emit('select-session', currentWorkspace as string, s.sessionId)"
            >
              ↻
            </button>
          </span>
          <span v-if="s.state !== 'ghost'" class="session-actions">
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
        <!-- Honest fallback for Codex: its sessions can't be enumerated, so the
             user pastes a native id to resume one the list can't show. -->
        <div class="codex-resume" data-testid="codex-resume">
          <p class="codex-resume-note">{{ t('session.list.codexResume.note') }}</p>
          <div class="codex-resume-row">
            <input
              v-model="codexResumeId"
              type="text"
              class="codex-resume-input"
              :placeholder="t('session.list.codexResume.placeholder')"
              data-testid="codex-resume-input"
              @keydown.enter="submitCodexResume"
            />
            <button
              type="button"
              class="icon-btn"
              :title="t('session.list.codexResume.button')"
              :disabled="!codexResumeId.trim()"
              data-testid="codex-resume-submit"
              @click="submitCodexResume"
            >
              ↻
            </button>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>
