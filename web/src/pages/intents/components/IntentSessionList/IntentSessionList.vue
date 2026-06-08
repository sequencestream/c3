<script setup lang="ts">
/*
 * IntentSessionList.vue — 需求页中栏:意图通信会话列表。
 *
 * 展示当前项目的全部 intent comm session(标题 + 时间 + 单一运行态指示)。
 * 点击切换会话(加载历史到右侧聊天列)、「+」新建、行内重命名、删除(二次确认)。
 * 多个会话可同时后台运行,切换不打断其它会话的运行态。
 * 活跃中的会话(running)全部展示;已完成的会话默认展示最近 10 笔,可点加载更多。
 */
import { computed, ref, nextTick } from 'vue'
import type { IntentSessionInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { formatDate } from '../../../../lib/intent-list-view'
import { TONE_ICON } from '../../../../lib/status-indicator'

const PAGE_SIZE = 10
const { t, locale } = useTypedI18n()

const props = defineProps<{
  /** All intent communication sessions for the current project. */
  sessions: IntentSessionInfo[]
  /** The currently-selected (active) session's id. */
  selectedId: string | null
  /** Live run-state per session id (`'running'` present = active run). */
  runStates: Record<string, 'running'>
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  new: []
  rename: [sessionId: string, title: string]
  delete: [sessionId: string]
}>()

// ---- Panel collapse state (persistent) ----
const collapsed = usePersistentToggle('c3.intentSessionListCollapsed')
function togglePanel(): void {
  collapsed.value = !collapsed.value
}

// ---- Inline rename ----
const editingId = ref<string | null>(null)
const renameValue = ref('')

function startRename(session: IntentSessionInfo): void {
  editingId.value = session.sessionId
  renameValue.value = session.title ?? ''
  // Focus the input after Vue renders it
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.int-sess-rename-input')
    el?.focus()
    el?.select()
  })
}

function commitRename(): void {
  const id = editingId.value
  if (!id) return
  const title = renameValue.value.trim()
  if (title) {
    emit('rename', id, title)
  }
  editingId.value = null
  renameValue.value = ''
}

function cancelRename(): void {
  editingId.value = null
  renameValue.value = ''
}

// ---- Delete with confirmation ----
function deleteSession(session: IntentSessionInfo): void {
  if (window.confirm(t('intent.sessionList.deleteConfirm'))) {
    emit('delete', session.sessionId)
  }
}

// ---- Row helpers ----
function displayTitle(session: IntentSessionInfo): string {
  return session.title ?? t('intent.sessionList.placeholder.label')
}

function datePrefix(ms: number): string {
  return formatDate(ms, locale.value, { style: 'short' })
}

// ---- Active vs paginated-completed split ----
// Sessions sorted newest-first.
const sortedSessions = computed<IntentSessionInfo[]>(() =>
  [...props.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
)

// Active sessions: currently running (all shown, no pagination).
const activeSessions = computed<IntentSessionInfo[]>(() =>
  sortedSessions.value.filter((s) => props.runStates[s.sessionId] === 'running'),
)

// Completed sessions: everything not running (paginated).
const completedSessions = computed<IntentSessionInfo[]>(() =>
  sortedSessions.value.filter((s) => props.runStates[s.sessionId] !== 'running'),
)

// Pagination for completed sessions.
const completedPage = ref(1)
const visibleCompleted = computed<IntentSessionInfo[]>(() =>
  completedSessions.value.slice(0, completedPage.value * PAGE_SIZE),
)
const hasMoreCompleted = computed<boolean>(
  () => completedSessions.value.length > completedPage.value * PAGE_SIZE,
)
function loadMoreCompleted(): void {
  completedPage.value += 1
}

// Flattened list rendered in the template: all active + paginated completed.
const visibleSessions = computed<IntentSessionInfo[]>(() => [
  ...activeSessions.value,
  ...visibleCompleted.value,
])
</script>

<template>
  <section class="int-sess-list" :class="{ collapsed }" data-testid="intent-session-list">
    <div class="int-sess-list-head">
      <div class="int-sess-list-head-left">
        <button
          type="button"
          class="int-sess-collapse-btn"
          :title="
            collapsed
              ? t('intent.sessionList.expand.tooltip')
              : t('intent.sessionList.collapse.tooltip')
          "
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ collapsed ? '⇤' : '⇥' }}
        </button>
        <span class="int-sess-list-title">{{ t('intent.sessionList.title.label') }}</span>
      </div>
      <button
        type="button"
        class="int-sess-new-btn"
        :aria-label="t('intent.sessionList.new.tooltip')"
        :title="t('intent.sessionList.new.tooltip')"
        data-testid="intent-session-new"
        @click="emit('new')"
      >
        +
      </button>
    </div>

    <div class="int-sess-items">
      <p
        v-if="visibleSessions.length === 0"
        class="int-sess-empty"
        data-testid="intent-session-empty"
      >
        {{ t('intent.sessionList.empty') }}
      </p>

      <!-- Active sessions (running) — all shown, no pagination -->
      <template v-if="activeSessions.length > 0">
        <span class="int-sess-section-label">{{ t('intent.sessionList.active.label') }}</span>
        <div
          v-for="s in activeSessions"
          :key="s.sessionId"
          class="int-sess-item"
          :class="{ active: s.sessionId === selectedId }"
          data-testid="intent-session-row"
        >
          <div
            class="int-sess-item-main"
            role="button"
            tabindex="0"
            :aria-label="t('intent.sessionList.select.label', { title: displayTitle(s) })"
            @click="emit('select', s.sessionId)"
            @keydown.enter.prevent="emit('select', s.sessionId)"
            @keydown.space.prevent="emit('select', s.sessionId)"
          >
            <span
              class="status-icon int-sess-status-icon"
              :class="{ spin: runStates[s.sessionId] === 'running' }"
              aria-hidden="true"
            >
              {{ runStates[s.sessionId] === 'running' ? TONE_ICON.running : TONE_ICON.idle }}
            </span>
            <span v-if="editingId !== s.sessionId" class="int-sess-title" :title="displayTitle(s)">
              {{ displayTitle(s) }}
            </span>
            <input
              v-else
              v-model="renameValue"
              class="int-sess-rename-input"
              type="text"
              :placeholder="t('intent.sessionList.rename.placeholder')"
              @keydown.enter.prevent="commitRename"
              @keydown.escape.prevent="cancelRename"
              @blur="commitRename"
            />
            <span class="int-sess-date">{{ datePrefix(s.updatedAt) }}</span>
          </div>
          <span v-if="!collapsed" class="int-sess-actions">
            <button
              v-if="editingId !== s.sessionId"
              type="button"
              class="icon-btn"
              :title="t('intent.sessionList.rename.tooltip')"
              data-testid="intent-session-rename"
              @click.stop="startRename(s)"
            >
              ✎
            </button>
            <button
              type="button"
              class="icon-btn"
              :title="t('intent.sessionList.delete.tooltip')"
              data-testid="intent-session-delete"
              @click.stop="deleteSession(s)"
            >
              🗑
            </button>
          </span>
        </div>
      </template>

      <!-- Completed sessions (not running) — paginated -->
      <template v-if="visibleCompleted.length > 0">
        <span class="int-sess-section-label">{{ t('intent.sessionList.completed.label') }}</span>
        <div
          v-for="s in visibleCompleted"
          :key="s.sessionId"
          class="int-sess-item"
          :class="{ active: s.sessionId === selectedId }"
          data-testid="intent-session-row"
        >
          <div
            class="int-sess-item-main"
            role="button"
            tabindex="0"
            :aria-label="t('intent.sessionList.select.label', { title: displayTitle(s) })"
            @click="emit('select', s.sessionId)"
            @keydown.enter.prevent="emit('select', s.sessionId)"
            @keydown.space.prevent="emit('select', s.sessionId)"
          >
            <span class="status-icon int-sess-status-icon" aria-hidden="true">
              {{ TONE_ICON.idle }}
            </span>
            <span v-if="editingId !== s.sessionId" class="int-sess-title" :title="displayTitle(s)">
              {{ displayTitle(s) }}
            </span>
            <input
              v-else
              v-model="renameValue"
              class="int-sess-rename-input"
              type="text"
              :placeholder="t('intent.sessionList.rename.placeholder')"
              @keydown.enter.prevent="commitRename"
              @keydown.escape.prevent="cancelRename"
              @blur="commitRename"
            />
            <span class="int-sess-date">{{ datePrefix(s.updatedAt) }}</span>
          </div>
          <span v-if="!collapsed" class="int-sess-actions">
            <button
              v-if="editingId !== s.sessionId"
              type="button"
              class="icon-btn"
              :title="t('intent.sessionList.rename.tooltip')"
              data-testid="intent-session-rename"
              @click.stop="startRename(s)"
            >
              ✎
            </button>
            <button
              type="button"
              class="icon-btn"
              :title="t('intent.sessionList.delete.tooltip')"
              data-testid="intent-session-delete"
              @click.stop="deleteSession(s)"
            >
              🗑
            </button>
          </span>
        </div>
      </template>

      <!-- Load more button for completed sessions -->
      <button
        v-if="hasMoreCompleted"
        type="button"
        class="int-sess-more"
        :title="t('intent.sessionList.loadMore.tooltip')"
        data-testid="intent-session-more"
        @click="loadMoreCompleted"
      >
        {{ t('intent.sessionList.loadMore.label') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.int-sess-list {
  width: 380px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
.int-sess-list.collapsed {
  width: 180px;
}
@media (max-width: 1024px) {
  .int-sess-list {
    width: min(380px, 30vw);
    min-width: 200px;
  }
  .int-sess-list.collapsed {
    width: min(180px, 15vw);
    min-width: 80px;
  }
}
.int-sess-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.int-sess-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.int-sess-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  white-space: nowrap;
}
.int-sess-collapse-btn {
  flex-shrink: 0;
  background: var(--c-input);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--fs-caption);
  cursor: pointer;
  white-space: nowrap;
}
.int-sess-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.int-sess-new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: var(--fs-title-sm);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.int-sess-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
}
.int-sess-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-1) 0;
  display: flex;
  flex-direction: column;
}
.int-sess-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
.int-sess-section-label {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  padding: var(--sp-1) var(--sp-3);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.int-sess-item {
  display: flex;
  align-items: stretch;
  padding: var(--sp-1) var(--sp-2);
  border-left: 3px solid transparent;
  cursor: default;
}
.int-sess-item:hover {
  background: var(--c-hover);
}
.int-sess-item.active {
  background: var(--c-primary-soft);
  border-left-color: var(--c-primary);
}
.int-sess-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
}
.int-sess-status-icon {
  flex-shrink: 0;
  font-size: var(--fs-body);
  line-height: 1;
}
.int-sess-status-icon.spin {
  animation: status-pulse 1.4s var(--ease-standard) infinite;
}
.int-sess-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.int-sess-rename-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: var(--fs-body);
  padding: 1px var(--sp-1);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  outline: none;
}
.int-sess-date {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.int-sess-list.collapsed .int-sess-date {
  display: none;
}
.int-sess-list.collapsed .int-sess-item-main {
  gap: var(--sp-1);
}
.int-sess-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.int-sess-actions :deep(.icon-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: var(--fs-caption);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.int-sess-item:hover .int-sess-actions :deep(.icon-btn) {
  opacity: 1;
}
.int-sess-actions :deep(.icon-btn:hover) {
  color: var(--c-text);
  background: var(--c-hover);
}
.int-sess-more {
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-top: 1px solid var(--c-border);
  cursor: pointer;
  text-align: center;
}
.int-sess-more:hover {
  color: var(--c-primary);
  background: var(--c-hover);
}
</style>
