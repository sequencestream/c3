<script setup lang="ts">
/**
 * ScheduleList.vue — schedules view 左栏:定时任务列表。
 *
 * 数据由 App 提供(读路径)。点击某行上抛 `select` 事件,由 App 切换右栏详情。
 * 首次挂载后每 30s 更新下次执行倒计时。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import type { Schedule } from '@ccc/shared/protocol'

defineProps<{
  schedules: Schedule[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
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
  if (diff <= 0) return 'Due now'
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return `in ${days}d ${hrs % 24}h`
  if (hrs > 0) return `in ${hrs}h ${mins % 60}m`
  if (mins > 0) return `in ${mins}m`
  return '< 1m'
}

// 每行的标签:类型前缀 + 名称(若 config 里有)否则回退到 cron 表达式。
function scheduleLabel(s: Schedule): string {
  const tag = s.type === 'command' ? 'Cmd' : 'LLM'
  const cfg = s.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  return `${tag} · ${name || s.cronExpression}`
}

// 面板折叠切换(与 DiscussionList 一致)。
const collapsed = ref(false)
function togglePanel(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="sched-list" :class="{ collapsed }">
    <div class="sched-list-head">
      <div class="sched-list-head-left">
        <button
          type="button"
          class="sched-collapse-btn"
          :title="collapsed ? 'Expand panel' : 'Collapse panel'"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ collapsed ? '▸' : '◂' }}
        </button>
        <span v-show="!collapsed" class="sched-list-title">Schedules</span>
      </div>
    </div>
    <div v-show="!collapsed" class="sched-items">
      <p v-if="schedules.length === 0" class="sched-empty">No schedules yet.</p>
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
  width: 420px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
.sched-list.collapsed {
  width: 60px;
}
@media (max-width: 1024px) {
  .sched-list {
    width: min(420px, 40vw);
    min-width: 300px;
  }
  .sched-list.collapsed {
    width: 60px;
    min-width: 60px;
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
  cursor: pointer;
  white-space: nowrap;
}
.sched-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
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
