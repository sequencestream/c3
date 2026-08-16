<script setup lang="ts">
/*
 * IntentMergedList.vue — 意图页左栏:意图列表容器。
 *
 * 外层使用 .req-list CSS 类继承 IntentList 的宽度/折叠行为。容器层附带折叠切换、
 * 自动化按钮、状态过滤与移动端 overflow 菜单;内层渲染 IntentList。
 *
 * 头部包含:
 * - 折叠按钮(控制整列宽窄)
 * - 列表标题
 * - 右域:自动化按钮 + 状态过滤(移动端折叠进 overflow 菜单)+「+」增加意图
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ActionTarget, WorkflowStatus, Intent, IntentStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useIsMobile } from '@/composables/useBreakpoint'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { panelToggleLabel } from '../../../../lib/intent-list-view'
import IntentList from '../IntentList/IntentList.vue'

const { t } = useTypedI18n()
const isMobile = useIsMobile()

const props = defineProps<{
  // IntentList props
  project: string
  intents: Intent[]
  automation: WorkflowStatus | null
  /** 当前选中的意图 id,透传给 IntentList 做行高亮。 */
  selectedIntentId?: string | null
  sddEnabled?: boolean
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
  createIntentPending?: boolean
}>()

const emit = defineEmits<{
  // IntentList events
  filter: [status: IntentStatus | null]
  'start-automation': []
  'stop-automation': []
  'open-queue': []
  'select-intent': [intentId: string]
  'ordered-change': [ids: string[]]
  'set-automate': [intentId: string, automate: boolean]
  'action-target': [target: ActionTarget]
  'new-intent': []
}>()

const mobileActionsOpen = ref(false)

// ---- 空列表引导气泡 ----
/** 空列表时引导点击「+」的气泡可见性。关闭仅本次进入期间生效:组件重挂载(刷新/重新进入)
 *  或列表变非空后自动复位/消失,不做持久化记忆。 */
const emptyGuideVisible = ref(true)

// ---- 折叠态 ----
const collapsed = usePersistentToggle('c3.intentMergedListCollapsed')
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))

function togglePanel(): void {
  collapsed.value = !collapsed.value
}

function closeMobileActionsMenu(): void {
  mobileActionsOpen.value = false
}

function toggleMobileActionsMenu(): void {
  mobileActionsOpen.value = !mobileActionsOpen.value
}

function onDocumentClick(): void {
  closeMobileActionsMenu()
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onUnmounted(() => document.removeEventListener('click', onDocumentClick))

watch(isMobile, closeMobileActionsMenu)

// ---- 自动化按钮 ----
const AUTO_RUNNING_STATES = new Set(['running', 'developing', 'fixing', 'awaiting_gate'])
const autoRunning = computed(
  () => props.automation && AUTO_RUNNING_STATES.has(props.automation.state),
)
const autoError = computed(() =>
  props.automation?.state === 'error'
    ? (props.automation.error ?? t('intent.automation.error.fallback'))
    : null,
)

function toggleWorkflow(): void {
  if (autoRunning.value) emit('stop-automation')
  else emit('start-automation')
}

function toggleWorkflowFromMenu(): void {
  toggleWorkflow()
  closeMobileActionsMenu()
}

function openQueueFromMenu(): void {
  emit('open-queue')
  closeMobileActionsMenu()
}

// ---- 状态过滤 ----
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

function setFilterFromMenu(value: string): void {
  setFilter(value)
  closeMobileActionsMenu()
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
        <span class="merged-list-title">{{ t('intent.list.title.label') }}</span>
      </div>
      <div class="merged-list-head-right">
        <button
          v-show="!isMobile"
          class="req-btn auto-btn"
          :class="{ running: autoRunning, error: !!autoError }"
          :title="
            autoRunning ? t('intent.automation.stop.tooltip') : t('intent.automation.start.tooltip')
          "
          @click="toggleWorkflow"
        >
          {{ autoRunning ? t('intent.automation.stop.label') : t('intent.automation.start.label') }}
        </button>
        <button
          v-show="!isMobile"
          class="req-btn"
          data-testid="open-queue"
          :title="t('queue.open.tooltip')"
          @click="emit('open-queue')"
        >
          {{ t('queue.open.label') }}
        </button>
        <select
          v-show="!isMobile"
          class="req-filter"
          :value="filter ?? ''"
          @change="setFilter(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">
            {{ f.label }}
          </option>
        </select>
        <div
          v-show="isMobile"
          class="req-row-menu"
          data-testid="intent-list-mobile-actions"
          @click.stop
        >
          <button
            type="button"
            class="req-kebab"
            aria-label="Actions"
            :aria-expanded="mobileActionsOpen"
            @click="toggleMobileActionsMenu"
          >
            ⋮
          </button>
          <div v-if="mobileActionsOpen" class="req-menu">
            <button
              type="button"
              class="req-btn auto-btn req-menu-item"
              :class="{ running: autoRunning, error: !!autoError }"
              :title="
                autoRunning
                  ? t('intent.automation.stop.tooltip')
                  : t('intent.automation.start.tooltip')
              "
              @click="toggleWorkflowFromMenu"
            >
              {{
                autoRunning ? t('intent.automation.stop.label') : t('intent.automation.start.label')
              }}
            </button>
            <button
              type="button"
              class="req-btn req-menu-item"
              data-testid="open-queue-mobile"
              :title="t('queue.open.tooltip')"
              @click="openQueueFromMenu"
            >
              {{ t('queue.open.label') }}
            </button>
            <select
              class="req-filter"
              :value="filter ?? ''"
              @change="setFilterFromMenu(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">
                {{ f.label }}
              </option>
            </select>
          </div>
        </div>
        <div class="req-new-wrap">
          <div
            v-if="intents.length === 0 && emptyGuideVisible"
            class="empty-guide"
            role="status"
            data-testid="intent-list-empty-guide"
          >
            <span class="empty-guide-text">{{ t('intent.list.emptyGuide') }}</span>
            <button
              type="button"
              class="empty-guide-close"
              data-testid="intent-list-empty-guide-close"
              :aria-label="t('common.action.close.label')"
              :title="t('common.action.close.label')"
              @click="emptyGuideVisible = false"
            >
              ×
            </button>
          </div>
          <button
            type="button"
            class="req-new-btn"
            :aria-label="t('intent.create.label')"
            :title="t('intent.create.label')"
            data-testid="intent-list-create-intent"
            :disabled="createIntentPending"
            @click="emit('new-intent')"
          >
            +
          </button>
        </div>
      </div>
    </div>

    <div class="merged-child-wrap">
      <IntentList
        hide-header
        :collapsed-override="collapsed"
        :project="project"
        :intents="intents"
        :automation="automation"
        :sdd-enabled="sddEnabled"
        :workspace-main-branch="workspaceMainBranch"
        :workspace-git-branch-mode="workspaceGitBranchMode"
        :selected-id="selectedIntentId"
        @filter="(s: IntentStatus | null) => emit('filter', s)"
        @start-automation="emit('start-automation')"
        @stop-automation="emit('stop-automation')"
        @select-intent="(id: string) => emit('select-intent', id)"
        @ordered-change="(ids: string[]) => emit('ordered-change', ids)"
        @set-automate="(id: string, automate: boolean) => emit('set-automate', id, automate)"
        @action-target="(target: ActionTarget) => emit('action-target', target)"
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
/* 「+」按钮容器:为空列表引导气泡提供绝对定位参照 */
.req-new-wrap {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}
/* 空列表引导气泡:悬在「+」正下方、箭头指向按钮。整体落在按钮下方,故不遮挡也不拦截
   「+」的点击;仅在列表为空且本次未被关闭时渲染。 */
.empty-guide {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  width: max-content;
  max-width: 220px;
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  background: var(--c-card);
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-mid);
}
/* 箭头:两层三角叠出带边框效果 —— 下层取边框色,上层取背景色内缩 1px 盖住 */
.empty-guide::before,
.empty-guide::after {
  content: '';
  position: absolute;
  right: 6px;
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
}
.empty-guide::before {
  bottom: 100%;
  border-bottom: 6px solid var(--c-primary);
}
.empty-guide::after {
  bottom: calc(100% - 1px);
  border-bottom: 6px solid var(--c-card);
}
.empty-guide-text {
  font-size: var(--fs-caption);
  line-height: 1.4;
  color: var(--c-text);
}
.empty-guide-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: var(--fs-caption);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.empty-guide-close:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.merged-list-title {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
/* 折叠态:标题字号缩小,适配窄列 */
.merged-list.collapsed .merged-list-title {
  font-size: var(--fs-badge);
}
@media (max-width: 767px) {
  .merged-list.collapsed .merged-list-title {
    font-size: var(--fs-caption);
  }
}
</style>
