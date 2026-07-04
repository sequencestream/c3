<script setup lang="ts">
/**
 * WorkCenter.vue — 工作台容器页(两栏布局)。
 *
 * 2026-06-08 重写为两栏布局:
 * - 左栏:事件列表(筛选栏 + EventList)
 * - 右栏:事件详情(EventDetail)
 *
 * 初始无选中事件时右栏显示空状态提示。
 *
 * 移动端经 MobileStack 退化为 列表 → 详情 两级 drill-down:点击事件行整屏切到
 * EventDetail,顶部工具栏返回回列表。桌面端依赖 MobileStack 的 display:contents
 * 透传,两个 pane 继续同时渲染为 sidebar/content 两栏,行为不变。
 */
import { ref, computed } from 'vue'
import BaseDropdown, { type DropdownOption } from '@/components/BaseDropdown/BaseDropdown.vue'
import MobileStack from '@/components/MobileStack/MobileStack.vue'
import EventList from './components/EventList.vue'
import EventDetail from './components/EventDetail.vue'
import type {
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
  WorkspaceInfo,
} from '@ccc/shared/protocol'
import { useTypedI18n, type LocaleKey } from '@/i18n'
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

type FilterValue = WaitUserInvolveStatus | undefined
type DropdownFilterValue = WaitUserInvolveStatus | 'all'
const activeFilter = ref<FilterValue>(undefined)

const FILTERS: { key: DropdownFilterValue; labelKey: LocaleKey }[] = [
  { key: 'all', labelKey: 'workcenter.filter.all' },
  { key: 'todo', labelKey: 'workcenter.filter.todo' },
  { key: 'done', labelKey: 'workcenter.filter.done' },
  { key: 'canceled', labelKey: 'workcenter.filter.canceled' },
  { key: 'auto', labelKey: 'workcenter.filter.auto' },
]

const filterOptions = computed<DropdownOption<DropdownFilterValue>[]>(() =>
  FILTERS.map((f) => ({ value: f.key, label: t(f.labelKey) })),
)
const dropdownFilter = computed<DropdownFilterValue>({
  get: () => activeFilter.value ?? 'all',
  set: (key) => selectFilter(key),
})

const filteredEvents = computed(() => {
  if (!activeFilter.value) return props.events
  return props.events.filter((e) => e.status === activeFilter.value)
})

const listExpanded = usePersistentToggle('c3.workcenterListExpanded')

function toggleListExpanded(): void {
  listExpanded.value = !listExpanded.value
}

// Switching filter re-fetches the full list: the proactive broadcast carries only
// 'todo', so non-todo tabs (done / canceled / auto) need a pull to be reliable.
function selectFilter(key: DropdownFilterValue): void {
  const next = key === 'all' ? undefined : key
  activeFilter.value = next
  selectedId.value = null
  // Filter change drops the selection, so mobile falls back to the list pane.
  mobileActiveKey.value = 'list'
  emit('reload', next)
}

// ---- Selected event ----

const selectedId = ref<string | null>(null)

const selectedEvent = computed<WaitUserInvolveEvent | null>(() => {
  if (!selectedId.value) return null
  return props.events.find((e) => e.id === selectedId.value) ?? null
})

function onSelect(event: WaitUserInvolveEvent) {
  selectedId.value = event.id
  // Drill into the detail pane on mobile; harmless on desktop (both panes render).
  mobileActiveKey.value = 'detail'
  if (isNotificationEvent(event)) emit('mark-done', event.id)
}

// ---- Mobile drill-down state ----
// Two panes: event list → event detail. The active pane is an explicit ref (not purely
// derived from `selectedId`) so drilling back and re-tapping the same row re-enters the
// detail pane; `selectedId` is kept across back to preserve the list-row highlight and
// detail context. `activeToken` uses the event id so switching between two event details
// refreshes the pane. Desktop renders both panes regardless of this state.
const MOBILE_PANE_LIST = 'list' as const
const MOBILE_PANE_DETAIL = 'detail' as const
const mobileActiveKey = ref<typeof MOBILE_PANE_LIST | typeof MOBILE_PANE_DETAIL>(MOBILE_PANE_LIST)

const listTitle = computed(() => t('workcenter.notificationTitle' as LocaleKey))
const mobilePanes = computed(() => [
  { key: MOBILE_PANE_LIST, title: listTitle.value },
  { key: MOBILE_PANE_DETAIL, title: selectedEvent.value?.title ?? listTitle.value },
])
const mobileActiveToken = computed<string>(() => selectedId.value ?? MOBILE_PANE_LIST)

// Empty list or a selection that no longer resolves stays on / falls back to the list pane,
// so mobile never shows an empty detail as the stack top.
const resolvedMobileKey = computed(() =>
  selectedEvent.value ? mobileActiveKey.value : MOBILE_PANE_LIST,
)

function onMobileBack(targetKey: string): void {
  if (targetKey === MOBILE_PANE_LIST) mobileActiveKey.value = MOBILE_PANE_LIST
}

function onLoadMore(): void {
  const last = filteredEvents.value[filteredEvents.value.length - 1]
  if (!last) return
  emit('load-more', activeFilter.value, last.createdAt, last.id)
}

function isNotificationEvent(event: WaitUserInvolveEvent): boolean {
  return event.status === 'todo' && event.requestId === null && event.toolName !== 'AskUserQuestion'
}
</script>

<template>
  <div class="workcenter-page">
    <MobileStack
      :panes="mobilePanes"
      :active-key="resolvedMobileKey"
      :active-token="mobileActiveToken"
      :back-label="listTitle"
      @back="onMobileBack"
    >
      <!-- List pane: filter + event list -->
      <template #list>
        <div class="wc-sidebar" :class="{ expanded: listExpanded }">
          <div class="wc-sidebar-head">
            <button
              v-if="!isMobile"
              type="button"
              class="wc-list-toggle"
              :aria-label="
                listExpanded
                  ? t('workcenter.action.collapseList')
                  : t('workcenter.action.expandList')
              "
              :title="
                listExpanded
                  ? t('workcenter.action.collapseList')
                  : t('workcenter.action.expandList')
              "
              :aria-pressed="listExpanded"
              @click="toggleListExpanded"
            >
              {{ listExpanded ? '⇤' : '⇥' }}
            </button>
            <h2 class="wc-sidebar-title">{{ listTitle }}</h2>
            <div class="wc-filter-select">
              <BaseDropdown
                v-model="dropdownFilter"
                :options="filterOptions"
                :aria-label="t('workcenter.filter.label' as LocaleKey)"
              />
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
      </template>

      <!-- Detail pane: event detail -->
      <template #detail>
        <div class="wc-content">
          <EventDetail
            :event="selectedEvent"
            :workspaces="props.workspaces"
            @respond="(e, d) => emit('respond', e, d)"
            @submit-ask="(e, a) => emit('submit-ask', e, a)"
            @jump-to-source="(e) => emit('jump-to-source', e)"
          />
        </div>
      </template>
    </MobileStack>
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
  min-height: 40px;
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

.wc-sidebar-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--c-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wc-filter-select {
  flex: 0 0 112px;
  margin-left: auto;
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
  /* Mobile: MobileStack owns the drill-down layout (one pane at a time), so each pane's
     root fills the stack and scrolls internally instead of stacking into one long page. */
  .wc-sidebar {
    width: 100%;
    flex: 1;
    min-height: 0;
    border-right: 0;
    overflow: hidden;
  }
  .wc-sidebar.expanded {
    width: 100%;
  }

  .wc-list-toggle {
    display: none;
  }

  .wc-content {
    flex: 1;
    min-height: 0;
  }
}
</style>
