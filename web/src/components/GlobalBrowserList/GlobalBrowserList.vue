<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { GlobalWorkspacePage } from '@/controls/global-browser'

export interface BrowserRow {
  id: string
  workspaceName: string
  title: string
  running: boolean
}
const props = defineProps<{
  title: string
  rows: BrowserRow[]
  activeId: string | null
  activeWorkspace?: string | null
  loading?: boolean
  paging?: Record<string, GlobalWorkspacePage>
}>()
const emit = defineEmits<{
  select: [id: string, workspaceName: string]
  refresh: []
  more: [workspaceName: string]
}>()
const { t } = useTypedI18n()
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
  return names.map((workspaceName) => {
    const rows = props.rows.filter((row) => row.workspaceName === workspaceName)
    const page = props.paging?.[workspaceName]
    const limit = limits.value[workspaceName] ?? 5
    return {
      workspaceName,
      rows: props.paging ? rows : rows.slice(0, limit),
      hasMore: page?.hasMore ?? rows.length > limit,
      loading: page?.loading ?? false,
      failed: page?.failed ?? false,
    }
  })
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
  <aside class="global-list">
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
</template>

<style scoped>
.global-list {
  width: 300px;
  min-width: 240px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
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
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow-wrap: anywhere;
}
.workspace-toggle {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  border-color: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
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
  .global-list {
    width: 100%;
    min-width: 0;
  }
}
</style>
