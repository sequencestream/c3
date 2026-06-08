<script setup lang="ts">
/**
 * ExecutionHistoryList.vue — schedules 视图的中栏:选中 schedule 的执行历史列表。
 *
 * 展示选中 schedule 的历史执行记录(状态 badge / 开始时间 / 耗时 / 退出码),
 * 点击选中某一次执行,联动右栏 ExecutionDetail 展示详情。
 *
 * 数据流:logs 由 App.vue 经 Schedules.vue 传入;选中态上抛给 App.vue 管理。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import type { Schedule, ScheduleExecutionLog } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t, d } = useTypedI18n()

const props = defineProps<{
  schedule: Schedule | null
  logs: ScheduleExecutionLog[]
  activeExecutionId: string | null
}>()

const emit = defineEmits<{
  'select-execution': [id: string]
}>()

// Live clock: refreshed every 30s so running executions' durations stay current.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function fmtDate(ts: number): string {
  return d(ts, 'datetime')
}

// 一次执行的耗时(ms → 人类可读),未结束则显示运行时长。
function fmtDuration(log: ScheduleExecutionLog): string {
  const end = log.finishedAt ?? now.value
  const ms = end - log.startedAt
  if (ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

// status 缺省时按是否结束推断,保证 badge 始终有值。
function logStatus(log: ScheduleExecutionLog): string {
  if (log.status) return log.status
  return log.finishedAt === null ? 'running' : 'success'
}

// 中栏标题:复用 schedule 名称,与右栏一致。
const title = computed(() => {
  if (!props.schedule) return ''
  const s = props.schedule
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  const fallback =
    s.triggerType === 'event'
      ? s.eventTopic === 'run:started'
        ? t('schedule.trigger.event.started')
        : t('schedule.trigger.event.settled')
      : s.cronExpression
  return name || fallback
})
</script>

<template>
  <section class="exec-history">
    <div class="exec-history-head">
      <span class="exec-history-title">{{ t('schedule.history.title') }}</span>
      <span v-if="schedule" class="exec-history-schedule-name">{{ title }}</span>
    </div>
    <div class="exec-history-items">
      <!-- 未选中 schedule -->
      <p v-if="!schedule" class="exec-history-empty">
        {{ t('schedule.history.empty') }}
      </p>
      <!-- 选中 schedule 但无历史 -->
      <p v-else-if="logs.length === 0" class="exec-history-empty">
        {{ t('schedule.detail.noHistory') }}
      </p>
      <!-- 执行历史列表 -->
      <template v-else>
        <div
          v-for="log in logs"
          :key="log.id"
          class="exec-history-item"
          :class="{ active: log.id === activeExecutionId }"
          role="button"
          tabindex="0"
          @click="emit('select-execution', log.id)"
          @keydown.enter.prevent="emit('select-execution', log.id)"
          @keydown.space.prevent="emit('select-execution', log.id)"
        >
          <div class="exec-item-head">
            <span class="log-status-badge" :class="logStatus(log)">{{ logStatus(log) }}</span>
            <span class="exec-item-time">{{ fmtDate(log.startedAt) }}</span>
          </div>
          <div class="exec-item-meta">
            <span class="exec-item-duration">{{
              t('schedule.detail.duration', { duration: fmtDuration(log) })
            }}</span>
            <span v-if="log.exitCode !== null" class="exec-item-exit">{{
              t('schedule.detail.exit', { code: log.exitCode })
            }}</span>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 中栏容器 */
.exec-history {
  width: 320px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
@media (max-width: 1024px) {
  .exec-history {
    width: min(320px, 30vw);
    min-width: 200px;
  }
}

/* 标题区 */
.exec-history-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.exec-history-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  white-space: nowrap;
}
.exec-history-schedule-name {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 列表区域 */
.exec-history-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.exec-history-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}

/* 执行历史条目 */
.exec-history-item {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}
.exec-history-item:hover {
  border-color: var(--c-primary);
}
.exec-history-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}

.exec-item-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.exec-item-time {
  font-size: var(--fs-body);
  color: var(--c-text);
  font-weight: 600;
}
.exec-item-meta {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  flex-wrap: wrap;
}
.exec-item-duration {
  white-space: nowrap;
}
.exec-item-exit {
  white-space: nowrap;
}

/* 状态 badge (复用自 ScheduleDetail) */
.log-status-badge {
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
  text-transform: capitalize;
}
.log-status-badge.running {
  background: rgba(59, 130, 246, 0.15);
  color: var(--c-info, #3b82f6);
}
.log-status-badge.success {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success);
}
.log-status-badge.failed {
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error);
}
.log-status-badge.cancelled {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning);
}
</style>
