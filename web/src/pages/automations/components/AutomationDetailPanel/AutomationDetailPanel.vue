<script setup lang="ts">
/*
 * AutomationDetailPanel.vue — automations 视图右栏容器(常驻标题栏 + 详情/历史 Tab)。
 *
 * 范式对齐 IntentDetail:左列表选中一个 automation 后,右栏常驻显示其标题栏与 Tab。
 *  - 标题栏:左为选中 automation 名称(name 或触发摘要回退),右端为迁移自原列表行内的
 *    操作 —— run-now / delete(ConfirmDialog 二次确认) / enable-disable 开关。
 *    操作均作用于当前选中 automation,emit 契约与原逐行事件一致。
 *  - 「详情」Tab(默认):渲染 AutomationDetail(vendor / mode / toolAllowlist 读写分类)。
 *  - 「历史」Tab:自动选择最新执行并渲染 ExecutionDetail,也可经 ExecutionHistoryDialog 改选。
 *
 * 切换选中 automation 时复位到「详情」Tab 并关闭历史弹框;已选执行的清空由控制层
 * onSelectAutomation 负责。数据与 select-execution / load-session 契约不变,无服务端改动。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import type {
  AgentConfig,
  Automation,
  AutomationExecutionLog,
  ClientToServer,
  ToolManifestEntry,
  TranscriptItem,
} from '@ccc/shared/protocol'

/** The simulate-trigger payload (client message minus its `type` tag). */
type SimulateInput = Omit<Extract<ClientToServer, { type: 'simulate_automation_trigger' }>, 'type'>
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import AutomationDetail from '../AutomationDetail/AutomationDetail.vue'
import ExecutionDetail from '../ExecutionDetail/ExecutionDetail.vue'
import ExecutionHistoryDialog from '../ExecutionHistoryDialog/ExecutionHistoryDialog.vue'

const { t, d } = useTypedI18n()

const props = defineProps<{
  automation: Automation | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
  agents: AgentConfig[]
  logs: AutomationExecutionLog[]
  /** 当前选中的执行 ID */
  executionId: string | null
  /** 当前选中的执行对象 */
  execution: AutomationExecutionLog | null
  transcripts: Record<string, TranscriptItem[]>
  /** 最近一次模拟触发的结果(null=尚未运行)。 */
  simulationResult: {
    automationId: string
    matched: boolean
    breakdown: { name: string; passed: boolean }[]
  } | null
}>()

const emit = defineEmits<{
  'edit-automation': [id: string]
  'delete-automation': [id: string]
  'toggle-enabled': [id: string, enabled: boolean]
  'run-now': [id: string]
  'select-execution': [id: string]
  'load-session': [executionId: string]
  simulate: [input: SimulateInput]
}>()

// ---- 标题栏:选中 automation 名称(name 或触发摘要回退) ----
const title = computed(() => {
  const s = props.automation
  if (!s) return ''
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  const fallback =
    s.triggerType === 'event'
      ? s.eventTopic === 'run:started'
        ? t('automation.trigger.event.started')
        : t('automation.trigger.event.settled')
      : s.cronExpression
  return name || fallback
})

// enable/disable 开关:启用态 = status==='active';error/paused 视为未启用。
const isEnabled = computed(() => props.automation?.status === 'active')
// Manual execution is independent of automatic scheduling: paused automations
// remain paused after the one-off run; archived automations are terminal.
const canRunNow = computed(() => props.automation?.status !== 'archived')

function toggleEnabled(): void {
  if (props.automation) emit('toggle-enabled', props.automation.id, !isEnabled.value)
}
// ---- 手动启动:遮罩 + 自动跳转历史 ----
// 点击 ▶ 后立即以全屏遮罩展示「启动中」,固定停留 2s 防闪烁;随后切到「历史」Tab 并
// 选中最新一笔执行(即刚触发的这次)。若届时新执行日志尚未到达,由下方 logs 首行 watch 补选。
const RUN_OVERLAY_MS = 2000
const runOverlayVisible = ref(false)
const pendingRunReveal = ref(false)
let runOverlayTimer: ReturnType<typeof setTimeout> | null = null
// 触发手动启动前的首条执行 id;用于辨别遮罩后到达的"新执行"是否确为这次启动所产生,
// 避免新执行尚未落库时误选旧的首条并提前结束补选。
let runBaselineLogId: string | null = null

function revealLatestExecution(): void {
  const latest = props.logs[0]?.id
  if (!latest || latest === runBaselineLogId) return
  emit('select-execution', latest)
  pendingRunReveal.value = false
}

function cancelRunOverlay(): void {
  if (runOverlayTimer) {
    clearTimeout(runOverlayTimer)
    runOverlayTimer = null
  }
  runOverlayVisible.value = false
  pendingRunReveal.value = false
}

function runNow(): void {
  if (!props.automation) return
  emit('run-now', props.automation.id)
  cancelRunOverlay()
  runBaselineLogId = props.logs[0]?.id ?? null
  runOverlayVisible.value = true
  runOverlayTimer = setTimeout(() => {
    runOverlayTimer = null
    runOverlayVisible.value = false
    activeTab.value = TAB_HISTORY
    // 切到历史后尝试展示这次启动的新执行;尚未到达则置 pending,由下方 watch 补选。
    pendingRunReveal.value = true
    revealLatestExecution()
  }, RUN_OVERLAY_MS)
}

// 启动后新执行可能稍晚于遮罩到达:日志首行变化时补选刚触发的执行。
watch(
  () => props.logs[0]?.id,
  () => {
    if (pendingRunReveal.value) revealLatestExecution()
  },
)

onUnmounted(cancelRunOverlay)

// 删除:硬删除且级联清除执行历史,不可撤销,故 ConfirmDialog 二次确认(含任务名)。
const pendingDelete = ref(false)
function requestDelete(): void {
  pendingDelete.value = true
}
function confirmDelete(): void {
  if (props.automation) emit('delete-automation', props.automation.id)
  pendingDelete.value = false
}
function cancelDelete(): void {
  pendingDelete.value = false
}

// ---- Tab 当前态 ----
const TAB_DETAIL = 'detail'
const TAB_HISTORY = 'history'
type SchedTab = typeof TAB_DETAIL | typeof TAB_HISTORY
const activeTab = ref<SchedTab>(TAB_DETAIL)

const tabs = computed<{ id: SchedTab; label: string }[]>(() => [
  { id: TAB_DETAIL, label: t('automation.tab.detail') },
  { id: TAB_HISTORY, label: t('automation.tab.history') },
])

function switchTab(id: SchedTab): void {
  activeTab.value = id
}

// 进入历史页时默认展示最近一笔记录。日志按 startedAt 倒序，且已有选择不得被覆盖；
// 同时监听首行变化，以覆盖首次进入时日志尚未到达的异步详情加载。
watch(
  () => [activeTab.value, props.executionId, props.logs[0]?.id] as const,
  ([tab, executionId, latestExecutionId]) => {
    if (tab === TAB_HISTORY && !executionId && latestExecutionId) {
      emit('select-execution', latestExecutionId)
    }
  },
)

// ---- 历史选择弹框 ----
const historyDialogOpen = ref(false)
function openHistoryDialog(): void {
  historyDialogOpen.value = true
}

const selectedExecutionSummary = computed(() => {
  const execution = props.execution
  if (!execution) return null
  return {
    id: execution.id,
    startedAt: d(execution.startedAt, 'datetime'),
  }
})

// 切换选中 automation:复位到「详情」Tab 并关闭历史弹框(已选执行的清空在控制层)。
watch(
  () => props.automation?.id,
  () => {
    activeTab.value = TAB_DETAIL
    historyDialogOpen.value = false
    cancelRunOverlay()
  },
)
</script>

<template>
  <section class="sched-panel" data-testid="automation-detail-panel">
    <!-- 未选中 automation:空态 -->
    <p v-if="!automation" class="sched-panel-empty" data-testid="automation-detail-empty">
      {{ t('automation.detail.empty') }}
    </p>

    <template v-else>
      <!-- 常驻标题栏:名称 + 右端操作 -->
      <header class="sched-panel-head">
        <h2 class="sched-panel-title" :title="title">{{ title }}</h2>
        <div class="sched-panel-actions" data-testid="automation-panel-actions">
          <!-- Exec Now:手动触发一次执行;active/paused 可用,archived 不可用。 -->
          <button
            type="button"
            class="sp-action sp-action--run"
            :disabled="!canRunNow"
            :title="
              canRunNow
                ? t('automation.list.runNow.tooltip')
                : t('automation.list.runNow.disabledTooltip')
            "
            @click="runNow"
          >
            ▶
          </button>
          <!-- 删除:硬删除 + 级联执行历史,经二次确认后才上抛。 -->
          <!-- 编辑:在 AutomationForm 弹框中编辑当前 automation。 -->
          <button
            type="button"
            class="sp-action sp-action--edit"
            :title="t('automation.list.edit.tooltip')"
            :aria-label="t('automation.list.edit.tooltip')"
            @click="emit('edit-automation', automation!.id)"
          >
            ✎
          </button>
          <!-- 删除:硬删除 + 级联执行历史,经二次确认后才上抛。 -->
          <button
            type="button"
            class="sp-action sp-action--delete"
            :title="t('automation.list.delete.tooltip')"
            :aria-label="t('automation.list.delete.tooltip')"
            @click="requestDelete"
          >
            🗑
          </button>
          <!-- enable/disable 开关:on=active。 -->
          <button
            type="button"
            class="sp-toggle"
            role="switch"
            :class="{ on: isEnabled }"
            :aria-checked="isEnabled"
            :title="
              isEnabled
                ? t('automation.list.toggle.enabled.tooltip')
                : t('automation.list.toggle.disabled.tooltip')
            "
            @click="toggleEnabled"
          >
            <span class="sp-toggle-knob" aria-hidden="true" />
          </button>
        </div>
      </header>

      <!-- Tab 条 -->
      <nav class="sched-panel-tabs" data-testid="automation-panel-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="sched-panel-tab"
          :class="{ active: activeTab === tab.id }"
          :data-tab="tab.id"
          :aria-pressed="activeTab === tab.id"
          @click="switchTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!-- Tab: 详情 -->
      <div v-if="activeTab === TAB_DETAIL" class="sched-panel-body">
        <AutomationDetail
          :automation="automation"
          :tool-manifest="toolManifest"
          :agents="agents"
          :simulation-result="simulationResult"
          @simulate="(input: SimulateInput) => emit('simulate', input)"
        />
      </div>

      <!-- Tab: 历史 -->
      <div v-else class="sched-panel-history">
        <div class="sched-history-bar">
          <div
            v-if="selectedExecutionSummary"
            class="sched-history-selection"
            data-testid="history-selected-execution"
            :title="`${selectedExecutionSummary.id} · ${selectedExecutionSummary.startedAt}`"
          >
            <span class="sched-history-selection-id">{{ selectedExecutionSummary.id }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ selectedExecutionSummary.startedAt }}</span>
          </div>
          <button
            type="button"
            class="sp-history-browse"
            data-testid="history-browse"
            @click="openHistoryDialog"
          >
            {{ t('automation.history.browse.label') }}
          </button>
        </div>
        <!-- 已选执行:渲染执行详情 -->
        <ExecutionDetail
          v-if="execution"
          :execution="execution"
          :execution-type="automation.type"
          :transcripts="transcripts"
          @load-session="(id: string) => emit('load-session', id)"
        />
        <!-- 未选执行:提示从弹框选择 -->
        <p v-else class="sched-history-empty">{{ t('automation.history.tabEmpty') }}</p>
      </div>
    </template>

    <!-- 历史选择弹框:在完整日志上做纯前端分页(默认 5/页)。 -->
    <ExecutionHistoryDialog
      :open="historyDialogOpen"
      :logs="logs"
      :active-execution-id="executionId"
      @select-execution="(id: string) => emit('select-execution', id)"
      @close="historyDialogOpen = false"
    />

    <!-- 删除二次确认弹窗:任务名注入正文,危险色确认按钮强调不可逆。 -->
    <ConfirmDialog
      :open="pendingDelete"
      :title="t('automation.list.delete.title')"
      :message="automation ? t('automation.list.delete.confirm', { name: title }) : ''"
      :confirm-label="t('common.action.delete.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <!-- 手动启动遮罩:阻断交互约 2s,随后自动切到「历史」Tab 展示最新一笔执行。 -->
    <div
      v-if="runOverlayVisible"
      class="sched-run-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      :aria-label="t('automation.runOverlay.title')"
      data-testid="automation-run-overlay"
    >
      <div class="sched-run-panel">
        <span class="sched-run-spinner" aria-hidden="true" />
        <span class="sched-run-title">{{ t('automation.runOverlay.title') }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sched-panel {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  color: var(--c-text);
  overflow: hidden;
}

.sched-panel-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
}

/* ---- 标题栏 ---- */
.sched-panel-head {
  flex-shrink: 0;
  min-height: 44px;
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border-bottom: 1px solid var(--c-border);
}
.sched-panel-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-title-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-panel-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sp-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  font-size: var(--fs-caption);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.sp-action:hover:not(:disabled) {
  color: var(--c-text);
  background: var(--c-hover);
}
.sp-action--run:hover:not(:disabled) {
  color: var(--c-success);
  border-color: var(--c-success);
}
.sp-action--edit:hover:not(:disabled) {
  color: var(--c-primary);
  border-color: var(--c-primary);
}
.sp-action--delete:hover:not(:disabled) {
  color: var(--c-error);
  border-color: var(--c-error);
}
.sp-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* enable/disable 开关:小型 pill 滑块,on=绿色 active。 */
.sp-toggle {
  flex-shrink: 0;
  position: relative;
  width: 32px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  cursor: pointer;
  transition: background 0.15s ease;
}
.sp-toggle.on {
  background: var(--c-success);
  border-color: var(--c-success);
}
.sp-toggle-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.sp-toggle.on .sp-toggle-knob {
  transform: translateX(14px);
}

/* ---- Tab 条 ---- */
.sched-panel-tabs {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--c-border);
  padding: 0 var(--sp-2);
}
.sched-panel-tab {
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
.sched-panel-tab:hover {
  color: var(--c-text);
}
.sched-panel-tab.active {
  color: var(--c-primary);
  border-bottom-color: var(--c-primary);
}

/* ---- Tab 内容 ---- */
.sched-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sched-panel-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sched-history-bar {
  flex-shrink: 0;
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.sched-history-selection {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
}
.sched-history-selection-id {
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-history-browse {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sp-history-browse:hover {
  background: var(--c-hover);
  border-color: var(--c-primary);
}
.sched-history-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
  margin: 0;
}

/* ---- 手动启动遮罩 ---- */
/* 全屏阻断层:盖住所有内容并吃掉点击(z-index 低于全局 toast 1000)。 */
.sched-run-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1px);
}
.sched-run-panel {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4) var(--sp-5);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.sched-run-title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--c-text);
}
.sched-run-spinner {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: sched-run-spin 0.7s linear infinite;
}
@keyframes sched-run-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sched-run-spinner {
    animation-duration: 1.6s;
  }
}
</style>
