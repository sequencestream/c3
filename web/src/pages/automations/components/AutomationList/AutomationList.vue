<script setup lang="ts">
/**
 * AutomationList.vue — automations view 左栏:自动化选择列表。
 *
 * 范式对齐 IntentList / DiscussionList:纯选择列,行点击 = 选中(emit `select`,
 * activeId 高亮),联动右栏 AutomationDetailPanel。行内仅展示标签 / 下次执行倒计时 /
 * 状态;run-now / edit / delete / enable-disable 等操作已迁移至右栏标题栏。
 * 标题右侧「+」上抛 `new-automation`,由 App 打开创建表单;「⇤/⇥」折叠面板宽度。
 * 首次挂载后每 30s 更新下次执行倒计时。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import type { Automation } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { AUTOMATION_TEMPLATES } from '../../templates'

const { t } = useTypedI18n()

defineProps<{
  automations: Automation[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  'new-automation': []
  'new-from-template': [templateId: string]
}>()

const templatesOpen = ref(false)

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
  if (diff <= 0) return t('automation.list.timeLeft.dueNow')
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return t('automation.list.timeLeft.days', { days, hours: hrs % 24 })
  if (hrs > 0) return t('automation.list.timeLeft.hours', { hours: hrs, minutes: mins % 60 })
  if (mins > 0) return t('automation.list.timeLeft.minutes', { minutes: mins })
  return t('automation.list.timeLeft.lessThanMinute')
}

// 每行的标签:类型前缀 + 名称(若 config 里有)否则回退到触发摘要。
function automationLabel(s: Automation): string {
  const tag =
    s.type === 'command' ? t('automation.list.type.command') : t('automation.list.type.llm')
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  return `${tag} · ${name || triggerSummary(s)}`
}

// 触发摘要:cron 任务显示 cron 表达式;event 任务显示订阅的生命周期事件。
function triggerSummary(s: Automation): string {
  if (s.triggerType === 'event') {
    return s.eventTopic === 'run:started'
      ? t('automation.trigger.event.started')
      : t('automation.trigger.event.settled')
  }
  return s.cronExpression
}

// 面板展开切换(与 WorkSessionList 一致):默认窄,展开把宽度翻倍,内容始终可见。
// 持久化:跨页面切换后保持原状。
const expanded = usePersistentToggle('c3.automationListExpanded')
function toggleExpand(): void {
  expanded.value = !expanded.value
}

function selectTemplate(templateId: string): void {
  emit('new-from-template', templateId)
  templatesOpen.value = false
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
            expanded ? t('automation.list.collapse.tooltip') : t('automation.list.expand.tooltip')
          "
          :aria-pressed="expanded"
          @click="toggleExpand"
        >
          {{ expanded ? '⇤' : '⇥' }}
        </button>
        <span class="sched-list-title">{{ t('automation.list.title.label') }}</span>
      </div>
      <div class="sched-head-actions">
        <div class="sched-template-wrap">
          <button
            type="button"
            class="sched-template-btn"
            :aria-expanded="templatesOpen"
            @click="templatesOpen = !templatesOpen"
          >
            {{ t('automation.list.templates.button') }}
          </button>
          <div v-if="templatesOpen" class="sched-template-menu" role="menu">
            <button
              v-for="template in AUTOMATION_TEMPLATES"
              :key="template.id"
              type="button"
              class="sched-template-item"
              role="menuitem"
              @click="selectTemplate(template.id)"
            >
              <strong>{{ t(template.titleKey) }}</strong>
              <span>{{ t(template.descriptionKey) }}</span>
            </button>
          </div>
        </div>
        <button
          type="button"
          class="sched-new-btn"
          :aria-label="t('automation.list.new.label')"
          :title="t('automation.list.new.label')"
          @click="emit('new-automation')"
        >
          +
        </button>
      </div>
    </div>
    <div class="sched-items">
      <p v-if="automations.length === 0" class="sched-empty">{{ t('automation.list.empty') }}</p>
      <div
        v-for="s in automations"
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
          <span class="sched-label">{{ automationLabel(s) }}</span>
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
.sched-head-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sched-template-wrap {
  position: relative;
}
.sched-template-btn {
  padding: 2px 8px;
  color: var(--c-text-muted);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sched-template-menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + 4px);
  right: 0;
  width: 260px;
  padding: var(--sp-2);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.sched-template-item {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2);
  color: var(--c-text);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sched-template-item:hover {
  background: var(--c-hover);
}
.sched-template-item span {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
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
