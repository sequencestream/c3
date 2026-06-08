<script setup lang="ts">
/**
 * ExecutionDetail.vue — schedules 视图右栏:选中执行的 Tab 化详情面板。
 *
 * Tabs:
 *  - 「执行信息」(始终): status / 起止时间 / 耗时 / 退出码 / output / error。
 *    llm 类型在本 Tab 内保留旧的 inline session 展开/transcript 渲染(后续 Session Tab 替换)。
 *  - 「Command 日志」(仅 command 类型): command 执行的 shell 输出,终端式全宽渲染。
 *
 * 数据流:execution 由 App.vue 经 Schedules.vue 传入;transcripts 与 load-session
 * 保留旧 inline session 功能,由 ScheduleDetail.vue 迁入。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import type { ScheduleExecutionLog, TranscriptItem } from '@ccc/shared/protocol'
import SessionTitleBar from '../../../../components/SessionTitleBar/SessionTitleBar.vue'
import { useTypedI18n } from '@/i18n'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 当前选中的执行日志, null 表示未选中 */
    execution: ScheduleExecutionLog | null
    /** 执行的任务类型: command | llm;null 表示未选中无类型 */
    executionType: 'command' | 'llm' | null
    /** Agent-session transcripts keyed by executionId(保留旧 inline session 功能) */
    transcripts?: Record<string, TranscriptItem[]>
  }>(),
  { transcripts: () => ({}) },
)

const emit = defineEmits<{
  /** 请求一次执行的 transcript;父级填充 transcripts[executionId] 后重渲染 */
  'load-session': [executionId: string]
}>()

// ---- 当前 Tab ----
const TAB_EXEC_INFO = 'exec-info'
const TAB_COMMAND_LOG = 'command-log'
const activeTab = ref(TAB_EXEC_INFO)

// command 类型显示两个 Tab, llm 类型只显示「执行信息」。
const tabs = computed(() => {
  if (props.executionType === 'command') {
    return [
      { id: TAB_EXEC_INFO, label: t('schedule.execution.tab.execInfo') },
      { id: TAB_COMMAND_LOG, label: t('schedule.execution.tab.commandLog') },
    ]
  }
  // llm (或 null) 只显示执行信息 Tab
  return [{ id: TAB_EXEC_INFO, label: t('schedule.execution.tab.execInfo') }]
})

// 切换 Tab 时若当前 tab 不在可用列表内则重设
function switchTab(id: string): void {
  activeTab.value = id
}

// ---- 旧 inline session 功能(从 ScheduleDetail 迁入,保留至 Session Tab 落地) ----
const isLlm = computed(() => props.executionType === 'llm')
const expandedSessions = ref<Set<string>>(new Set())

function isExpanded(id: string): boolean {
  return expandedSessions.value.has(id)
}

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

function fmtToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

// ---- 时间格式化 ----
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

function logStatus(log: ScheduleExecutionLog): string {
  if (log.status) return log.status
  return log.finishedAt === null ? 'running' : 'success'
}
</script>

<template>
  <div class="exec-detail-wrap">
    <!-- 未选中执行:空态 -->
    <template v-if="!execution">
      <SessionTitleBar v-if="executionType" active-title="" :show-mode="false" />
      <div class="exec-detail-empty">
        <p>{{ t('schedule.execution.empty') }}</p>
      </div>
    </template>

    <!-- 选中执行:Tab 栏 + Tab 内容 -->
    <template v-else>
      <!-- Tab 导航栏 -->
      <div class="exec-tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="exec-tab"
          :class="{ active: activeTab === tab.id }"
          @click="switchTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab: 执行信息 -->
      <div v-if="activeTab === TAB_EXEC_INFO" class="exec-detail-body">
        <div class="exec-info-grid">
          <!-- Status -->
          <div class="exec-info-row">
            <span class="exec-info-label">{{ t('schedule.detail.history.label') }}</span>
            <span class="log-status-badge" :class="logStatus(execution)">{{
              logStatus(execution)
            }}</span>
          </div>
          <!-- Started -->
          <div class="exec-info-row">
            <span class="exec-info-label">{{ t('schedule.detail.started.label') }}</span>
            <span class="exec-info-val">{{ fmtDate(execution.startedAt) }}</span>
          </div>
          <!-- Finished -->
          <div class="exec-info-row">
            <span class="exec-info-label">{{ t('schedule.detail.finished.label') }}</span>
            <span class="exec-info-val">{{
              execution.finishedAt === null
                ? t('schedule.detail.running')
                : fmtDate(execution.finishedAt)
            }}</span>
          </div>
          <!-- Duration -->
          <div class="exec-info-row">
            <span class="exec-info-label">{{ t('schedule.execution.info.duration') }}</span>
            <span class="exec-info-val">{{ fmtDuration(execution) }}</span>
          </div>
          <!-- Exit code -->
          <div class="exec-info-row">
            <span class="exec-info-label">{{ t('schedule.execution.info.exitCode') }}</span>
            <span class="exec-info-val">{{
              execution.exitCode !== null ? String(execution.exitCode) : '—'
            }}</span>
          </div>
        </div>

        <!-- Output -->
        <div v-if="execution.output" class="exec-info-section">
          <h4 class="exec-info-section-title">{{ t('schedule.execution.info.output') }}</h4>
          <pre class="exec-output-text">{{ execution.output }}</pre>
        </div>

        <!-- Error -->
        <div v-if="execution.error" class="exec-info-section">
          <h4 class="exec-info-section-title">{{ t('schedule.execution.info.error') }}</h4>
          <pre class="exec-error-text">{{ execution.error }}</pre>
        </div>

        <!-- Session transcript (仅 llm 类型,保留旧 inline 功能) -->
        <template v-if="isLlm">
          <div class="exec-info-section">
            <button type="button" class="exec-session-toggle" @click="toggleSession(execution.id)">
              {{
                isExpanded(execution.id)
                  ? t('schedule.detail.hideSession.label')
                  : t('schedule.detail.viewSession.label')
              }}
            </button>
            <div v-if="isExpanded(execution.id)" class="exec-session">
              <p v-if="transcriptOf(execution.id) === undefined" class="exec-session-empty">
                {{ t('schedule.detail.loadingSession') }}
              </p>
              <p v-else-if="transcriptOf(execution.id)!.length === 0" class="exec-session-empty">
                {{ t('schedule.detail.noSessionRecord') }}
              </p>
              <ul v-else class="exec-msg-list">
                <li
                  v-for="(item, i) in transcriptOf(execution.id)"
                  :key="i"
                  class="exec-msg"
                  :class="`exec-msg--${item.kind}`"
                >
                  <template v-if="item.kind === 'assistant' || item.kind === 'user'">
                    <span class="exec-msg-role">{{
                      item.kind === 'assistant'
                        ? t('schedule.detail.role.assistant')
                        : t('schedule.detail.role.user')
                    }}</span>
                    <pre class="exec-msg-text">{{ item.text }}</pre>
                  </template>
                  <template v-else-if="item.kind === 'tool_use'">
                    <span class="exec-msg-role">{{
                      t('schedule.detail.role.tool', { name: item.toolName })
                    }}</span>
                    <pre class="exec-msg-text">{{ fmtToolInput(item.input) }}</pre>
                  </template>
                  <template v-else-if="item.kind === 'tool_result'">
                    <span class="exec-msg-role" :class="{ 'is-error': item.isError }">
                      {{
                        item.isError
                          ? t('schedule.detail.role.resultError')
                          : t('schedule.detail.role.result')
                      }}
                    </span>
                    <pre class="exec-msg-text">{{ item.content }}</pre>
                  </template>
                  <template v-else>
                    <span class="exec-msg-notice">{{ item.text }}</span>
                  </template>
                </li>
              </ul>
            </div>
          </div>
        </template>
      </div>

      <!-- Tab: Command 日志(仅 command 类型) -->
      <div v-if="activeTab === TAB_COMMAND_LOG" class="exec-detail-body">
        <pre v-if="execution.output" class="exec-output-text exec-output-terminal">{{
          execution.output
        }}</pre>
        <p v-else class="exec-section-empty">{{ t('schedule.execution.commandLog.empty') }}</p>
        <pre v-if="execution.error" class="exec-error-text">{{ execution.error }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 外层容器 */
.exec-detail-wrap {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  color: var(--c-text);
}

/* 空态 */
.exec-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
}

/* ---- Tab 导航栏 ---- */
.exec-tab-bar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-panel);
  padding: 0 var(--sp-2);
  gap: 0;
}
.exec-tab {
  padding: 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.exec-tab:hover {
  color: var(--c-text);
}
.exec-tab.active {
  color: var(--c-primary);
  border-bottom-color: var(--c-primary);
}

/* ---- 执行信息内容 ---- */
.exec-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/* 信息网格 */
.exec-info-grid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.exec-info-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.exec-info-label {
  color: var(--c-text-muted);
  min-width: 80px;
  flex-shrink: 0;
}
.exec-info-val {
  color: var(--c-text);
}

/* 信息区段(Output / Error) */
.exec-info-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.exec-info-section-title {
  font-size: var(--fs-body);
  font-weight: 600;
  margin: 0;
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--c-border);
}

/* 输出/错误文本 */
.exec-output-text,
.exec-error-text {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-bg, var(--c-panel));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 360px;
}
.exec-output-terminal {
  max-height: none;
  flex: 1;
  min-height: 0;
}
.exec-error-text {
  color: var(--c-error);
  border-color: rgba(239, 68, 68, 0.4);
}
.exec-section-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}

/* ---- 旧 inline session(从 ScheduleDetail 迁入) ---- */
.exec-session-toggle {
  align-self: flex-start;
  padding: 2px 6px;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.exec-session-toggle:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.exec-session {
  margin-top: var(--sp-1);
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-2);
}
.exec-session-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}
.exec-msg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.exec-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.exec-msg-role {
  font-size: var(--fs-badge);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--c-text-muted);
}
.exec-msg-role.is-error {
  color: var(--c-error);
}
.exec-msg--tool_use .exec-msg-role {
  color: var(--c-info, #3b82f6);
}
.exec-msg-text {
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
.exec-msg-notice {
  font-size: var(--fs-caption);
  font-style: italic;
  color: var(--c-text-muted);
}

/* ---- 状态 badge ---- */
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
