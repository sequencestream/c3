<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { GlobalWorkspacePage } from '@/controls/global-browser'

export interface BrowserRow {
  id: string
  workspaceName: string
  title: string
  running: boolean
  lastModified?: number
}
const props = defineProps<{
  title: string
  rows: BrowserRow[]
  activeId: string | null
  activeWorkspace?: string | null
  loading?: boolean
  paging?: Record<string, GlobalWorkspacePage>
  canCreateSession?: boolean
}>()
const emit = defineEmits<{
  select: [id: string, workspaceName: string]
  refresh: []
  'create-session': [workspaceName: string]
  more: [workspaceName: string]
}>()
const { t } = useTypedI18n()
// Ratios use the list/detail space, excluding the separator and navigation.
const MIN_LIST_PERCENT = 15
const MAX_LIST_PERCENT = 60
const SPLITTER_WIDTH = 6
const listPercent = ref(30)
const listElement = ref<HTMLElement | null>(null)
const dragging = ref(false)
const listWidth = computed(
  () => `calc(${listPercent.value}% - ${(SPLITTER_WIDTH * listPercent.value) / 100}px)`,
)

function setListPercent(value: number): void {
  listPercent.value = Math.min(MAX_LIST_PERCENT, Math.max(MIN_LIST_PERCENT, value))
}

let dragPointerId: number | null = null
let dragStartX = 0
let dragStartPercent = 30

function onDragMove(event: PointerEvent): void {
  if (event.pointerId !== dragPointerId) return
  let container = listElement.value?.parentElement
  while (container && getComputedStyle(container).display === 'contents') {
    container = container.parentElement
  }
  const availableWidth = (container?.getBoundingClientRect().width ?? 0) - SPLITTER_WIDTH
  if (availableWidth <= 0) return
  setListPercent(dragStartPercent + ((event.clientX - dragStartX) / availableWidth) * 100)
}

function stopDrag(): void {
  dragging.value = false
  dragPointerId = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  window.removeEventListener('blur', stopDrag)
}

function onDragEnd(event: PointerEvent): void {
  if (event.pointerId === dragPointerId) stopDrag()
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0 || dragPointerId !== null) return
  event.preventDefault()
  dragPointerId = event.pointerId
  dragStartX = event.clientX
  dragStartPercent = listPercent.value
  dragging.value = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
  window.addEventListener('blur', stopDrag)
}

function onSplitterKey(event: KeyboardEvent): void {
  let value = listPercent.value
  if (event.key === 'ArrowLeft') value -= 2
  else if (event.key === 'ArrowRight') value += 2
  else if (event.key === 'Home') value = MIN_LIST_PERCENT
  else if (event.key === 'End') value = MAX_LIST_PERCENT
  else return
  event.preventDefault()
  setListPercent(value)
}

onBeforeUnmount(stopDrag)

const limits = ref<Record<string, number>>({})
const collapsedWorkspaces = ref(new Set<string>())

function toggleWorkspace(workspaceName: string): void {
  if (collapsedWorkspaces.value.has(workspaceName)) collapsedWorkspaces.value.delete(workspaceName)
  else collapsedWorkspaces.value.add(workspaceName)
}
const groups = computed(() => {
  const names = [
    ...new Set([...Object.keys(props.paging ?? {}), ...props.rows.map((row) => row.workspaceName)]),
  ]
  return names
    .map((workspaceName) => {
      const rows = props.rows.filter((row) => row.workspaceName === workspaceName)
      const page = props.paging?.[workspaceName]
      const limit = limits.value[workspaceName] ?? 5
      return {
        workspaceName,
        latestSessionTime: Math.max(0, ...rows.map((row) => row.lastModified ?? 0)),
        rows: props.paging ? rows : rows.slice(0, limit),
        hasMore: page?.hasMore ?? rows.length > limit,
        loading: page?.loading ?? false,
        failed: page?.failed ?? false,
      }
    })
    .sort((a, b) => b.latestSessionTime - a.latestSessionTime)
})
function loadMore(workspaceName: string): void {
  if (props.paging) emit('more', workspaceName)
  else limits.value[workspaceName] = (limits.value[workspaceName] ?? 5) + 5
}
function refresh(): void {
  limits.value = {}
  emit('refresh')
}
</script>

<template>
  <aside ref="listElement" class="global-list" :style="{ width: listWidth }">
    <header>
      <h2>{{ title }}</h2>
      <button type="button" :disabled="loading" @click="refresh">
        {{ t('globalBrowser.refresh') }}
      </button>
    </header>
    <div class="global-rows">
      <section
        v-for="group in groups"
        :key="group.workspaceName"
        class="workspace-group"
        :aria-label="group.workspaceName"
        :aria-busy="group.loading"
      >
        <h3 class="workspace-title">
          <button
            type="button"
            class="workspace-toggle"
            :aria-expanded="!collapsedWorkspaces.has(group.workspaceName)"
            @click="toggleWorkspace(group.workspaceName)"
          >
            <svg
              class="workspace-folder"
              :class="{ open: !collapsedWorkspaces.has(group.workspaceName) }"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 19V5a1 1 0 0 1 1-1h5l2 3h8a1 1 0 0 1 1 1v3" />
              <path
                v-if="!collapsedWorkspaces.has(group.workspaceName)"
                d="M3 19l3-8h16l-3 8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"
              />
              <path v-else d="M20 11v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1" />
            </svg>
            <span>{{ group.workspaceName }}</span>
          </button>
          <button
            v-if="canCreateSession"
            type="button"
            class="workspace-new-session"
            :title="t('session.list.new.tooltip')"
            :aria-label="`${group.workspaceName}: ${t('session.list.new.tooltip')}`"
            @click="emit('create-session', group.workspaceName)"
          >
            ＋
          </button>
        </h3>
        <div v-if="!collapsedWorkspaces.has(group.workspaceName)" class="workspace-children">
          <button
            v-for="row in group.rows"
            :key="row.id"
            type="button"
            class="global-row"
            :class="{
              selected:
                activeId === row.id && (!activeWorkspace || activeWorkspace === row.workspaceName),
            }"
            :aria-pressed="
              activeId === row.id && (!activeWorkspace || activeWorkspace === row.workspaceName)
            "
            @click="emit('select', row.id, row.workspaceName)"
          >
            <span class="row-title"
              ><span
                v-if="row.running"
                class="running-dot"
                role="img"
                :title="t('globalBrowser.running')"
                :aria-label="t('globalBrowser.running')"
              /><span class="row-label" :title="row.title">{{ row.title }}</span></span
            >
          </button>
          <p v-if="group.failed" role="alert">{{ t('globalBrowser.failed') }}</p>
          <p v-else-if="group.loading" role="status">{{ t('globalBrowser.loading') }}</p>
          <p v-else-if="!group.rows.length">{{ t('globalBrowser.empty') }}</p>
          <button
            v-if="group.hasMore || group.failed"
            class="load-more"
            type="button"
            :disabled="group.loading"
            :aria-label="`${group.workspaceName}: ${t(group.failed ? 'globalBrowser.refresh' : 'globalBrowser.more')}`"
            :title="t(group.failed ? 'globalBrowser.refresh' : 'globalBrowser.more')"
            @click="loadMore(group.workspaceName)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path v-if="group.failed" d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" />
              <path v-else d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </section>
      <p v-if="!groups.length">{{ t('globalBrowser.empty') }}</p>
    </div>
  </aside>
  <div
    class="global-list-splitter"
    :class="{ dragging }"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="title"
    :aria-valuemin="MIN_LIST_PERCENT"
    :aria-valuemax="MAX_LIST_PERCENT"
    :aria-valuenow="listPercent"
    @pointerdown="startDrag"
    @keydown="onSplitterKey"
  />
</template>

<style scoped>
.global-list {
  flex: 0 0 auto;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
}
.global-list-splitter {
  flex: 0 0 6px;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  background: var(--c-border);
}
.global-list-splitter:hover,
.global-list-splitter.dragging,
.global-list-splitter:focus-visible {
  background: var(--c-primary-text);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4);
  gap: var(--sp-2);
}
h2 {
  font-size: var(--fs-body);
  margin: 0;
}
button {
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.global-rows {
  overflow-y: auto;
  flex: 1;
  padding: var(--sp-2);
}
.global-row {
  display: flex;
  width: 100%;
  text-align: left;
  border-color: transparent;
  margin: 0;
  padding: var(--sp-1) var(--sp-2);
}
.global-row:hover,
.global-row.selected {
  background: var(--c-card);
}
.global-row.selected {
  border-color: var(--c-primary-text);
}
.row-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
p {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  overflow-wrap: anywhere;
}
.workspace-group {
  margin-bottom: var(--sp-2);
}
.workspace-title {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow-wrap: anywhere;
}
.workspace-toggle {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1;
  min-width: 0;
  padding: var(--sp-1) var(--sp-2);
  border-color: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.workspace-new-session {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  border-color: transparent;
}
.workspace-new-session:hover {
  background: var(--c-card);
}
.workspace-toggle:hover {
  background: var(--c-card);
}
.workspace-toggle:focus-visible {
  outline: 2px solid var(--c-primary-text);
  outline-offset: -2px;
}
.workspace-folder {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.workspace-folder.open {
  color: var(--c-primary-text);
}
.workspace-children {
  margin-inline-start: calc(18px + var(--sp-2));
}
.row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.running-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--c-success-text);
}
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0 auto;
  padding: 4px;
  border-color: transparent;
  color: var(--c-text-muted);
}
.load-more:hover:not(:disabled) {
  background: var(--c-card);
  color: var(--c-text);
}
.load-more:focus-visible {
  outline: 2px solid var(--c-primary-text);
  outline-offset: 2px;
}
.load-more svg {
  width: 18px;
  height: 18px;
}
@media (max-width: 767px) {
  .global-list-splitter {
    display: none;
  }
  .global-list {
    width: 100% !important;
    min-width: 0;
  }
}
</style>
