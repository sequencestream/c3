<script setup lang="ts">
/*
 * IntentList.vue — 需求视图左栏:需求列表 + 状态过滤 + 行内动作。
 *
 * 数据由 App 提供;过滤器是本组件的 UI 状态,切换时上抛 `filter` 事件让 App 拉取。
 * 动作(完善/启动开发/开发详情/标记状态)经事件上抛,由 App 统一发往服务端。
 */
import { computed, ref } from 'vue'
import type { AutomationStatus, Intent, IntentStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'
import {
  compareByCompletion,
  formatDate,
  formatDependsOn,
  panelToggleLabel,
  reqRunStatusLabel,
  rowVisibility,
  showRunStatus,
  sliceTerminated,
  statusLabel,
  TERMINAL_PAGE_SIZE,
} from '../../../../lib/intent-list-view'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  project: string
  intents: Intent[]
  automation: AutomationStatus | null
}>()

const emit = defineEmits<{
  filter: [status: IntentStatus | null]
  refine: [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-intent': []
}>()

// Automation orchestrator UI state derived from the pushed status.
const AUTO_RUNNING_STATES = new Set(['running', 'developing', 'fixing', 'awaiting_gate'])
const autoRunning = computed(
  () => props.automation && AUTO_RUNNING_STATES.has(props.automation.state),
)
const autoError = computed(() =>
  props.automation?.state === 'error'
    ? (props.automation.error ?? t('intent.automation.error.fallback'))
    : null,
)
// Short status line shown to the right of the automation button.
const autoNote = computed<string>(() => {
  const a = props.automation
  if (!a) return ''

  const cur = a.currentIntentId
  const title = cur ? (titleById.value[cur] ?? cur) : ''

  if (a.state === 'running') {
    if (a.awaitingPermission)
      return title ? t('intent.automation.awaitingFor', { title }) : t('intent.automation.awaiting')
    return title ? t('intent.automation.workingOn', { title }) : t('intent.automation.preparing')
  }
  if (a.state === 'developing')
    return title ? t('intent.automation.workingOn', { title }) : t('intent.automation.preparing')
  if (a.state === 'fixing')
    return title ? t('intent.automation.fixing', { title }) : t('intent.automation.preparing')
  if (a.state === 'awaiting_gate') return t('intent.automation.awaitingGate')
  if (a.state === 'done')
    return a.completedIds.length
      ? t('intent.automation.completedCount', a.completedIds.length)
      : t('intent.automation.nothingToAutomate')
  return ''
})

function toggleAutomation() {
  if (autoRunning.value) emit('stop-automation')
  else emit('start-automation')
}

// Status filter. `null` = All. Local UI state; changing it asks App to refetch.
const FILTERS = computed<{ value: IntentStatus | null; label: string }[]>(() => [
  { value: null, label: t('intent.filter.all.label') },
  { value: 'todo', label: t('intent.filter.todo.label') },
  { value: 'in_progress', label: t('intent.filter.inProgress.label') },
  { value: 'done', label: t('intent.filter.done.label') },
  { value: 'cancelled', label: t('intent.filter.cancelled.label') },
  { value: 'draft', label: t('intent.filter.draft.label') },
])
const filter = ref<IntentStatus | null>(null)

// 「全部」视图下终止态项的可见条数:初始一页,「加载更多」每次 +一页。
// 切换筛选时重置,避免上一视图的分页进度串到新视图(AC5)。
const visibleTerminated = ref(TERMINAL_PAGE_SIZE)

function setFilter(value: IntentStatus | null) {
  filter.value = value
  visibleTerminated.value = TERMINAL_PAGE_SIZE
  emit('filter', value)
}

function loadMoreTerminated() {
  visibleTerminated.value += TERMINAL_PAGE_SIZE
}

// 「全部」视图下排序后的终止态项(done/cancelled),按完成/取消时间倒序+优先级。
const terminatedIntents = computed<Intent[]>(() =>
  props.intents
    .filter((r) => r.status === 'done' || r.status === 'cancelled')
    .sort((a, b) => compareByCompletion(a, b, locale.value)),
)

// 「全部」视图:活跃项(draft/todo/in_progress)保持服务端原序置顶且全显,
// 终止态项置底并按 visibleTerminated 分批切片(AC1/AC2)。
// 「已完成」筛选视图:整列在客户端按同样规则重排,不分页。
// 其它单状态筛选:由服务端返回该状态数据,原样展示不再排序、不分页(AC5)。
const displayIntents = computed<Intent[]>(() => {
  if (filter.value === 'done')
    return [...props.intents].sort((a, b) => compareByCompletion(a, b, locale.value))
  if (filter.value !== null) return props.intents
  const pending = props.intents.filter((r) => r.status !== 'done' && r.status !== 'cancelled')
  const { visible } = sliceTerminated(terminatedIntents.value, visibleTerminated.value)
  return [...pending, ...visible]
})

// 终止态分页页脚:仅「全部」视图且存在终止态项时渲染。
// hasMore → 「加载更多 ↓」按钮;否则 → 「已加载完」文案(AC3/AC4)。
const terminalPaging = computed<{ hasMore: boolean } | null>(() => {
  if (filter.value !== null || terminatedIntents.value.length === 0) return null
  return { hasMore: sliceTerminated(terminatedIntents.value, visibleTerminated.value).hasMore }
})

// Title lookup so a dependency id can show its intent's title in a hint.
const titleById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of props.intents) out[r.id] = r.title
  return out
})

// Intents this one depends on that aren't `done` yet (the unfinished set).
function unfinishedDeps(r: Intent): Intent[] {
  const byId = new Map(props.intents.map((x) => [x.id, x]))
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Intent => !!x && x.status !== 'done')
}

function startDev(r: Intent) {
  emit('start-dev', r.id, unfinishedDeps(r).length > 0)
}

// 手风琴展开状态:记录当前展开项的 id,null 表示全部收起;天然保证至多一项展开。
const expandedId = ref<string | null>(null)

function toggleDetail(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

// 面板折叠态:持久化 UI 状态。收缩态收窄面板并隐藏模块名/操作区;跨页面切换后保持原状。
const collapsed = usePersistentToggle('c3.intentListCollapsed')
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))
const rowVis = computed(() => rowVisibility(collapsed.value))

function togglePanel(): void {
  collapsed.value = !collapsed.value
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 createdAt;月日补零两位。
function datePrefix(r: Intent): string {
  return formatDate(r.completedAt ?? r.createdAt, locale.value, { style: 'short' })
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
        <span class="req-list-title">{{ t('intent.list.title.label') }}</span>
      </div>
      <div class="req-head-right">
        <button
          class="req-btn auto-btn"
          :class="{ running: autoRunning, error: !!autoError }"
          :title="
            autoRunning ? t('intent.automation.stop.tooltip') : t('intent.automation.start.tooltip')
          "
          @click="toggleAutomation"
        >
          {{ autoRunning ? t('intent.automation.stop.label') : t('intent.automation.start.label') }}
        </button>
        <select
          class="req-filter"
          :value="filter ?? ''"
          @change="setFilter((($event.target as HTMLSelectElement).value as IntentStatus) || null)"
        >
          <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">{{ f.label }}</option>
        </select>
      </div>
    </div>
    <div v-if="autoError" class="auto-status error" :title="autoError">⚠ {{ autoError }}</div>
    <div v-else-if="autoNote" class="auto-status">{{ autoNote }}</div>
    <div class="req-items">
      <p v-if="intents.length === 0" class="req-empty">
        {{ t('intent.list.empty') }}
      </p>
      <div v-for="r in displayIntents" :key="r.id" class="req-item" :class="r.status">
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
              {{ t('intent.action.refine.label') }}
            </button>
            <button v-if="r.status === 'todo'" class="req-btn primary" @click="startDev(r)">
              {{ t('intent.action.startDev.label') }}
            </button>
            <button
              v-if="r.lastDevSessionId"
              class="req-btn"
              @click="emit('open-dev', r.lastDevSessionId as string)"
            >
              {{ t('intent.action.session.label') }}
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'done')"
            >
              {{ t('intent.action.markDone.label') }}
            </button>
            <button
              v-if="r.status !== 'done' && r.status !== 'cancelled'"
              class="req-btn"
              @click="emit('set-status', r.id, 'cancelled')"
            >
              {{ t('common.action.cancel.label') }}
            </button>
            <button
              type="button"
              class="req-automate"
              :class="{ active: r.automate }"
              :title="
                r.automate
                  ? t('intent.automate.queued.tooltip')
                  : t('intent.automate.manual.tooltip')
              "
              :aria-pressed="r.automate"
              @click.stop="emit('set-automate', r.id, !r.automate)"
            >
              {{ r.automate ? '⏳' : '✋' }}
            </button>
          </div>
        </div>
        <div v-if="r.id === expandedId" class="req-detail">
          <MarkdownText :text="r.content" markdown />
        </div>
        <div v-if="r.id === expandedId" class="req-meta">
          <span class="req-meta-item"
            >{{ t('intent.meta.created.label') }} {{ formatDate(r.createdAt, locale) }}</span
          >
          <span v-if="r.completedAt" class="req-meta-item"
            >{{ t('intent.meta.completed.label') }} {{ formatDate(r.completedAt, locale) }}</span
          >
          <span v-if="formatDependsOn(r, props.intents).length" class="req-meta-item">
            {{ t('intent.meta.dependsOn.label') }}
            <span
              v-for="(dep, di) in formatDependsOn(r, props.intents)"
              :key="dep.id"
              :class="dep.done ? 'req-dep-done' : 'req-dep-pending'"
            >
              <span v-if="di > 0">, </span>{{ dep.title }}<span v-if="!dep.done"> ⚠</span>
            </span>
          </span>
        </div>
        <div
          v-if="unfinishedDeps(r).length"
          class="req-deps"
          :title="t('intent.deps.unfinished.tooltip')"
        >
          {{
            t('intent.deps.unfinishedList', {
              list: unfinishedDeps(r)
                .map((d) => titleById[d.id] ?? d.id)
                .join(', '),
            })
          }}
        </div>
      </div>
      <div v-if="terminalPaging" class="req-terminal-paging">
        <button
          v-if="terminalPaging.hasMore"
          type="button"
          class="req-load-more"
          @click="loadMoreTerminated"
        >
          {{ t('intent.list.loadMore') }}
        </button>
        <span v-else class="req-all-loaded">{{ t('intent.list.allLoaded') }}</span>
      </div>
    </div>
  </section>
</template>
