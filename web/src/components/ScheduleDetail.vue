<script setup lang="ts">
/**
 * ScheduleDetail.vue — schedules 视图右栏:详情面板。
 *
 * 未选中时显示空态提示;选中后展示当前配置完整摘要、未来执行预览(时间轴 +
 * 倒计时)以及历史执行日志(起止时间 / 退出码 / output / error)。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import type { Schedule, ScheduleExecutionLog } from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron } from '@ccc/shared/cron'

const props = withDefaults(
  defineProps<{
    schedule: Schedule | null
    logs?: ScheduleExecutionLog[]
  }>(),
  { logs: () => [] },
)

// 未来预览要展示几次执行(验收要求 3-5 次)。
const UPCOMING_COUNT = 5

// Live countdown: refreshed every 30s so relative times stay current
// (mirrors ScheduleList).
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
  return new Date(ts).toLocaleString()
}

function fmtNextRun(ts: number | null): string {
  if (ts === null) return 'Not scheduled'
  return new Date(ts).toLocaleString()
}

// Relative countdown, identical formatting to ScheduleList.
function timeLeft(ts: number): string {
  const diff = ts - now.value
  if (diff <= 0) return 'Due now'
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return `in ${days}d ${hrs % 24}h`
  if (hrs > 0) return `in ${hrs}h ${mins % 60}m`
  if (mins > 0) return `in ${mins}m`
  return '< 1m'
}

// 未来 N 次执行时间:从"现在"起反复推进 cron。无效/无下次时返回空数组。
const upcomingRuns = computed<number[]>(() => {
  const cron = props.schedule?.cronExpression
  if (!cron || !isValidCron(cron)) return []
  const runs: number[] = []
  let after = now.value
  for (let i = 0; i < UPCOMING_COUNT; i++) {
    try {
      const next = computeNextRunAt(cron, after)
      if (!Number.isFinite(next) || next <= after) break
      runs.push(next)
      after = next
    } catch {
      break
    }
  }
  return runs
})

const configText = computed(() => {
  const c = props.schedule?.config
  if (c === null || c === undefined) return '—'
  try {
    return JSON.stringify(c, null, 2)
  } catch {
    return String(c)
  }
})

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
</script>

<template>
  <div class="sched-detail">
    <template v-if="schedule">
      <h2 class="sched-detail-title">Schedule Detail</h2>

      <div class="sched-detail-grid">
        <div class="sched-field">
          <span class="sched-field-label">ID</span>
          <span class="sched-field-value mono">{{ schedule.id }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Type</span>
          <span class="sched-field-value">{{ schedule.type }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Status</span>
          <span class="sched-field-value">
            <span class="detail-status-badge" :class="schedule.status">{{ schedule.status }}</span>
          </span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Cron Expression</span>
          <span class="sched-field-value"
            ><code>{{ schedule.cronExpression }}</code></span
          >
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Next Run</span>
          <span class="sched-field-value">{{ fmtNextRun(schedule.nextRunAt) }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">MCP Mode</span>
          <span class="sched-field-value">{{ schedule.mcpMode }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Tool Allowlist</span>
          <span class="sched-field-value">{{
            schedule.toolAllowlist.length ? schedule.toolAllowlist.join(', ') : '—'
          }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Tool Denylist</span>
          <span class="sched-field-value">{{
            schedule.toolDenylist.length ? schedule.toolDenylist.join(', ') : '—'
          }}</span>
        </div>

        <div class="sched-field sched-field--full">
          <span class="sched-field-label">Config</span>
          <pre class="sched-config">{{ configText }}</pre>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Created</span>
          <span class="sched-field-value">{{ fmtDate(schedule.createdAt) }}</span>
        </div>

        <div class="sched-field">
          <span class="sched-field-label">Updated</span>
          <span class="sched-field-value">{{ fmtDate(schedule.updatedAt) }}</span>
        </div>
      </div>

      <!-- Upcoming runs: next few execution times computed from the cron expr. -->
      <section class="sched-section">
        <h3 class="sched-section-title">Upcoming runs</h3>
        <ol v-if="upcomingRuns.length" class="sched-timeline">
          <li v-for="(ts, i) in upcomingRuns" :key="ts" class="sched-timeline-item">
            <span class="sched-timeline-dot" :class="{ next: i === 0 }" />
            <span class="sched-timeline-time">{{ fmtDate(ts) }}</span>
            <span class="sched-timeline-rel">{{ timeLeft(ts) }}</span>
          </li>
        </ol>
        <p v-else class="sched-section-empty">No upcoming runs for this schedule.</p>
      </section>

      <!-- Execution history: most-recent first (server orders by started_at DESC). -->
      <section class="sched-section">
        <h3 class="sched-section-title">Execution history</h3>
        <ul v-if="logs.length" class="sched-log-list">
          <li v-for="log in logs" :key="log.id" class="sched-log">
            <div class="sched-log-head">
              <span class="log-status-badge" :class="logStatus(log)">{{ logStatus(log) }}</span>
              <span class="sched-log-time">{{ fmtDate(log.startedAt) }}</span>
              <span class="sched-log-meta">
                <span>Duration: {{ fmtDuration(log) }}</span>
                <span v-if="log.exitCode !== null">· Exit {{ log.exitCode }}</span>
              </span>
            </div>
            <div class="sched-log-row">
              <span class="sched-log-label">Started</span>
              <span class="sched-log-val">{{ fmtDate(log.startedAt) }}</span>
            </div>
            <div class="sched-log-row">
              <span class="sched-log-label">Finished</span>
              <span class="sched-log-val">{{
                log.finishedAt === null ? 'Running…' : fmtDate(log.finishedAt)
              }}</span>
            </div>
            <pre v-if="log.output" class="sched-log-output">{{ log.output }}</pre>
            <pre v-if="log.error" class="sched-log-error">{{ log.error }}</pre>
          </li>
        </ul>
        <p v-else class="sched-section-empty">No execution history yet.</p>
      </section>
    </template>

    <div v-else class="sched-detail-empty">
      <p>Select a schedule to view details.</p>
    </div>
  </div>
</template>

<style scoped>
.sched-detail {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: var(--sp-4);
  background: var(--c-panel);
  color: var(--c-text);
}
.sched-detail-title {
  font-size: var(--fs-title);
  font-weight: 600;
  margin: 0 0 var(--sp-4);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.sched-detail-grid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sched-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sched-field--full {
  /* config may be long — full width, no max-height restriction */
}
.sched-field-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.sched-field-value {
  font-size: var(--fs-body);
  color: var(--c-text);
  word-break: break-word;
}
.sched-field-value.mono {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sched-field-value code {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-hover);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
}
.detail-status-badge {
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
  text-transform: capitalize;
}
.detail-status-badge.active {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success);
}
.detail-status-badge.paused {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning);
}
.detail-status-badge.error {
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error);
}
.sched-config {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  margin: 0;
}
.sched-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
}

/* ---- Upcoming runs + execution history ---- */
.sched-section {
  margin-top: var(--sp-5);
}
.sched-section-title {
  font-size: var(--fs-body);
  font-weight: 600;
  margin: 0 0 var(--sp-2);
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--c-border);
}
.sched-section-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}

/* Timeline */
.sched-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sched-timeline-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sched-timeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-text-muted);
  flex: 0 0 auto;
}
.sched-timeline-dot.next {
  background: var(--c-success);
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}
.sched-timeline-time {
  font-size: var(--fs-body);
  color: var(--c-text);
}
.sched-timeline-rel {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}

/* Execution log entries */
.sched-log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sched-log {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-card);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sched-log-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.sched-log-time {
  font-size: var(--fs-body);
  color: var(--c-text);
  font-weight: 600;
}
.sched-log-meta {
  margin-left: auto;
  display: flex;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sched-log-row {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.sched-log-label {
  color: var(--c-text-muted);
  min-width: 60px;
}
.sched-log-val {
  color: var(--c-text);
}
.sched-log-output,
.sched-log-error {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-bg, var(--c-panel));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin: var(--sp-1) 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 240px;
}
.sched-log-error {
  color: var(--c-error);
  border-color: rgba(239, 68, 68, 0.4);
}
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
