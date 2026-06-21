<script setup lang="ts">
/**
 * ScheduleList.vue — schedules view 左栏:定时任务选择列表。
 *
 * 范式对齐 IntentList / DiscussionList:纯选择列,行点击 = 选中(emit `select`,
 * activeId 高亮),联动右栏 ScheduleDetailPanel。行内仅展示标签 / 下次执行倒计时 /
 * 状态;run-now / edit / delete / enable-disable 等操作已迁移至右栏标题栏。
 * 标题右侧「+」上抛 `new-schedule`,由 App 打开创建表单;「⇤/⇥」折叠面板宽度。
 * 首次挂载后每 30s 更新下次执行倒计时。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import type { Schedule } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'

const { t } = useTypedI18n()

defineProps<{
  schedules: Schedule[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  'new-schedule': []
}>()

// Live countdown: refreshed every 30s so relative times stay current.
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

function timeLeft(ts: number | null): string {
  if (ts === null) return '—'
  const diff = ts - now.value
  if (diff <= 0) return t('schedule.list.timeLeft.dueNow')
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return t('schedule.list.timeLeft.days', { days, hours: hrs % 24 })
  if (hrs > 0) return t('schedule.list.timeLeft.hours', { hours: hrs, minutes: mins % 60 })
  if (mins > 0) return t('schedule.list.timeLeft.minutes', { minutes: mins })
  return t('schedule.list.timeLeft.lessThanMinute')
}

// 每行的标签:类型前缀 + 名称(若 config 里有)否则回退到触发摘要。
function scheduleLabel(s: Schedule): string {
  const tag = s.type === 'command' ? t('schedule.list.type.command') : t('schedule.list.type.llm')
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  return `${tag} · ${name || triggerSummary(s)}`
}

// 触发摘要:cron 任务显示 cron 表达式;event 任务显示订阅的生命周期事件。
function triggerSummary(s: Schedule): string {
  if (s.triggerType === 'event') {
    return s.eventTopic === 'run:started'
      ? t('schedule.trigger.event.started')
      : t('schedule.trigger.event.settled')
  }
  return s.cronExpression
}

// 面板展开切换(与 WorkSessionList 一致):默认窄,展开把宽度翻倍,内容始终可见。
// 持久化:跨页面切换后保持原状。
const expanded = usePersistentToggle('c3.scheduleListExpanded')
function toggleExpand(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <section class="sched-list" :class="{ expanded }">
    <div class="sched-list-head">
      <div class="sched-list-head-left">
        <button
          type="button"
          class="sched-collapse-btn"
          :title="
            expanded ? t('schedule.list.collapse.tooltip') : t('schedule.list.expand.tooltip')
          "
          :aria-pressed="expanded"
          @click="toggleExpand"
        >
          {{ expanded ? '⇤' : '⇥' }}
        </button>
        <span class="sched-list-title">{{ t('schedule.list.title.label') }}</span>
      </div>
      <button
        type="button"
        class="sched-new-btn"
        :aria-label="t('schedule.list.new.label')"
        :title="t('schedule.list.new.label')"
        @click="emit('new-schedule')"
      >
        +
      </button>
    </div>
    <div class="sched-items">
      <p v-if="schedules.length === 0" class="sched-empty">{{ t('schedule.list.empty') }}</p>
      <div
        v-for="s in schedules"
        :key="s.id"
        class="sched-item"
        :class="{ active: s.id === activeId }"
        role="button"
        tabindex="0"
        @click="emit('select', s.id)"
        @keydown.enter.prevent="emit('select', s.id)"
        @keydown.space.prevent="emit('select', s.id)"
      >
        <div class="sched-item-head">
          <span class="sched-label">{{ scheduleLabel(s) }}</span>
          <span class="sched-countdown">{{ timeLeft(s.nextRunAt) }}</span>
          <span class="sched-status" :class="s.status">{{ s.status }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sched-list {
  width: 480px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
/* 展开态:宽度翻倍,便于阅读较长的任务标题(与 .sidebar.expanded 折叠范式一致) */
.sched-list.expanded {
  width: 960px;
}
/* 窄屏回退:侧栏按视口比例收窄,避免挤压详情区 */
@media (max-width: 1024px) {
  .sched-list {
    width: min(480px, 34vw);
    min-width: 280px;
  }
  .sched-list.expanded {
    width: min(960px, 68vw);
    min-width: 450px;
  }
}
/* 移动端 drill-down:列表即当前单栏,撑满全宽(对齐 DiscussionList 范式) */
@media (max-width: 767px) {
  .sched-list,
  .sched-list.expanded {
    width: 100%;
    min-width: 0;
    border-right: 0;
  }
}
.sched-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.sched-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.sched-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  white-space: nowrap;
}
.sched-collapse-btn {
  flex-shrink: 0;
  background: var(--c-input);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.sched-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
/* 标题右侧「+」:对齐 .disc-new-btn */
.sched-new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: var(--fs-title-sm);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sched-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
}
.sched-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sched-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
}
.sched-item {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}
.sched-item:hover {
  border-color: var(--c-primary);
}
.sched-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.sched-item-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sched-label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-countdown {
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  white-space: nowrap;
}
.sched-status {
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
  flex-shrink: 0;
  text-transform: capitalize;
}
.sched-status.active {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success);
}
.sched-status.paused {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning);
}
.sched-status.error {
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error);
}
</style>
