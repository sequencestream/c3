<script setup lang="ts">
/**
 * ExecutionHistoryDialog.vue — 历史选择弹框。
 *
 * 历史 Tab 不再常驻执行列表,改由本弹框选择要查看的一次执行:在选中 schedule 的
 * 完整日志(`logs`,服务端已按 started_at DESC 排序)之上做纯前端分页,默认每页
 * 最近 5 笔,支持上一页 / 下一页。点选一笔上抛 `select-execution` 并请求关闭。
 * 行渲染(状态 badge / 时间 / 耗时 / 退出码)沿用原中栏 ExecutionHistoryList。
 * 纯视图态(分页页码)为本地;数据与 select-execution 契约不变,无任何服务端改动。
 */
import { computed, ref, watch } from 'vue'
import type { ScheduleExecutionLog } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t, d } = useTypedI18n()

const props = defineProps<{
  open: boolean
  logs: ScheduleExecutionLog[]
  activeExecutionId: string | null
}>()

const emit = defineEmits<{
  'select-execution': [id: string]
  close: []
}>()

const PAGE_SIZE = 5

// 0-based 页码;打开弹框时复位到首页(最近 5 笔)。
const page = ref(0)
watch(
  () => props.open,
  (open) => {
    if (open) page.value = 0
  },
)

const pageCount = computed(() => Math.max(1, Math.ceil(props.logs.length / PAGE_SIZE)))
const pagedLogs = computed(() => {
  const start = page.value * PAGE_SIZE
  return props.logs.slice(start, start + PAGE_SIZE)
})

function prevPage(): void {
  if (page.value > 0) page.value -= 1
}
function nextPage(): void {
  if (page.value < pageCount.value - 1) page.value += 1
}

function selectExecution(id: string): void {
  emit('select-execution', id)
  emit('close')
}

function fmtDate(ts: number): string {
  return d(ts, 'datetime')
}

// 一次执行的耗时(ms → 人类可读)。已完成才有 finishedAt。
function fmtDuration(log: ScheduleExecutionLog): string {
  if (log.finishedAt === null) return '—'
  const ms = log.finishedAt - log.startedAt
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
</script>

<template>
  <div
    v-if="open"
    class="ehd-overlay"
    data-testid="history-dialog-overlay"
    @click.self="emit('close')"
  >
    <div class="ehd-modal" role="dialog" aria-modal="true">
      <div class="ehd-head">
        <span class="ehd-title">{{ t('schedule.history.dialog.title') }}</span>
        <button
          type="button"
          class="ehd-close"
          :aria-label="t('common.action.cancel.label')"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="ehd-body">
        <p v-if="logs.length === 0" class="ehd-empty">{{ t('schedule.detail.noHistory') }}</p>
        <template v-else>
          <div
            v-for="log in pagedLogs"
            :key="log.id"
            class="ehd-item"
            :class="{ active: log.id === activeExecutionId }"
            data-testid="history-dialog-item"
            role="button"
            tabindex="0"
            @click="selectExecution(log.id)"
            @keydown.enter.prevent="selectExecution(log.id)"
            @keydown.space.prevent="selectExecution(log.id)"
          >
            <div class="ehd-item-head">
              <span class="log-status-badge" :class="logStatus(log)">{{ logStatus(log) }}</span>
              <span class="ehd-item-time">{{ fmtDate(log.startedAt) }}</span>
            </div>
            <div class="ehd-item-meta">
              <span class="ehd-item-duration">{{
                t('schedule.detail.duration', { duration: fmtDuration(log) })
              }}</span>
              <span v-if="log.exitCode !== null" class="ehd-item-exit">{{
                t('schedule.detail.exit', { code: log.exitCode })
              }}</span>
            </div>
          </div>
        </template>
      </div>

      <div v-if="logs.length > 0" class="ehd-pager">
        <button type="button" class="ehd-page-btn" :disabled="page === 0" @click="prevPage">
          {{ t('schedule.history.dialog.prev') }}
        </button>
        <span class="ehd-page-indicator" data-testid="history-dialog-page">{{
          t('schedule.history.dialog.page', { current: page + 1, total: pageCount })
        }}</span>
        <button
          type="button"
          class="ehd-page-btn"
          :disabled="page >= pageCount - 1"
          @click="nextPage"
        >
          {{ t('schedule.history.dialog.next') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ehd-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 1000);
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
}
.ehd-modal {
  width: 480px;
  max-width: 100%;
  max-height: 80vh;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 移动端:弹框退化为全屏 sheet(对齐既有弹框范式) */
@media (max-width: 767px) {
  .ehd-overlay {
    padding: 0;
  }
  .ehd-modal {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: 0;
  }
}

.ehd-head {
  height: 44px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.ehd-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
}
.ehd-close {
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
  cursor: pointer;
  padding: var(--sp-1);
  line-height: 1;
}
.ehd-close:hover {
  color: var(--c-text);
}

.ehd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ehd-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}

.ehd-item {
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
.ehd-item:hover {
  border-color: var(--c-primary);
}
.ehd-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.ehd-item-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.ehd-item-time {
  font-size: var(--fs-body);
  color: var(--c-text);
  font-weight: 600;
}
.ehd-item-meta {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  flex-wrap: wrap;
}
.ehd-item-duration,
.ehd-item-exit {
  white-space: nowrap;
}

.ehd-pager {
  flex-shrink: 0;
  height: 48px;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  border-top: 1px solid var(--c-border);
}
.ehd-page-btn {
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ehd-page-btn:hover:not(:disabled) {
  background: var(--c-hover);
  border-color: var(--c-primary);
}
.ehd-page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ehd-page-indicator {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 56px;
  text-align: center;
}

/* 状态 badge(复用自 ExecutionHistoryList) */
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
