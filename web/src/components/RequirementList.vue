<script setup lang="ts">
/*
 * RequirementList.vue — 需求视图左栏:需求列表 + 状态过滤 + 行内动作。
 *
 * 数据由 App 提供;过滤器是本组件的 UI 状态,切换时上抛 `filter` 事件让 App 拉取。
 * 动作(完善/启动开发/开发详情/标记状态)经事件上抛,由 App 统一发往服务端。
 */
import { computed, ref } from 'vue'
import type { AutomationStatus, Requirement, RequirementStatus } from '@ccc/shared/protocol'
import {
  compareByCompletion,
  formatDate,
  formatDependsOn,
  panelToggleLabel,
  reqRunStatusLabel,
  rowVisibility,
  showRunStatus,
  statusLabel,
} from '../lib/req-list-view'

const props = defineProps<{
  project: string
  requirements: Requirement[]
  automation: AutomationStatus | null
}>()

const emit = defineEmits<{
  filter: [status: RequirementStatus | null]
  refine: [requirementId: string]
  'start-dev': [requirementId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [requirementId: string, status: RequirementStatus]
  'set-automate': [requirementId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-requirement': []
}>()

// Automation orchestrator UI state derived from the pushed status.
const autoRunning = computed(() => props.automation?.state === 'running')
const autoError = computed(() =>
  props.automation?.state === 'error' ? (props.automation.error ?? 'Error') : null,
)
// Short status line shown to the right of the automation button.
const autoNote = computed<string>(() => {
  const a = props.automation
  if (!a) return ''
  if (a.state === 'running') {
    const cur = a.currentRequirementId
    const title = cur ? (titleById.value[cur] ?? cur) : ''
    if (a.awaitingPermission)
      return title ? `⏸ Awaiting authorization for "${title}"` : '⏸ Awaiting authorization'
    return title ? `Working on "${title}"` : 'Preparing…'
  }
  if (a.state === 'done')
    return a.completedIds.length
      ? `✅ Completed ${a.completedIds.length} item(s)`
      : '✅ No requirements to automate'
  return ''
})

function toggleAutomation() {
  if (autoRunning.value) emit('stop-automation')
  else emit('start-automation')
}

// Status filter. `null` = All. Local UI state; changing it asks App to refetch.
const FILTERS: { value: RequirementStatus | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'draft', label: 'Draft' },
]
const filter = ref<RequirementStatus | null>(null)

function setFilter(value: RequirementStatus | null) {
  filter.value = value
  emit('filter', value)
}

// 「全部」视图:活跃项(draft/todo/in_progress)保持服务端原序置顶,
// 终止态项(done/cancelled)置底,按完成/取消时间倒序+优先级排序。
// 「已完成」筛选视图:整列在客户端按同样规则重排。
// 其它单状态筛选:由服务端返回该状态数据,原样展示不再排序。
const displayRequirements = computed<Requirement[]>(() => {
  if (filter.value === 'done') return [...props.requirements].sort(compareByCompletion)
  if (filter.value !== null) return props.requirements
  const pending = props.requirements.filter((r) => r.status !== 'done' && r.status !== 'cancelled')
  const terminated = props.requirements
    .filter((r) => r.status === 'done' || r.status === 'cancelled')
    .sort(compareByCompletion)
  return [...pending, ...terminated]
})

// Title lookup so a dependency id can show its requirement's title in a hint.
const titleById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of props.requirements) out[r.id] = r.title
  return out
})

// Requirements this one depends on that aren't `done` yet (the unfinished set).
function unfinishedDeps(r: Requirement): Requirement[] {
  const byId = new Map(props.requirements.map((x) => [x.id, x]))
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Requirement => !!x && x.status !== 'done')
}

function startDev(r: Requirement) {
  emit('start-dev', r.id, unfinishedDeps(r).length > 0)
}

// 手风琴展开状态:记录当前展开项的 id,null 表示全部收起;天然保证至多一项展开。
const expandedId = ref<string | null>(null)

function toggleDetail(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

// 面板折叠态:本地 UI 状态(同 expandedId 范式)。收缩态收窄面板并隐藏模块名/操作区。
const collapsed = ref(false)
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))
const rowVis = computed(() => rowVisibility(collapsed.value))

function togglePanel(): void {
  collapsed.value = !collapsed.value
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 createdAt;月日补零两位。
function datePrefix(r: Requirement): string {
  return formatDate(r.completedAt ?? r.createdAt, { style: 'short' })
}
</script>

<template>
  <section class="req-list" :class="{ collapsed }">
    <div class="req-list-head">
      <div class="req-list-head-left">
        <button
          type="button"
          class="req-collapse-btn"
          :title="toggleLabel.title"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ toggleLabel.icon }}
        </button>
        <span class="req-list-title">Requirements</span>
      </div>
      <div class="req-head-right">
        <button
          class="req-btn auto-btn"
          :class="{ running: autoRunning, error: !!autoError }"
          :title="
            autoRunning
              ? 'Stop the automation process'
              : 'Start automation: complete the requirements marked for automation one by one, by priority and dependencies'
          "
          @click="toggleAutomation"
        >
          {{ autoRunning ? '■ Stop automation' : '▶ Automation' }}
        </button>
        <select
          class="req-filter"
          :value="filter ?? ''"
          @change="
            setFilter((($event.target as HTMLSelectElement).value as RequirementStatus) || null)
          "
        >
          <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">{{ f.label }}</option>
        </select>
        <button
          type="button"
          class="req-new-btn"
          aria-label="New requirement: start a new chat session"
          title="New requirement: start a new chat session"
          @click="emit('new-requirement')"
        >
          +
        </button>
      </div>
    </div>
    <div v-if="autoError" class="auto-status error" :title="autoError">⚠ {{ autoError }}</div>
    <div v-else-if="autoNote" class="auto-status">{{ autoNote }}</div>
    <div class="req-items">
      <p v-if="requirements.length === 0" class="req-empty">
        No requirements yet. Chat with the assistant on the right and save them.
      </p>
      <div v-for="r in displayRequirements" :key="r.id" class="req-item" :class="r.status">
        <div
          class="req-item-main"
          role="button"
          tabindex="0"
          :aria-expanded="r.id === expandedId"
          @click="toggleDetail(r.id)"
          @keydown.enter.prevent="toggleDetail(r.id)"
          @keydown.space.prevent="toggleDetail(r.id)"
        >
          <div class="req-item-head">
            <span
              class="req-chevron"
              :class="{ 'req-chevron--open': r.id === expandedId }"
              aria-hidden="true"
              >▸</span
            >
            <span class="req-priority" :class="r.priority">{{ r.priority }}</span>
            <span class="req-date">{{ datePrefix(r) }}</span>
            <span v-if="rowVis.showModule && r.module" class="req-module" :title="r.module">{{
              r.module
            }}</span>
            <span class="req-title" :title="r.content">{{ r.title }}</span>
            <span class="req-status" :class="r.status">{{ statusLabel(r.status) }}</span>
            <span v-if="showRunStatus(r.runStatus)" class="req-run-status" :class="r.runStatus">{{
              reqRunStatusLabel(r.runStatus)
            }}</span>
          </div>
          <div v-if="rowVis.showActions" class="req-actions" @click.stop>
            <button v-if="r.status === 'todo'" class="req-btn" @click="emit('refine', r.id)">
              Refine
            </button>
            <button v-if="r.status === 'todo'" class="req-btn primary" @click="startDev(r)">
              Start dev
            </button>
            <button
              v-if="r.lastDevSessionId"
              class="req-btn"
              @click="emit('open-dev', r.lastDevSessionId as string)"
            >
              Dev details
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'done')"
            >
              Mark done
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'cancelled')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="req-automate"
              :class="{ active: r.automate }"
              :title="r.automate ? 'in auto queue' : 'manual trigger mode'"
              :aria-pressed="r.automate"
              @click.stop="emit('set-automate', r.id, !r.automate)"
            >
              {{ r.automate ? '⏳' : '✋' }}
            </button>
          </div>
        </div>
        <div v-if="r.id === expandedId" class="req-detail">{{ r.content }}</div>
        <div v-if="r.id === expandedId" class="req-meta">
          <span class="req-meta-item">Created: {{ formatDate(r.createdAt) }}</span>
          <span v-if="r.completedAt" class="req-meta-item"
            >Completed: {{ formatDate(r.completedAt) }}</span
          >
          <span v-if="formatDependsOn(r, props.requirements).length" class="req-meta-item">
            Depends on:
            <span
              v-for="(dep, di) in formatDependsOn(r, props.requirements)"
              :key="dep.id"
              :class="dep.done ? 'req-dep-done' : 'req-dep-pending'"
            >
              {{ di > 0 ? ', ' : '' }}{{ dep.title }}{{ dep.done ? '' : ' ⚠' }}
            </span>
          </span>
        </div>
        <div v-if="unfinishedDeps(r).length" class="req-deps" title="Has unfinished dependencies">
          ⚠ Unfinished dependencies:{{
            unfinishedDeps(r)
              .map((d) => titleById[d.id] ?? d.id)
              .join(', ')
          }}
        </div>
      </div>
    </div>
  </section>
</template>
