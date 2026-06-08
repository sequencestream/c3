<script setup lang="ts">
/**
 * WorkCenter.vue — 工作台容器页(两栏布局)。
 *
 * 2026-06-08 重写为两栏布局:
 * - 左栏:事件列表(筛选栏 + EventList)
 * - 右栏:事件详情(EventDetail)
 *
 * 初始无选中事件时右栏显示空状态提示。
 */
import { ref, computed } from 'vue'
import EventList from './components/EventList.vue'
import EventDetail from './components/EventDetail.vue'
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

// ---- Selected event ----

const selectedId = ref<string | null>(null)

const selectedEvent = computed<WaitUserInvolveEvent | null>(() => {
  if (!selectedId.value) return null
  return props.events.find((e) => e.id === selectedId.value) ?? null
})

function onSelect(event: WaitUserInvolveEvent) {
  selectedId.value = event.id
}
</script>

<template>
  <div class="workcenter-page">
    <!-- Left column: filter + event list -->
    <div class="wc-sidebar">
      <div class="wc-sidebar-head">
        <div class="wc-filter-bar">
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
      </div>

      <EventList :events="filteredEvents" :selected-id="selectedId" @select="onSelect" />
    </div>

    <!-- Right column: event detail -->
    <div class="wc-content">
      <EventDetail
        :event="selectedEvent"
        @respond="(e, d) => emit('respond', e, d)"
        @submit-ask="(e, a) => emit('submit-ask', e, a)"
        @jump-to-source="(e) => emit('jump-to-source', e)"
      />
    </div>
  </div>
</template>

<style scoped>
.workcenter-page {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Left column: sidebar pattern */
.wc-sidebar {
  width: 380px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wc-sidebar-head {
  flex-shrink: 0;
  border-bottom: 1px solid var(--c-border);
}

/* Filter bar inside sidebar head */
.wc-filter-bar {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  flex-shrink: 0;
}
.wc-filter-btn {
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  font-size: 12px;
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

/* Right column: content pattern */
.wc-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
