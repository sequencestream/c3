<script setup lang="ts">
/**
 * WorkCenter.vue — 工作台容器页。
 *
 * 集中展示所有待处理事件,支持状态筛选、行内 Allow/Deny、AskUserQuestion 逐题作答,
 * 以及跳转到事件源视图。所有数据由 App.vue 注入;用户动作经 emit 上抛。
 */
import { ref, computed } from 'vue'
import EventList from './components/EventList.vue'
import type { WaitUserInvolveEvent, WaitUserInvolveStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  events: WaitUserInvolveEvent[]
  currentWorkspace: string | null
}>()

const emit = defineEmits<{
  respond: [event: WaitUserInvolveEvent, decision: 'allow' | 'deny']
  'submit-ask': [event: WaitUserInvolveEvent, answers: Record<string, string>]
  'jump-to-source': [event: WaitUserInvolveEvent]
}>()

// ---- Status filter ----

type FilterValue = 'all' | WaitUserInvolveStatus
const activeFilter = ref<FilterValue>('all')

const FILTERS: { key: FilterValue; labelKey: string }[] = [
  { key: 'all', labelKey: 'workcenter.filter.all' },
  { key: 'todo', labelKey: 'workcenter.filter.todo' },
  { key: 'done', labelKey: 'workcenter.filter.done' },
  { key: 'canceled', labelKey: 'workcenter.filter.canceled' },
]

const filteredEvents = computed(() => {
  if (activeFilter.value === 'all') return props.events
  return props.events.filter((e) => e.status === activeFilter.value)
})

/** Events grouped by projectPath for display. */
const groupedEvents = computed(() => {
  const groups: Record<string, WaitUserInvolveEvent[]> = {}
  for (const event of filteredEvents.value) {
    const key = event.projectPath || '_unknown_'
    if (!groups[key]) groups[key] = []
    groups[key].push(event)
  }
  return groups
})
</script>

<template>
  <div class="workcenter-page">
    <div class="workcenter-filter-bar">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="wc-filter-btn"
        :class="{ active: activeFilter === f.key }"
        @click="activeFilter = f.key"
      >
        {{ t(f.labelKey as any) }}
      </button>
    </div>

    <EventList
      :groups="groupedEvents"
      @respond="(e, d) => emit('respond', e, d)"
      @submit-ask="(e, a) => emit('submit-ask', e, a)"
      @jump-to-source="(e) => emit('jump-to-source', e)"
    />
  </div>
</template>

<style scoped>
.workcenter-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.workcenter-filter-bar {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.wc-filter-btn {
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  font-size: 13px;
  color: var(--c-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.wc-filter-btn:hover {
  color: var(--c-text);
  background: var(--c-card);
}
.wc-filter-btn.active {
  color: var(--c-text);
  background: var(--c-card);
  border-color: var(--c-text);
}
</style>
