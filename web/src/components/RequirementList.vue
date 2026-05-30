<script setup lang="ts">
/*
 * RequirementList.vue — 需求视图左栏:需求列表 + 状态过滤 + 行内动作。
 *
 * 数据由 App 提供;过滤器是本组件的 UI 状态,切换时上抛 `filter` 事件让 App 拉取。
 * 动作(完善/启动开发/开发详情/标记状态)经事件上抛,由 App 统一发往服务端。
 */
import { computed, ref } from 'vue'
import type { AutomationStatus, Requirement, RequirementStatus } from '@ccc/shared/protocol'

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
}>()

// Automation orchestrator UI state derived from the pushed status.
const autoRunning = computed(() => props.automation?.state === 'running')
const autoError = computed(() =>
  props.automation?.state === 'error' ? (props.automation.error ?? '出错') : null,
)
// Short status line shown to the right of the automation button.
const autoNote = computed<string>(() => {
  const a = props.automation
  if (!a) return ''
  if (a.state === 'running') {
    const cur = a.currentRequirementId
    const title = cur ? (titleById.value[cur] ?? cur) : ''
    return title ? `正在「${title}」` : '准备中…'
  }
  if (a.state === 'done')
    return a.completedIds.length ? `✅ 已完成 ${a.completedIds.length} 项` : '✅ 无可自动化需求'
  return ''
})

function toggleAutomation() {
  if (autoRunning.value) emit('stop-automation')
  else emit('start-automation')
}

// Status filter. `null` = 全部. Local UI state; changing it asks App to refetch.
const STATUS_LABELS: Record<RequirementStatus, string> = {
  draft: '草稿',
  todo: '未开始',
  in_progress: '开发中',
  done: '已完成',
  cancelled: '已取消',
}
const FILTERS: { value: RequirementStatus | null; label: string }[] = [
  { value: null, label: '全部' },
  { value: 'todo', label: '未开始' },
  { value: 'in_progress', label: '开发中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'draft', label: '草稿' },
]
const filter = ref<RequirementStatus | null>(null)

function setFilter(value: RequirementStatus | null) {
  filter.value = value
  emit('filter', value)
}

// 「全部」视图下把已完成(done)的需求稳定置底,未完成的保持原序;
// 单状态过滤时由服务端返回该状态数据,原样展示不再排序。
const displayRequirements = computed<Requirement[]>(() => {
  if (filter.value !== null) return props.requirements
  return [...props.requirements].sort(
    (a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0),
  )
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

function statusLabel(s: RequirementStatus): string {
  return STATUS_LABELS[s] ?? s
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 createdAt;月日补零两位。
function datePrefix(r: Requirement): string {
  const d = new Date(r.completedAt ?? r.createdAt)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}`
}
</script>

<template>
  <section class="req-list">
    <div class="req-list-head">
      <span class="req-list-title">需求列表</span>
      <div class="req-head-right">
        <button
          class="req-btn auto-btn"
          :class="{ running: autoRunning, error: !!autoError }"
          :title="
            autoRunning
              ? '停止自动化进程'
              : '启动自动化进程:按优先级与依赖逐个完成已勾选自动化的需求'
          "
          @click="toggleAutomation"
        >
          {{ autoRunning ? '■ 停止自动化' : '▶ 自动化' }}
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
      </div>
    </div>
    <div v-if="autoError" class="auto-status error" :title="autoError">⚠ {{ autoError }}</div>
    <div v-else-if="autoNote" class="auto-status">{{ autoNote }}</div>
    <div class="req-items">
      <p v-if="requirements.length === 0" class="req-empty">暂无需求。在右侧与助手沟通后保存。</p>
      <div v-for="r in displayRequirements" :key="r.id" class="req-item" :class="r.status">
        <div class="req-item-main">
          <div class="req-item-head">
            <label class="req-auto" title="勾选后纳入自动化进程">
              <input
                type="checkbox"
                :checked="r.automate"
                @change="emit('set-automate', r.id, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <span class="req-priority" :class="r.priority">{{ r.priority }}</span>
            <span class="req-date">{{ datePrefix(r) }}</span>
            <span class="req-title" :title="r.content">{{ r.title }}</span>
            <span class="req-status">{{ statusLabel(r.status) }}</span>
          </div>
          <div class="req-actions">
            <button v-if="r.status === 'todo'" class="req-btn" @click="emit('refine', r.id)">
              完善
            </button>
            <button v-if="r.status === 'todo'" class="req-btn primary" @click="startDev(r)">
              启动开发
            </button>
            <button
              v-if="r.lastDevSessionId"
              class="req-btn"
              @click="emit('open-dev', r.lastDevSessionId as string)"
            >
              开发详情
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'done')"
            >
              标记完成
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'cancelled')"
            >
              取消
            </button>
          </div>
        </div>
        <div v-if="unfinishedDeps(r).length" class="req-deps" title="存在未完成依赖">
          ⚠ 依赖未完成:{{
            unfinishedDeps(r)
              .map((d) => titleById[d.id] ?? d.id)
              .join('、')
          }}
        </div>
      </div>
    </div>
  </section>
</template>
