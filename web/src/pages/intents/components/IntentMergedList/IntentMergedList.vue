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
 * - 右域:自动化按钮 + 状态过滤(移动端折叠进 overflow 菜单)+「+」新建意图会话
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { WorkflowStatus, Intent, IntentStatus } from '@ccc/shared/protocol'
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
}>()

const emit = defineEmits<{
  // IntentList events
  filter: [status: IntentStatus | null]
  'start-automation': []
  'stop-automation': []
  'select-intent': [intentId: string]
  'ordered-change': [ids: string[]]
  'set-automate': [intentId: string, automate: boolean]
  refine: [intentId: string]
  'new-intent-session': []
}>()

const mobileActionsOpen = ref(false)

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
        <button
          type="button"
          class="req-new-btn"
          :aria-label="t('intent.intentSession.new.tooltip')"
          :title="t('intent.intentSession.new.tooltip')"
          data-testid="intent-list-new-session"
          @click="emit('new-intent-session')"
        >
          +
        </button>
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
        @refine="(id: string) => emit('refine', id)"
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
