<script setup lang="ts">
/*
 * IntentMergedList.vue — 合并左栏:带分段控件(sessions/intents)切换的列容器。
 *
 * 替代原 IntentList + IntentSessionList 两栏布局。外层使用 .req-list CSS 类
 * 继承 IntentList 的宽度/折叠行为;内部以 v-show 切换两子组件,保留各自内部状态
 * (滚动位置/展开行/过滤值)。
 *
 * 头部包含:
 * - 折叠按钮(控制整列宽窄)
 * - 分段控件(Intents / Sessions)
 * - 右域:Intents tab → 自动化按钮 + 状态过滤;Sessions tab → 「+」新建按钮
 */
import { computed, ref } from 'vue'
import type {
  AutomationStatus,
  DepType,
  Intent,
  IntentSessionInfo,
  IntentStatus,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { panelToggleLabel } from '../../../../lib/intent-list-view'
import IntentList from '../IntentList/IntentList.vue'
import IntentSessionList from '../IntentSessionList/IntentSessionList.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  // IntentList props
  project: string
  intents: Intent[]
  automation: AutomationStatus | null
  intentActionErrorSeq?: number

  // IntentSessionList props
  intentSessions: IntentSessionInfo[]
  selectedIntentSessionId: string | null
  intentSessionRunStates: Record<string, 'running'>
}>()

const emit = defineEmits<{
  // IntentList events
  filter: [status: IntentStatus | null]
  refine: [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'start-automation': []
  'stop-automation': []
  'new-intent': []
  'create-pr': [intentId: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]

  // IntentSessionList events (name-mapped)
  'select-intent-session': [sessionId: string]
  'new-intent-session': []
  'rename-intent-session': [sessionId: string, title: string]
  'delete-intent-session': [sessionId: string]
}>()

// ---- Segmented control ----
type MergedTab = 'intents' | 'sessions'
const activeTab = ref<MergedTab>('intents')

// 暴露 activeTab 供父组件(Intents.vue)读取,用于移动端 mobileStack pane title。
defineExpose({ activeTab })

// ---- Tab 切换键盘事件 ----
function onTabKeydown(e: KeyboardEvent, tab: MergedTab): void {
  const sibling =
    e.key === 'ArrowLeft'
      ? tab === 'sessions'
        ? 'intents'
        : 'sessions'
      : e.key === 'ArrowRight'
        ? tab === 'intents'
          ? 'sessions'
          : 'intents'
        : null
  if (sibling) {
    e.preventDefault()
    activeTab.value = sibling
  }
}

// ---- 折叠态 ----
const collapsed = usePersistentToggle('c3.intentMergedListCollapsed')
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))

function togglePanel(): void {
  collapsed.value = !collapsed.value
}

// ---- 自动化按钮(仅 intents tab 时显示) ----
const AUTO_RUNNING_STATES = new Set(['running', 'developing', 'fixing', 'awaiting_gate'])
const autoRunning = computed(
  () => props.automation && AUTO_RUNNING_STATES.has(props.automation.state),
)
const autoError = computed(() =>
  props.automation?.state === 'error'
    ? (props.automation.error ?? t('intent.automation.error.fallback'))
    : null,
)

function toggleAutomation(): void {
  if (autoRunning.value) emit('stop-automation')
  else emit('start-automation')
}

// ---- 状态过滤(仅 intents tab 时显示) ----
const FILTERS = computed<{ value: IntentStatus | null; label: string }[]>(() => [
  { value: null, label: t('intent.filter.all.label') },
  { value: 'todo', label: t('intent.filter.todo.label') },
  { value: 'in_progress', label: t('intent.filter.inProgress.label') },
  { value: 'done', label: t('intent.filter.done.label') },
  { value: 'cancelled', label: t('intent.filter.cancelled.label') },
  { value: 'draft', label: t('intent.filter.draft.label') },
  { value: 'blocked', label: t('intent.filter.blocked.label') },
  { value: 'failed', label: t('intent.filter.failed.label') },
])
const filter = ref<IntentStatus | null>(null)

function setFilter(value: string): void {
  const status = (value || null) as IntentStatus | null
  filter.value = status
  emit('filter', status)
}
</script>

<template>
  <section class="req-list merged-list" :class="{ collapsed }">
    <div class="merged-list-head">
      <div class="merged-list-head-left">
        <button
          type="button"
          class="req-collapse-btn"
          :title="toggleLabel.title"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ toggleLabel.icon }}
        </button>
        <div class="merged-segmented-control" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'intents'"
            :class="{ active: activeTab === 'intents' }"
            data-testid="tab-intents"
            @click="activeTab = 'intents'"
            @keydown="onTabKeydown($event, 'intents')"
          >
            {{ t('intent.list.title.label') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'sessions'"
            :class="{ active: activeTab === 'sessions' }"
            data-testid="tab-sessions"
            @click="activeTab = 'sessions'"
            @keydown="onTabKeydown($event, 'sessions')"
          >
            {{ t('intent.sessionList.title.label') }}
          </button>
        </div>
      </div>
      <div class="merged-list-head-right">
        <!-- 两套按钮常驻 DOM,仅切换 display 避免 template v-if 引起 happy-dom fragment 错误 -->
        <button
          v-show="activeTab === 'intents'"
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
          v-show="activeTab === 'intents'"
          class="req-filter"
          :value="filter ?? ''"
          @change="setFilter(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">
            {{ f.label }}
          </option>
        </select>
        <button
          v-show="activeTab === 'sessions'"
          type="button"
          class="req-new-btn"
          :aria-label="t('intent.sessionList.new.tooltip')"
          :title="t('intent.sessionList.new.tooltip')"
          data-testid="intent-session-new"
          @click="emit('new-intent-session')"
        >
          +
        </button>
      </div>
    </div>

    <div v-show="activeTab === 'intents'" class="merged-child-wrap">
      <IntentList
        hide-header
        :collapsed-override="collapsed"
        :project="project"
        :intents="intents"
        :automation="automation"
        :intent-action-error-seq="intentActionErrorSeq"
        @filter="(s: IntentStatus | null) => emit('filter', s)"
        @refine="(id: string) => emit('refine', id)"
        @start-dev="(id: string, d: boolean) => emit('start-dev', id, d)"
        @open-dev="(sessionId: string) => emit('open-dev', sessionId)"
        @set-status="(id: string, s: IntentStatus) => emit('set-status', id, s)"
        @set-automate="(id: string, a: boolean) => emit('set-automate', id, a)"
        @start-automation="emit('start-automation')"
        @stop-automation="emit('stop-automation')"
        @new-intent="emit('new-intent')"
        @create-pr="(id: string) => emit('create-pr', id)"
        @update-deps="(id, deps) => emit('update-deps', id, deps)"
      />
    </div>
    <div v-show="activeTab === 'sessions'" class="merged-child-wrap">
      <IntentSessionList
        hide-header
        :collapsed-override="collapsed"
        :sessions="intentSessions"
        :selected-id="selectedIntentSessionId"
        :run-states="intentSessionRunStates"
        @select="(sessionId: string) => emit('select-intent-session', sessionId)"
        @new="emit('new-intent-session')"
        @rename="(id: string, title: string) => emit('rename-intent-session', id, title)"
        @delete="(id: string) => emit('delete-intent-session', id)"
      />
    </div>
  </section>
</template>

<style scoped>
/* 合并列:继承 .req-list 在外层 style.css 中的宽度/背景/边框定义 */
.merged-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
  gap: var(--sp-3);
}
.merged-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  flex: 1;
}
.merged-list-head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.merged-segmented-control {
  display: inline-flex;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.merged-segmented-control button {
  flex-shrink: 0;
  padding: 2px 10px;
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-right: 1px solid var(--c-border);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
  white-space: nowrap;
}
.merged-segmented-control button:last-child {
  border-right: none;
}
.merged-segmented-control button:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.merged-segmented-control button.active {
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
}
/* 子组件包裹层:撑满余下高度,让内层组件填满 flex 列;隐藏态不走 v-if/v-show 以避免
   happy-dom 下 Vue 的 patchBlockChildren 引起 nextSibling null 错误。 */
.merged-child-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.merged-child-wrap.merged-hidden {
  display: none;
}
/* 折叠态:分段控件字号缩小,适配窄列 */
.merged-list.collapsed .merged-segmented-control button {
  font-size: var(--fs-badge);
  padding: 2px 6px;
}
@media (max-width: 767px) {
  .merged-list.collapsed .merged-segmented-control button {
    font-size: var(--fs-caption);
    padding: 2px 10px;
  }
}
</style>
