<script setup lang="ts">
/**
 * ScheduleList.vue — schedules view 左栏:定时任务列表。
 *
 * 数据由 App 提供(读路径)。范式对齐 IntentList / DiscussionList:
 * - 标题右侧「+」上抛 `new-schedule`,由 App 打开创建表单(写路径)。
 * - 每行 enable/disable 开关上抛 `toggle-enabled`(enabled=active,disabled=paused),
 *   由 App 映射到 update_schedule 的 status(无独立 pause/resume 协议消息)。
 * - 点击行 accordion 单开:展开行内轻量摘要,同时上抛 `select` 联动右栏 ScheduleDetail。
 * 首次挂载后每 30s 更新下次执行倒计时。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import type { Schedule } from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron } from '@ccc/shared/cron'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'

const { t, d } = useTypedI18n()

const props = defineProps<{
  schedules: Schedule[]
  activeId: string | null
  /** System IANA time zone the cron upcoming-runs are computed in. */
  timezone: string
}>()

const emit = defineEmits<{
  select: [id: string]
  'new-schedule': []
  'toggle-enabled': [id: string, enabled: boolean]
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

// 每行的标签:类型前缀 + 名称(若 config 里有)否则回退到 cron 表达式。
function scheduleLabel(s: Schedule): string {
  const tag = s.type === 'command' ? t('schedule.list.type.command') : t('schedule.list.type.llm')
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  return `${tag} · ${name || s.cronExpression}`
}

// 按系统配置时区(props.timezone)格式化,使展示口径与 cron 计算一致:
// 配 Asia/Shanghai 时 `0 11 * * *` 显示 11:00,与浏览器本地时区解耦。
function fmtDate(ts: number): string {
  return d(ts, { key: 'datetime', timeZone: props.timezone })
}

// 展开行的完整配置 JSON(美化输出);无配置时返回 "—"。
function configText(s: Schedule): string {
  const c = s.config
  if (c === null || c === undefined) return '—'
  try {
    return JSON.stringify(c, null, 2)
  } catch {
    return String(c)
  }
}

// 未来预览要展示几次执行(验收要求 3-5 次)。
const UPCOMING_COUNT = 5

// 未来 N 次执行时间:从"现在"起反复推进 cron。无效/无下次时返回空数组。
function upcomingRuns(s: Schedule): number[] {
  const cron = s.cronExpression
  if (!cron || !isValidCron(cron)) return []
  const runs: number[] = []
  let after = now.value
  for (let i = 0; i < UPCOMING_COUNT; i++) {
    try {
      const next = computeNextRunAt(cron, after, props.timezone)
      if (!Number.isFinite(next) || next <= after) break
      runs.push(next)
      after = next
    } catch {
      break
    }
  }
  return runs
}

// enable/disable 开关:启用态 = status==='active';error/paused 视为未启用。
// 切换上抛目标态(enabled),由 App 映射到 update_schedule 的 active/paused。
function isEnabled(s: Schedule): boolean {
  return s.status === 'active'
}
function toggleEnabled(s: Schedule): void {
  emit('toggle-enabled', s.id, !isEnabled(s))
}

// 手风琴展开状态:记录当前展开项的 id,null 表示全部收起;天然保证至多一项展开。
// 展开时同时 emit select,使右栏 ScheduleDetail / Edit 联动(经用户确认)。
const expandedId = ref<string | null>(null)
function toggleDetail(s: Schedule): void {
  if (expandedId.value === s.id) {
    expandedId.value = null
    return
  }
  expandedId.value = s.id
  emit('select', s.id)
}

// 面板展开切换(与 SessionList 一致):默认窄,展开把宽度翻倍,内容始终可见。
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
      >
        <div
          class="sched-item-main"
          role="button"
          tabindex="0"
          :aria-expanded="s.id === expandedId"
          @click="toggleDetail(s)"
          @keydown.enter.prevent="toggleDetail(s)"
          @keydown.space.prevent="toggleDetail(s)"
        >
          <div class="sched-item-head">
            <span
              class="sched-chevron"
              :class="{ 'sched-chevron--open': s.id === expandedId }"
              aria-hidden="true"
              >▸</span
            >
            <span class="sched-label">{{ scheduleLabel(s) }}</span>
            <span class="sched-countdown">{{ timeLeft(s.nextRunAt) }}</span>
            <span class="sched-status" :class="s.status">{{ s.status }}</span>
            <!-- enable/disable 开关:on=active。切换映射到 update_schedule 的 status。 -->
            <button
              type="button"
              class="sched-toggle"
              role="switch"
              :class="{ on: isEnabled(s) }"
              :aria-checked="isEnabled(s)"
              :title="
                isEnabled(s)
                  ? t('schedule.list.toggle.enabled.tooltip')
                  : t('schedule.list.toggle.disabled.tooltip')
              "
              @click.stop="toggleEnabled(s)"
            >
              <span class="sched-toggle-knob" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div v-if="s.id === expandedId" class="sched-detail-inline">
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.id.label') }}</span>
            <span class="sched-meta-val mono">{{ s.id }}</span>
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.type.label') }}</span>
            <span class="sched-meta-val">{{ s.type }}</span>
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.status.label') }}</span>
            <span class="sched-meta-val">{{ s.status }}</span>
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.cron.label') }}</span>
            <span class="sched-meta-val"
              ><code>{{ s.cronExpression }}</code></span
            >
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.mode.label') }}</span>
            <span class="sched-meta-val">{{ s.mcpMode }}</span>
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.created.label') }}</span>
            <span class="sched-meta-val">{{ fmtDate(s.createdAt) }}</span>
          </div>
          <div class="sched-meta-row">
            <span class="sched-meta-label">{{ t('schedule.meta.updated.label') }}</span>
            <span class="sched-meta-val">{{ fmtDate(s.updatedAt) }}</span>
          </div>
          <div class="sched-meta-row sched-meta-row--col">
            <span class="sched-meta-label">{{ t('schedule.meta.config.label') }}</span>
            <pre class="sched-meta-config">{{ configText(s) }}</pre>
          </div>

          <!-- Upcoming runs: next few execution times computed from the cron expr. -->
          <div class="sched-meta-row sched-meta-row--col">
            <span class="sched-meta-label">{{ t('schedule.meta.upcoming.label') }}</span>
            <ol v-if="upcomingRuns(s).length" class="sched-upcoming">
              <li v-for="(ts, i) in upcomingRuns(s)" :key="ts" class="sched-upcoming-item">
                <span class="sched-upcoming-dot" :class="{ next: i === 0 }" />
                <span class="sched-upcoming-time">{{ fmtDate(ts) }}</span>
                <span class="sched-upcoming-rel">{{ timeLeft(ts) }}</span>
              </li>
            </ol>
            <span v-else class="sched-meta-val">{{ t('schedule.list.noUpcoming') }}</span>
          </div>
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
/* 窄屏回退:侧栏按视口比例收窄,避免挤压聊天区 */
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
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sched-item:hover {
  border-color: var(--c-primary);
}
.sched-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.sched-item-main {
  cursor: pointer;
}
.sched-item-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sched-chevron {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  transition: transform 0.15s ease;
}
.sched-chevron--open {
  transform: rotate(90deg);
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
/* enable/disable 开关:小型 pill 滑块,on=绿色 active。 */
.sched-toggle {
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
.sched-toggle.on {
  background: var(--c-success);
  border-color: var(--c-success);
}
.sched-toggle-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.sched-toggle.on .sched-toggle-knob {
  transform: translateX(14px);
}
/* 行内展开摘要:标签-值列表,轻量呈现(完整详情在右栏 ScheduleDetail)。 */
.sched-detail-inline {
  border-radius: var(--radius-sm);
  background: var(--c-hover);
  border: 1px solid var(--c-border);
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sched-meta-row {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.sched-meta-row--col {
  flex-direction: column;
  gap: var(--sp-1);
}
.sched-meta-label {
  flex-shrink: 0;
  width: 76px;
  color: var(--c-text-muted);
}
.sched-meta-val {
  color: var(--c-text);
  word-break: break-word;
}
.sched-meta-val.mono {
  font-family: var(--ff-mono, monospace);
  color: var(--c-text-muted);
}
.sched-meta-val code {
  font-family: var(--ff-mono, monospace);
  background: var(--c-card);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
}
.sched-meta-config {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
/* Upcoming runs timeline (mirrors the former ScheduleDetail timeline). */
.sched-upcoming {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sched-upcoming-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sched-upcoming-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-text-muted);
  flex: 0 0 auto;
}
.sched-upcoming-dot.next {
  background: var(--c-success);
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}
.sched-upcoming-time {
  color: var(--c-text);
}
.sched-upcoming-rel {
  margin-left: auto;
  color: var(--c-text-muted);
}
</style>
