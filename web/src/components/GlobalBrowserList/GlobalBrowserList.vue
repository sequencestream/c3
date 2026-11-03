<script setup lang="ts">
import { useTypedI18n } from '@/i18n'

export interface BrowserRow {
  id: string
  workspaceName: string
  title: string
  running: boolean
}
defineProps<{
  title: string
  rows: BrowserRow[]
  activeId: string | null
  activeWorkspace?: string | null
  loading?: boolean
  failed?: boolean
  hasMore?: boolean
}>()
const emit = defineEmits<{ select: [id: string, workspaceName: string]; refresh: []; more: [] }>()
const { t } = useTypedI18n()
</script>

<template>
  <aside class="global-list">
    <header>
      <h2>{{ title }}</h2>
      <button type="button" :disabled="loading" @click="emit('refresh')">
        {{ t('globalBrowser.refresh') }}
      </button>
    </header>
    <div class="global-rows" :aria-busy="loading">
      <button
        v-for="row in rows"
        :key="`${row.workspaceName}:${row.id}`"
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
          />{{ row.title }}</span
        >
        <span class="row-workspace">{{ row.workspaceName }}</span>
      </button>
      <p v-if="failed" role="alert">{{ t('globalBrowser.failed') }}</p>
      <p v-else-if="loading" role="status">{{ t('globalBrowser.loading') }}</p>
      <p v-else-if="!rows.length">{{ t('globalBrowser.empty') }}</p>
      <button
        v-if="hasMore"
        class="load-more"
        type="button"
        :disabled="loading"
        @click="emit('more')"
      >
        {{ t('globalBrowser.more') }}
      </button>
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
.row-workspace,
p {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  overflow-wrap: anywhere;
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
