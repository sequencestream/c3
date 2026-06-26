<script setup lang="ts">
/**
 * EventList.vue — 工作台左侧事件列表。
 *
 * 精简版:只做列表展示+选中高亮,emit select。
 * 移除 inline Ask panel 和操作按钮,操作按钮移到右侧 EventDetail.vue。
 *
 * 2026-06-08 精简以支持 WorkCenter 两栏布局。
 */
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { eventDisplayTitle } from '@/lib/event-title'

const { t } = useTypedI18n()

defineProps<{
  /** Events to display (already filtered). */
  events: WaitUserInvolveEvent[]
  /** Currently selected event id, or null. */
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [event: WaitUserInvolveEvent]
}>()

// ---- Source type icon mapping ----

const SOURCE_ICONS: Record<string, string> = {
  work: '💬',
  intent: '🎯',
  discussion: '📢',
  schedule: '⏰',
  spec: '📝',
}

function sourceIcon(source: string): string {
  return SOURCE_ICONS[source] ?? '❓'
}

// ---- Time formatting ----

function formatTime(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / 60000)

  if (minutes < 1) return t('workcenter.time.justNow')
  if (minutes < 60) return t('workcenter.time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('workcenter.time.hoursAgo', { n: hours })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---- Status CSS class ----

function statusClass(status: string): string {
  switch (status) {
    case 'todo':
      return 'wc-status-todo'
    case 'done':
      return 'wc-status-done'
    case 'canceled':
      return 'wc-status-canceled'
    case 'auto':
      return 'wc-status-auto'
    default:
      return ''
  }
}
</script>

<template>
  <div class="wc-event-list-scroll">
    <div v-if="events.length === 0" class="wc-empty">
      {{ t('workcenter.empty') }}
    </div>

    <div
      v-for="event in events"
      :key="event.id"
      class="wc-event-row"
      :class="{ selected: event.id === selectedId }"
      @click="emit('select', event)"
    >
      <!-- Status badge -->
      <span class="wc-status-badge" :class="statusClass(event.status)">
        {{ t(`workcenter.status.${event.status}` as LocaleKey) }}
      </span>

      <!-- Source icon -->
      <span class="wc-source-icon" :title="t(`workcenter.source.${event.source}` as LocaleKey)">
        {{ sourceIcon(event.source) }}
      </span>

      <!-- Title (or fallback) -->
      <span class="wc-event-title">{{ eventDisplayTitle(event, sourceIcon(event.source)) }}</span>

      <!-- Timestamp -->
      <span class="wc-event-time">{{ formatTime(event.createdAt) }}</span>
    </div>
  </div>
</template>

<style scoped>
.wc-event-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-1) 0;
}

/* Event row */
.wc-event-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  min-height: 36px;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
  border-left: 3px solid transparent;
}
.wc-event-row:hover {
  background: var(--c-card);
}
.wc-event-row.selected {
  background: var(--c-card);
  border-left-color: var(--c-primary, #3b82f6);
}

/* Status badge */
.wc-status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  flex-shrink: 0;
}
.wc-status-todo {
  background: #fef3c7;
  color: #92400e;
}
.wc-status-done {
  background: #d1fae5;
  color: #065f46;
}
.wc-status-canceled {
  background: #e5e7eb;
  color: #374151;
}
.wc-status-auto {
  background: #e0e7ff;
  color: #3730a3;
}

/* Source icon */
.wc-source-icon {
  flex-shrink: 0;
  font-size: 16px;
  cursor: default;
}

/* Title */
.wc-event-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--c-text);
}

/* Timestamp */
.wc-event-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--c-text-muted);
  white-space: nowrap;
}

/* Empty state */
.wc-empty {
  text-align: center;
  padding: var(--sp-4);
  color: var(--c-text-muted);
  font-size: 13px;
}

@media (max-width: 767px) {
  .wc-event-list-scroll {
    flex: 0 0 auto;
    overflow: visible;
    padding: 0;
  }

  .wc-event-row {
    min-height: 48px;
    padding: var(--sp-2) var(--sp-3);
  }

  .wc-source-icon {
    min-width: 24px;
    text-align: center;
  }

  .wc-event-time {
    font-size: 12px;
  }
}
</style>
