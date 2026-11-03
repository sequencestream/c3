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
        <h3 class="workspace-title">{{ group.workspaceName }}</h3>
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
          @click="loadMore(group.workspaceName)"
        >
          {{ t(group.failed ? 'globalBrowser.refresh' : 'globalBrowser.more') }}
        </button>
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
  flex-direction: column;
  gap: var(--sp-1);
  width: 100%;
  text-align: left;
  border-color: transparent;
  margin-bottom: var(--sp-1);
  padding: var(--sp-3);
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
  margin-bottom: var(--sp-4);
}
.workspace-title {
  margin: 0;
  padding: var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow-wrap: anywhere;
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
  width: 100%;
}
@media (max-width: 767px) {
  .global-list {
    width: 100%;
    min-width: 0;
  }
}
</style>
