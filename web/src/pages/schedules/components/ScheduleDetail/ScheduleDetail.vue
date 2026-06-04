<script setup lang="ts">
/**
 * ScheduleDetail.vue — schedules 视图右栏:执行日志面板。
 *
 * 未选中时显示空态提示;选中后只展示历史执行日志(起止时间 / 退出码 / output /
 * error,以及 llm 任务的 session 记录)。Schedule 的配置信息(类型、cron、
 * 工具名单、config、未来执行预览等)放在左侧列表的行内展开框里。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import type { Schedule, ScheduleExecutionLog, TranscriptItem } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    schedule: Schedule | null
    logs?: ScheduleExecutionLog[]
    // Agent-session transcripts keyed by executionId, fetched on demand by the
    // parent when a log item is expanded.
    transcripts?: Record<string, TranscriptItem[]>
  }>(),
  { logs: () => [], transcripts: () => ({}) },
)

const emit = defineEmits<{
  // Request the transcript for one execution; parent replies by populating
  // `transcripts[executionId]`.
  'load-session': [executionId: string]
}>()

// Whether this schedule produces agent sessions (only llm prompts do). Command
// schedules never show the "View session" entry.
const isLlm = computed(() => props.schedule?.type === 'llm')

// Right-pane title: the schedule's display name (config.name, falling back to
// the cron expression) followed by "Logs".
const detailTitle = computed(() => {
  const s = props.schedule
  if (!s) return ''
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  return t('schedule.detail.title', { name: name || s.cronExpression })
})

// executionIds whose session view is currently expanded.
const expandedSessions = ref<Set<string>>(new Set())

function isExpanded(id: string): boolean {
  return expandedSessions.value.has(id)
}

// Toggle one log's session view. On first expand (no cached transcript yet),
// ask the parent to fetch it.
function toggleSession(id: string): void {
  const next = new Set(expandedSessions.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
    if (props.transcripts[id] === undefined) emit('load-session', id)
  }
  expandedSessions.value = next
}

function transcriptOf(id: string): TranscriptItem[] | undefined {
  return props.transcripts[id]
}

// Compact, human-readable tool input for the transcript view.
function fmtToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

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
</script>

<template>
  <div class="sched-detail">
    <template v-if="schedule">
      <h2 class="sched-detail-title">{{ detailTitle }}</h2>

      <!-- Execution history: most-recent first (server orders by started_at DESC). -->
      <section class="sched-section sched-section--first">
        <h3 class="sched-section-title">{{ t('schedule.detail.history.label') }}</h3>
        <ul v-if="logs.length" class="sched-log-list">
          <li v-for="log in logs" :key="log.id" class="sched-log">
            <div class="sched-log-head">
              <span class="log-status-badge" :class="logStatus(log)">{{ logStatus(log) }}</span>
              <span class="sched-log-time">{{ fmtDate(log.startedAt) }}</span>
              <span class="sched-log-meta">
                <span>{{ t('schedule.detail.duration', { duration: fmtDuration(log) }) }}</span>
                <span v-if="log.exitCode !== null">{{
                  t('schedule.detail.exit', { code: log.exitCode })
                }}</span>
              </span>
            </div>
            <div class="sched-log-row">
              <span class="sched-log-label">{{ t('schedule.detail.started.label') }}</span>
              <span class="sched-log-val">{{ fmtDate(log.startedAt) }}</span>
            </div>
            <div class="sched-log-row">
              <span class="sched-log-label">{{ t('schedule.detail.finished.label') }}</span>
              <span class="sched-log-val">{{
                log.finishedAt === null ? t('schedule.detail.running') : fmtDate(log.finishedAt)
              }}</span>
            </div>
            <pre v-if="log.output" class="sched-log-output">{{ log.output }}</pre>
            <pre v-if="log.error" class="sched-log-error">{{ log.error }}</pre>

            <!-- Session transcript entry: only for llm (prompt) executions. -->
            <template v-if="isLlm">
              <button type="button" class="sched-session-toggle" @click="toggleSession(log.id)">
                {{
                  isExpanded(log.id)
                    ? t('schedule.detail.hideSession.label')
                    : t('schedule.detail.viewSession.label')
                }}
              </button>
              <div v-if="isExpanded(log.id)" class="sched-session">
                <p v-if="transcriptOf(log.id) === undefined" class="sched-session-empty">
                  {{ t('schedule.detail.loadingSession') }}
                </p>
                <p v-else-if="transcriptOf(log.id)!.length === 0" class="sched-session-empty">
                  {{ t('schedule.detail.noSessionRecord') }}
                </p>
                <ul v-else class="sched-msg-list">
                  <li
                    v-for="(item, i) in transcriptOf(log.id)"
                    :key="i"
                    class="sched-msg"
                    :class="`sched-msg--${item.kind}`"
                  >
                    <template v-if="item.kind === 'assistant' || item.kind === 'user'">
                      <span class="sched-msg-role">{{
                        item.kind === 'assistant'
                          ? t('schedule.detail.role.assistant')
                          : t('schedule.detail.role.user')
                      }}</span>
                      <pre class="sched-msg-text">{{ item.text }}</pre>
                    </template>
                    <template v-else-if="item.kind === 'tool_use'">
                      <span class="sched-msg-role">{{
                        t('schedule.detail.role.tool', { name: item.toolName })
                      }}</span>
                      <pre class="sched-msg-text">{{ fmtToolInput(item.input) }}</pre>
                    </template>
                    <template v-else-if="item.kind === 'tool_result'">
                      <span class="sched-msg-role" :class="{ 'is-error': item.isError }">
                        {{
                          item.isError
                            ? t('schedule.detail.role.resultError')
                            : t('schedule.detail.role.result')
                        }}
                      </span>
                      <pre class="sched-msg-text">{{ item.content }}</pre>
                    </template>
                    <template v-else>
                      <span class="sched-msg-notice">{{ item.text }}</span>
                    </template>
                  </li>
                </ul>
              </div>
            </template>
          </li>
        </ul>
        <p v-else class="sched-section-empty">{{ t('schedule.detail.noHistory') }}</p>
      </section>
    </template>

    <div v-else class="sched-detail-empty">
      <p>{{ t('schedule.detail.empty') }}</p>
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
.sched-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
}

/* ---- Execution history ---- */
.sched-section {
  margin-top: var(--sp-5);
}
.sched-section--first {
  margin-top: 0;
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

/* ---- Session transcript (llm executions) ---- */
.sched-session-toggle {
  align-self: flex-start;
  margin-top: var(--sp-1);
  padding: 2px 6px;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sched-session-toggle:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.sched-session {
  margin-top: var(--sp-2);
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-2);
}
.sched-session-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}
.sched-msg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sched-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sched-msg-role {
  font-size: var(--fs-badge);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--c-text-muted);
}
.sched-msg-role.is-error {
  color: var(--c-error);
}
.sched-msg--tool_use .sched-msg-role {
  color: var(--c-info, #3b82f6);
}
.sched-msg-text {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-bg, var(--c-panel));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 240px;
}
.sched-msg-notice {
  font-size: var(--fs-caption);
  font-style: italic;
  color: var(--c-text-muted);
}
</style>
