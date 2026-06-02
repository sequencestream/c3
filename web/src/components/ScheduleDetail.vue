<script setup lang="ts">
/**
 * ScheduleDetail.vue — schedules 视图右栏:详情面板。
 *
 * 未选中时显示空态提示;选中后展示当前配置完整摘要。
 */
import { computed } from 'vue'
import type { Schedule } from '@ccc/shared/protocol'

const props = defineProps<{
  schedule: Schedule | null
}>()

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

function fmtNextRun(ts: number | null): string {
  if (ts === null) return 'Not scheduled'
  return new Date(ts).toLocaleString()
}

const configText = computed(() => {
  const c = props.schedule?.config
  if (c === null || c === undefined) return '—'
  try {
    return JSON.stringify(c, null, 2)
  } catch {
    return String(c)
  }
})
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
</style>
