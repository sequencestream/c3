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
  hasMore: boolean
  loading: boolean
}>()

const emit = defineEmits<{
  select: [event: WaitUserInvolveEvent]
  'mark-done': [eventId: string]
  'load-more': []
}>()

// ---- Session-kind icon mapping ----

const SESSION_KIND_ICONS: Record<string, string> = {
  work: '💬',
  intent: '🎯',
  discussion: '📢',
  automation: '⏰',
  spec: '📝',
  consensus: '⚙️',
  tool: '🔧',
}

function sessionKindIcon(sessionKind: string): string {
  return SESSION_KIND_ICONS[sessionKind] ?? '❓'
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
      <!-- Session-kind icon -->
      <span
        class="wc-source-icon"
        :title="t(`workcenter.sessionKind.${event.sessionKind}` as LocaleKey)"
      >
        {{ sessionKindIcon(event.sessionKind) }}
      </span>

      <!-- Title (or fallback) -->
      <span class="wc-event-title">{{
        eventDisplayTitle(event, sessionKindIcon(event.sessionKind))
      }}</span>

      <!-- Timestamp -->
      <span class="wc-event-time">{{ formatTime(event.createdAt) }}</span>

      <span class="wc-row-actions" @click.stop>
        <button
          v-if="event.status === 'todo'"
          type="button"
          class="wc-mark-done"
          @click="emit('mark-done', event.id)"
        >
          {{ t('workcenter.action.markDone') }}
        </button>
        <span class="wc-status-badge" :class="statusClass(event.status)">
          {{ t(`workcenter.status.${event.status}` as LocaleKey) }}
        </span>
      </span>
    </div>

    <div v-if="hasMore" class="wc-load-more-wrap">
      <button type="button" class="wc-load-more" :disabled="loading" @click="emit('load-more')">
        {{ loading ? t('workcenter.action.loading') : t('workcenter.action.loadMore') }}
      </button>
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
.wc-row-actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}
.wc-mark-done,
.wc-load-more {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-input);
  color: var(--c-text);
  cursor: pointer;
  font-size: 11px;
}
.wc-mark-done {
  padding: 1px 7px;
  line-height: 1.5;
}
.wc-mark-done:hover,
.wc-load-more:hover:not(:disabled) {
  background: var(--c-hover);
}
.wc-load-more-wrap {
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
}
.wc-load-more {
  width: 100%;
  padding: var(--sp-2);
}
.wc-load-more:disabled {
  cursor: default;
  opacity: 0.65;
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
  /* Inside the MobileStack list pane the list scrolls internally (the pane, not the
     page, is the scroll container), so the base flex:1 + overflow-y:auto is kept; only
     touch target sizing is bumped below. */
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
