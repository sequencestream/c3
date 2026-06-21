<script setup lang="ts">
/*
 * ScheduleDetailPanel.vue — schedules 视图右栏容器(常驻标题栏 + 详情/历史 Tab)。
 *
 * 范式对齐 IntentDetail:左列表选中一个 schedule 后,右栏常驻显示其标题栏与 Tab。
 *  - 标题栏:左为选中 schedule 名称(name 或触发摘要回退),右端为迁移自原列表行内的
 *    操作 —— run-now / edit / delete(ConfirmDialog 二次确认) / enable-disable 开关。
 *    操作均作用于当前选中 schedule,emit 契约与原逐行事件一致。
 *  - 「详情」Tab(默认):渲染 ScheduleDetail(vendor / mode / toolAllowlist 读写分类)。
 *  - 「历史」Tab:自动选择最新执行并渲染 ExecutionDetail,也可经 ExecutionHistoryDialog 改选。
 *
 * 切换选中 schedule 时复位到「详情」Tab 并关闭历史弹框;已选执行的清空由控制层
 * onSelectSchedule 负责。数据与 select-execution / load-session 契约不变,无服务端改动。
 */
import { computed, ref, watch } from 'vue'
import type {
  Schedule,
  ScheduleExecutionLog,
  ToolManifestEntry,
  TranscriptItem,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import ScheduleDetail from '../ScheduleDetail/ScheduleDetail.vue'
import ExecutionDetail from '../ExecutionDetail/ExecutionDetail.vue'
import ExecutionHistoryDialog from '../ExecutionHistoryDialog/ExecutionHistoryDialog.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  schedule: Schedule | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
  logs: ScheduleExecutionLog[]
  /** 当前选中的执行 ID */
  executionId: string | null
  /** 当前选中的执行对象 */
  execution: ScheduleExecutionLog | null
  transcripts: Record<string, TranscriptItem[]>
}>()

const emit = defineEmits<{
  'edit-schedule': [schedule: Schedule]
  'delete-schedule': [id: string]
  'toggle-enabled': [id: string, enabled: boolean]
  'run-now': [id: string]
  'select-execution': [id: string]
  'load-session': [executionId: string]
  'update-cron': [id: string, cronExpression: string]
}>()

// ---- 标题栏:选中 schedule 名称(name 或触发摘要回退) ----
const title = computed(() => {
  const s = props.schedule
  if (!s) return ''
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

// enable/disable 开关:启用态 = status==='active';error/paused 视为未启用。
const isEnabled = computed(() => props.schedule?.status === 'active')

function toggleEnabled(): void {
  if (props.schedule) emit('toggle-enabled', props.schedule.id, !isEnabled.value)
}
function runNow(): void {
  if (props.schedule) emit('run-now', props.schedule.id)
}
function editSchedule(): void {
  if (props.schedule) emit('edit-schedule', props.schedule)
}

// 删除:硬删除且级联清除执行历史,不可撤销,故 ConfirmDialog 二次确认(含任务名)。
const pendingDelete = ref(false)
function requestDelete(): void {
  pendingDelete.value = true
}
function confirmDelete(): void {
  if (props.schedule) emit('delete-schedule', props.schedule.id)
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
  { id: TAB_DETAIL, label: t('schedule.tab.detail') },
  { id: TAB_HISTORY, label: t('schedule.tab.history') },
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

// 切换选中 schedule:复位到「详情」Tab 并关闭历史弹框(已选执行的清空在控制层)。
watch(
  () => props.schedule?.id,
  () => {
    activeTab.value = TAB_DETAIL
    historyDialogOpen.value = false
  },
)
</script>

<template>
  <section class="sched-panel" data-testid="schedule-detail-panel">
    <!-- 未选中 schedule:空态 -->
    <p v-if="!schedule" class="sched-panel-empty" data-testid="schedule-detail-empty">
      {{ t('schedule.detail.empty') }}
    </p>

    <template v-else>
      <!-- 常驻标题栏:名称 + 右端操作 -->
      <header class="sched-panel-head">
        <h2 class="sched-panel-title" :title="title">{{ title }}</h2>
        <div class="sched-panel-actions" data-testid="schedule-panel-actions">
          <!-- Exec Now:手动触发一次执行;仅 active 时可用。 -->
          <button
            type="button"
            class="sp-action sp-action--run"
            :disabled="!isEnabled"
            :title="
              isEnabled
                ? t('schedule.list.runNow.tooltip')
                : t('schedule.list.runNow.disabledTooltip')
            "
            @click="runNow"
          >
            ▶
          </button>
          <!-- 编辑:打开 ScheduleForm 编辑模式弹框。 -->
          <button
            type="button"
            class="sp-action"
            :title="t('schedule.list.edit.tooltip')"
            @click="editSchedule"
          >
            ✎
          </button>
          <!-- 删除:硬删除 + 级联执行历史,经二次确认后才上抛。 -->
          <button
            type="button"
            class="sp-action sp-action--delete"
            :title="t('schedule.list.delete.tooltip')"
            :aria-label="t('schedule.list.delete.tooltip')"
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
                ? t('schedule.list.toggle.enabled.tooltip')
                : t('schedule.list.toggle.disabled.tooltip')
            "
            @click="toggleEnabled"
          >
            <span class="sp-toggle-knob" aria-hidden="true" />
          </button>
        </div>
      </header>

      <!-- Tab 条 -->
      <nav class="sched-panel-tabs" data-testid="schedule-panel-tabs">
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
        <ScheduleDetail
          :schedule="schedule"
          :tool-manifest="toolManifest"
          @update-cron="
            (id: string, cronExpression: string) => emit('update-cron', id, cronExpression)
          "
        />
      </div>

      <!-- Tab: 历史 -->
      <div v-else class="sched-panel-history">
        <div class="sched-history-bar">
          <button
            type="button"
            class="sp-history-browse"
            data-testid="history-browse"
            @click="openHistoryDialog"
          >
            {{ t('schedule.history.browse.label') }}
          </button>
        </div>
        <!-- 已选执行:渲染执行详情 -->
        <ExecutionDetail
          v-if="execution"
          :execution="execution"
          :execution-type="schedule.type"
          :transcripts="transcripts"
          @load-session="(id: string) => emit('load-session', id)"
        />
        <!-- 未选执行:提示从弹框选择 -->
        <p v-else class="sched-history-empty">{{ t('schedule.history.tabEmpty') }}</p>
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
      :title="t('schedule.list.delete.title')"
      :message="schedule ? t('schedule.list.delete.confirm', { name: title }) : ''"
      :confirm-label="t('common.action.delete.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
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
  border-bottom: 1px solid var(--c-border);
}
.sp-history-browse {
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
</style>
