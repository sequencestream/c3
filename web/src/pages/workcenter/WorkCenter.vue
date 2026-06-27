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
import type {
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { useIsMobile } from '@/composables/useBreakpoint'

const { t } = useTypedI18n()
const isMobile = useIsMobile()

const props = defineProps<{
  events: WaitUserInvolveEvent[]
  hasMore: boolean
  loading: boolean
  currentWorkspace: string | null
  /** Known workspaces, forwarded to EventDetail to resolve an event's workspace name. */
  workspaces: WorkspaceInfo[]
}>()

const emit = defineEmits<{
  respond: [event: WaitUserInvolveEvent, decision: 'allow' | 'deny']
  'submit-ask': [event: WaitUserInvolveEvent, answers: Record<string, string>]
  'jump-to-source': [event: WaitUserInvolveEvent]
  reload: [status: FilterValue]
  'load-more': [status: FilterValue, cursorTime: number, cursorExcludeId: string]
  'mark-done': [eventId: string]
}>()

// ---- Status filter ----

type FilterValue = WaitUserInvolveStatus
const activeFilter = ref<FilterValue>('todo')

const FILTERS: { key: FilterValue; labelKey: string }[] = [
  { key: 'todo', labelKey: 'workcenter.filter.todo' },
  { key: 'done', labelKey: 'workcenter.filter.done' },
  { key: 'canceled', labelKey: 'workcenter.filter.canceled' },
  { key: 'auto', labelKey: 'workcenter.filter.auto' },
]

const filteredEvents = computed(() => {
  return props.events.filter((e) => e.status === activeFilter.value)
})

const listExpanded = usePersistentToggle('c3.workcenterListExpanded')

function toggleListExpanded(): void {
  listExpanded.value = !listExpanded.value
}

// Switching filter re-fetches the full list: the proactive broadcast carries only
// 'todo', so non-todo tabs (done / canceled / auto) need a pull to be reliable.
function selectFilter(key: FilterValue) {
  activeFilter.value = key
  selectedId.value = null
  emit('reload', key)
}

// ---- Selected event ----

const selectedId = ref<string | null>(null)

const selectedEvent = computed<WaitUserInvolveEvent | null>(() => {
  if (!selectedId.value) return null
  return props.events.find((e) => e.id === selectedId.value) ?? null
})

function onSelect(event: WaitUserInvolveEvent) {
  selectedId.value = event.id
}

function onLoadMore(): void {
  const last = filteredEvents.value[filteredEvents.value.length - 1]
  if (!last) return
  emit('load-more', activeFilter.value, last.createdAt, last.id)
}
</script>

<template>
  <div class="workcenter-page">
    <!-- Left column: filter + event list -->
    <div class="wc-sidebar" :class="{ expanded: listExpanded }">
      <div class="wc-sidebar-head">
        <button
          v-if="!isMobile"
          type="button"
          class="wc-list-toggle"
          :aria-label="
            listExpanded ? t('workcenter.action.collapseList') : t('workcenter.action.expandList')
          "
          :title="
            listExpanded ? t('workcenter.action.collapseList') : t('workcenter.action.expandList')
          "
          :aria-pressed="listExpanded"
          @click="toggleListExpanded"
        >
          {{ listExpanded ? '⇤' : '⇥' }}
        </button>
        <div class="wc-filter-bar">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="wc-filter-btn"
            :class="{ active: activeFilter === f.key }"
            @click="selectFilter(f.key)"
          >
            {{ t(f.labelKey as any) }}
          </button>
        </div>
      </div>

      <EventList
        :events="filteredEvents"
        :selected-id="selectedId"
        :has-more="hasMore"
        :loading="loading"
        @select="onSelect"
        @mark-done="(id) => emit('mark-done', id)"
        @load-more="onLoadMore"
      />
    </div>

    <!-- Right column: event detail -->
    <div class="wc-content">
      <EventDetail
        :event="selectedEvent"
        :workspaces="props.workspaces"
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
  transition: width 0.2s ease;
}
.wc-sidebar.expanded {
  width: 760px;
}
.wc-sidebar-head {
  flex-shrink: 0;
  border-bottom: 1px solid var(--c-border);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
}
.wc-list-toggle {
  flex: 0 0 auto;
  background: var(--c-input);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.wc-list-toggle:hover {
  background: var(--c-hover);
  color: var(--c-text);
}

/* Filter bar inside sidebar head */
.wc-filter-bar {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) 0;
  flex-shrink: 0;
  min-width: 0;
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

@media (max-width: 767px) {
  .workcenter-page {
    flex-direction: column;
    overflow-y: auto;
  }

  .wc-sidebar {
    width: 100%;
    flex-shrink: 0;
    border-right: 0;
    border-bottom: 1px solid var(--c-border);
    overflow: visible;
  }
  .wc-sidebar.expanded {
    width: 100%;
  }

  .wc-sidebar-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--c-panel);
    padding: 0 var(--sp-3);
  }

  .wc-list-toggle {
    display: none;
  }

  .wc-filter-bar {
    overflow-x: auto;
    padding: var(--sp-2) var(--sp-3);
    -webkit-overflow-scrolling: touch;
  }

  .wc-filter-btn {
    min-height: 44px;
    padding: 0 var(--sp-3);
    flex: 0 0 auto;
  }

  .wc-content {
    flex: 0 0 auto;
    min-height: 320px;
  }
}
</style>
