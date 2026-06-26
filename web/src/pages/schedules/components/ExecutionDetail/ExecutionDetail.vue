<script setup lang="ts">
/**
 * ExecutionDetail.vue — schedules 视图右栏:选中执行的 Tab 化详情面板。
 *
 * Tabs:
 *  - 「执行信息」(始终): status / 起止时间 / 耗时 / 退出码 / output / error。
 *  - 「Session 会话记录」(仅 llm 类型): 通过 ChatMessages 组件渲染 transcript,
 *    复用 sessions 页的 markdown 渲染 / 工具调用批次折叠能力。ChatMessages 的
 *    内层 <main> 在本面板内通过 :deep 加大底部留白,避免最后一条消息贴底被遮盖
 *    (详见 style 中 .exec-detail-body :deep(main))。
 *  - 「Command 日志」(仅 command 类型): command 执行的 shell 输出,终端式全宽渲染。
 *
 * 数据流:execution 由 App.vue 经 Schedules.vue 传入;transcripts 与 load-session
 * 的沿用路径不变,只是渲染从旧 inline 方式改为复用 ChatMessages 组件。
 */
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import type { ScheduleExecutionLog, TranscriptItem } from '@ccc/shared/protocol'
import SessionTitleBar from '../../../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../../../components/ChatMessages/ChatMessages.vue'
import { transcriptToChat } from '@/lib/execution-view'
import { useTypedI18n } from '@/i18n'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 当前选中的执行日志, null 表示未选中 */
    execution: ScheduleExecutionLog | null
    /** 执行的任务类型: command | llm;null 表示未选中无类型 */
    executionType: 'command' | 'llm' | null
    /** Agent-session transcripts keyed by executionId */
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
const TAB_SESSION = 'session'
const TAB_COMMAND_LOG = 'command-log'
const activeTab = ref(TAB_EXEC_INFO)

const tabs = computed(() => {
  if (props.executionType === 'command') {
    return [
      { id: TAB_EXEC_INFO, label: t('schedule.execution.tab.execInfo') },
      { id: TAB_COMMAND_LOG, label: t('schedule.execution.tab.commandLog') },
    ]
  }
  // llm: 执行信息 + Session 会话记录
  return [
    { id: TAB_EXEC_INFO, label: t('schedule.execution.tab.execInfo') },
    { id: TAB_SESSION, label: t('schedule.execution.tab.session') },
  ]
})

// 切换 Tab 时若当前 tab 不在可用列表内则重设
function switchTab(id: string): void {
  activeTab.value = id
}

// ---- Session 会话 Tab: transcript → ChatMessages ----
const sessionMessages = computed(() => {
  if (!props.execution) return []
  return transcriptToChat(props.transcripts[props.execution.id])
})

/** 当切换到 Session Tab 时,若 transcript 尚未加载则触发加载 */
watch(activeTab, (tab) => {
  if (tab === TAB_SESSION && props.execution) {
    if (props.transcripts[props.execution.id] === undefined) {
      emit('load-session', props.execution.id)
    }
  }
})

/** 切换执行时重置到「执行信息」Tab */
watch(
  () => props.execution?.id,
  () => {
    activeTab.value = TAB_EXEC_INFO
  },
)

/** 当前执行的 transcript 是否正在加载(尚未返回) */
const transcriptLoading = computed(() => {
  if (!props.execution) return false
  return props.transcripts[props.execution.id] === undefined
})

/** 当前执行的 transcript 已返回但为空 */
const transcriptEmpty = computed(() => {
  if (!props.execution) return false
  const items = props.transcripts[props.execution.id]
  return items !== undefined && items.length === 0
})

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
      </div>

      <!-- Tab: Session 会话记录(仅 llm 类型) -->
      <div v-if="activeTab === TAB_SESSION" class="exec-detail-body">
        <!-- 加载中 -->
        <p v-if="transcriptLoading" class="exec-section-empty">
          {{ t('schedule.execution.session.loading') }}
        </p>
        <!-- 无记录 -->
        <p v-else-if="transcriptEmpty" class="exec-section-empty">
          {{ t('schedule.execution.session.noRecord') }}
        </p>
        <!-- 有 transcript,通过 ChatMessages 渲染 -->
        <!-- hasActiveSession=true 防止显示空态提示;actionablePermissionId=null
             使所有权限提示仅作为历史记录展示(只读,无交互)。 -->
        <ChatMessages
          v-else
          :messages="sessionMessages"
          :has-active-session="true"
          :actionable-permission-id="null"
        />
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
  /* 窄屏 Tab 溢出时可横向滑动,不撑破容器(桌面 Tab 数少不触发) */
  overflow-x: auto;
  scrollbar-width: none;
}
.exec-tab-bar::-webkit-scrollbar {
  display: none;
}
.exec-tab {
  flex-shrink: 0;
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

/* Session Tab 渲染 ChatMessages 时,其内层 <main>(全局样式 padding-bottom
   仅 --sp-4=16px)是实际滚动容器,嵌套在 .exec-detail-body 之内。16px 底部
   留白在历史会话复核场景偏局促,最后一条消息显得贴底/像被截断。此处仅在本
   面板上下文(.exec-detail-body)内增大 <main> 底部留白至 24px,拉开可辨识间距;
   作用域被 scoped 限制,不波及 ChatColumn 主聊天页的 <main>。 */
.exec-detail-body :deep(main) {
  padding-bottom: calc(var(--sp-4) + var(--sp-2));
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
