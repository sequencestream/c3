<script setup lang="ts">
/*
 * DiscussionList.vue — 讨论视图左栏:讨论列表 + 顶部「+」。
 *
 * 数据由 App 提供(读路径)。点击某讨论上抛 `open` 事件,由 App 拉取详情;
 * 顶部「+」展开内联新建表单(类型/目标/上下文),提交上抛 `create`(写路径)。
 */
import { computed, ref, watch } from 'vue'
import type { Discussion } from '@ccc/shared/protocol'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { formatDate } from '../../../../lib/req-list-view'
import {
  autoGrowHeight,
  discussionDetailTabs,
  panelToggleLabel,
  rowVisibility,
  statusLabel,
} from '../../../../lib/discussion-view'
import type { DiscussionTabKind } from '../../../../lib/discussion-view'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'

const props = withDefaults(
  defineProps<{
    discussions: Discussion[]
    activeId: string | null
    // Live orchestration run-state per discussion (id → running/paused), decoupled from the
    // persisted `status`. Absent id = no live run. Drives the per-row live badge so concurrent
    // background runs are each visible; accurate after refresh/reconnect via the list snapshot.
    runState?: Record<string, 'running' | 'paused'>
  }>(),
  { runState: () => ({}) },
)

// The live run-state for a row, or undefined when it has no active run.
function liveState(d: Discussion): 'running' | 'paused' | undefined {
  return props.runState[d.id]
}

const emit = defineEmits<{
  open: [discussionId: string]
  create: [payload: { type: string; goal: string; context: string }]
}>()

const TYPES = listDiscussionTypes()

// Inline create form state. The "+" toggles it; submit emits `create`.
const showForm = ref(false)
const formType = ref(TYPES[0]?.id ?? '')
const formGoal = ref('')
const formContext = ref('')

// Auto-grow: the Goal/Context textareas grow with their content up to this cap,
// then scroll internally. Closing the form (v-if) destroys the elements, so a
// reopened form starts fresh; clearing content shrinks via the `input` handler.
const MAX_TEXTAREA_PX = 200
function autoGrow(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  const { height, overflowY } = autoGrowHeight(el.scrollHeight, MAX_TEXTAREA_PX)
  el.style.height = `${height}px`
  el.style.overflowY = overflowY
}

function openForm(): void {
  showForm.value = true
}

function closeForm(): void {
  showForm.value = false
  formType.value = TYPES[0]?.id ?? ''
  formGoal.value = ''
  formContext.value = ''
}

function submitForm(): void {
  const goal = formGoal.value.trim()
  if (!formType.value || !goal) return
  emit('create', { type: formType.value, goal, context: formContext.value.trim() })
  closeForm()
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 updatedAt。
function datePrefix(d: Discussion): string {
  return formatDate(d.completedAt ?? d.updatedAt, { style: 'short' })
}

// 该讨论类型的可读标签;未知类型回退到原始 id。
const TYPE_LABEL = new Map(TYPES.map((t) => [t.id, t.label]))
function typeLabel(d: Discussion): string {
  return TYPE_LABEL.get(d.type) ?? d.type
}

// 手风琴展开状态:记录当前展开项的 id,null 表示全部收起;天然保证至多一项展开。
const expandedId = ref<string | null>(null)
// 当前展开项的详情 Tab 选中态(goal/context/conclusion/details)。
const activeTab = ref<DiscussionTabKind>('details')

const discussionsById = computed(() => new Map(props.discussions.map((d) => [d.id, d] as const)))
// 当前展开讨论的可见 Tab 列表(空字段已剔除,末尾恒有 details)。
const expandedTabs = computed(() => {
  const d = discussionsById.value.get(expandedId.value ?? '')
  return d ? discussionDetailTabs(d) : []
})

function toggleDetail(id: string): void {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  // 展开 / 切换讨论项:重置选中到第一个有内容的 Tab(不跨项记忆)。
  expandedId.value = id
  const d = discussionsById.value.get(id)
  const tabs = d ? discussionDetailTabs(d) : []
  activeTab.value = tabs[0]?.kind ?? 'details'
}

// 点击行:同时在右侧打开 chat 并切换内联详情手风琴(两个动作合一)。
function openRow(id: string): void {
  emit('open', id)
  toggleDetail(id)
}

// 实时更新可能让当前选中字段变空(对应 Tab 消失):回落到首个可见 Tab。
watch(expandedTabs, (tabs) => {
  if (tabs.length && !tabs.some((t) => t.kind === activeTab.value)) {
    activeTab.value = tabs[0].kind
  }
})

// 面板折叠态:本地 UI 状态。收缩态收窄面板并隐藏行内次要元信息。
const collapsed = ref(false)
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))
const rowVis = computed(() => rowVisibility(collapsed.value))
function togglePanel(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="disc-list" :class="{ collapsed }">
    <div class="disc-list-head">
      <div class="disc-list-head-left">
        <button
          type="button"
          class="disc-collapse-btn"
          :title="toggleLabel.title"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ toggleLabel.icon }}
        </button>
        <span class="disc-list-title">Discussions</span>
      </div>
      <button
        type="button"
        class="disc-new-btn"
        aria-label="New discussion"
        title="New discussion"
        @click="showForm ? closeForm() : openForm()"
      >
        +
      </button>
    </div>
    <form v-if="showForm" class="disc-form" @submit.prevent="submitForm">
      <label class="disc-field">
        <span class="disc-field-label">Type</span>
        <select v-model="formType" class="disc-input">
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </label>
      <label class="disc-field">
        <span class="disc-field-label">Goal</span>
        <textarea
          v-model="formGoal"
          class="disc-input disc-textarea"
          rows="2"
          placeholder="What should this discussion achieve?"
          @input="autoGrow"
        />
      </label>
      <label class="disc-field">
        <span class="disc-field-label">Context</span>
        <textarea
          v-model="formContext"
          class="disc-input disc-textarea"
          rows="3"
          placeholder="Background material (a research agent will complete it)"
          @input="autoGrow"
        />
      </label>
      <div class="disc-form-actions">
        <button type="button" class="disc-btn" @click="closeForm">Cancel</button>
        <button type="submit" class="disc-btn primary" :disabled="!formGoal.trim()">Create</button>
      </div>
    </form>
    <div class="disc-items">
      <p v-if="discussions.length === 0" class="disc-empty">No discussions yet.</p>
      <div
        v-for="d in discussions"
        :key="d.id"
        class="disc-item"
        :class="[d.status, { active: d.id === activeId }]"
      >
        <!-- Clicking the row both opens the chat in the right pane and toggles the
             inline detail accordion (the two actions are combined; no chevron). -->
        <div
          class="disc-item-main"
          role="button"
          tabindex="0"
          :aria-expanded="d.id === expandedId"
          :aria-label="`Open chat: ${d.title}`"
          @click="openRow(d.id)"
          @keydown.enter.prevent="openRow(d.id)"
          @keydown.space.prevent="openRow(d.id)"
        >
          <div class="disc-item-head">
            <span class="disc-date">{{ datePrefix(d) }}</span>
            <span v-if="rowVis.showMeta && d.type" class="disc-type">{{ typeLabel(d) }}</span>
            <span class="disc-title" :title="d.goal || d.title">{{ d.title }}</span>
            <!-- Live run badge: distinct from the static status pill. Running pulses; paused is
                 a steady amber. Absent when the discussion has no active orchestration run. -->
            <span
              v-if="liveState(d)"
              class="disc-run"
              :class="liveState(d)"
              :title="liveState(d) === 'running' ? 'Orchestration running' : 'Orchestration paused'"
            >
              <span class="disc-run-dot" aria-hidden="true" />
              {{ liveState(d) === 'running' ? 'Running' : 'Paused' }}
            </span>
            <span class="disc-status" :class="d.status">{{ statusLabel(d.status) }}</span>
          </div>
        </div>
        <div v-if="d.id === expandedId" class="disc-detail">
          <div class="disc-tabs" role="tablist">
            <button
              v-for="t in expandedTabs"
              :key="t.kind"
              type="button"
              role="tab"
              class="disc-tab"
              :class="{ active: t.kind === activeTab }"
              :aria-selected="t.kind === activeTab"
              @click="activeTab = t.kind"
            >
              {{ t.label }}
            </button>
          </div>
          <div class="disc-tab-body">
            <!-- Goal / Context / Conclusion:markdown 渲染(html:false → DOMPurify) -->
            <template v-for="t in expandedTabs" :key="t.kind">
              <MarkdownText
                v-if="t.kind === activeTab && t.body !== null"
                :text="t.body"
                :markdown="true"
              />
            </template>
            <!-- Details:结构化元信息,非 markdown -->
            <dl v-if="activeTab === 'details'" class="disc-meta-list">
              <div class="disc-meta-row">
                <dt>Type</dt>
                <dd>{{ typeLabel(d) }}</dd>
              </div>
              <div class="disc-meta-row">
                <dt>Status</dt>
                <dd>{{ statusLabel(d.status) }}</dd>
              </div>
              <div class="disc-meta-row">
                <dt>Created</dt>
                <dd>{{ formatDate(d.createdAt) }}</dd>
              </div>
              <div v-if="d.completedAt" class="disc-meta-row">
                <dt>Completed</dt>
                <dd>{{ formatDate(d.completedAt) }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.disc-list {
  width: 960px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
/* 收缩态:宽度减半,隐藏行内次要元信息(由组件 v-if 不渲染) */
.disc-list.collapsed {
  width: 480px;
}
/* 窄屏回退:侧栏按视口比例收窄,避免挤压聊天区(与 .req-list 一致) */
@media (max-width: 1024px) {
  .disc-list {
    width: min(960px, 68vw);
    min-width: 450px;
  }
  .disc-list.collapsed {
    width: min(480px, 34vw);
    min-width: 280px;
  }
}
.disc-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.disc-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.disc-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
}
/* 展开/收缩切换按钮:标题前,图标反映点击后将切换到的目标态 */
.disc-collapse-btn {
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
.disc-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.disc-new-btn {
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
.disc-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
}
.disc-form {
  flex-shrink: 0;
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-card);
}
.disc-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.disc-field-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  color: var(--c-text);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  resize: vertical;
}
.disc-input:focus {
  outline: none;
  border-color: var(--c-primary);
}
/* Auto-grow textareas: JS sizes height to content up to the cap (MAX_TEXTAREA_PX);
   max-height here is the CSS backstop matching that cap, and the user can't drag
   past it (resize disabled — height is content-driven). */
.disc-textarea {
  max-height: 200px;
  resize: none;
  overflow-y: hidden;
}
.disc-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.disc-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.disc-btn:hover {
  border-color: var(--c-primary);
}
.disc-btn.primary {
  color: #fff;
  background: var(--c-primary);
  border-color: var(--c-primary);
}
.disc-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.disc-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
}
.disc-item {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-item:hover {
  border-color: var(--c-primary);
}
.disc-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.disc-item.completed,
.disc-item.cancelled {
  opacity: 0.6;
}
/* 标题区 + 操作区同行;窄屏 wrap 时操作区换到下一行 */
.disc-item-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  cursor: pointer;
}
.disc-item-head {
  flex: 1 1 160px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.disc-date {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
}
/* 类型 pill:灰底中性色,与 RequirementList 的 .req-module 同款 */
.disc-type {
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-badge);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.disc-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 状态徽标:彩色 pill,按状态映射语义色,对齐 RequirementList 的 .req-status */
.disc-status {
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
  flex-shrink: 0;
}
.disc-status.draft {
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
}
.disc-status.in_progress {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning);
}
.disc-status.completed {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success);
}
.disc-status.cancelled {
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error);
}
/* Live run badge: a lit pill with a leading dot, set apart from the static status pill so a
   background run reads as "live now" rather than merely persisted `in_progress`. */
.disc-run {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
}
.disc-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
/* Running: green + pulsing dot to signal active progress. */
.disc-run.running {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success);
}
.disc-run.running .disc-run-dot {
  animation: disc-run-pulse 1.4s ease-in-out infinite;
}
/* Paused: steady amber, no animation. */
.disc-run.paused {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning);
}
@keyframes disc-run-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.7);
  }
}
@media (prefers-reduced-motion: reduce) {
  .disc-run.running .disc-run-dot {
    animation: none;
  }
}
/* 手风琴展开详情:Tab 栏 + 单一内容区 */
.disc-detail {
  margin-top: var(--sp-1);
  border-radius: var(--radius-sm);
  background: var(--c-hover);
  border: 1px solid var(--c-border);
  color: var(--c-text);
  overflow: hidden;
}
/* Tab 栏:窄屏可横向滚动而非溢出/换行错位 */
.disc-tabs {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2) 0;
  border-bottom: 1px solid var(--c-border);
  overflow-x: auto;
  scrollbar-width: none;
}
.disc-tabs::-webkit-scrollbar {
  display: none;
}
.disc-tab {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  white-space: nowrap;
}
.disc-tab:hover {
  color: var(--c-text);
}
.disc-tab.active {
  color: var(--c-primary);
  border-bottom-color: var(--c-primary);
}
/* 单一内容区:markdown 正文或结构化元信息 */
.disc-tab-body {
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-body);
  line-height: 1.6;
  word-break: break-word;
}
.disc-tab-body :deep(.md-body) > :first-child {
  margin-top: 0;
}
.disc-tab-body :deep(.md-body) > :last-child {
  margin-bottom: 0;
}
/* Details Tab:type/status/时间的标签-值列表 */
.disc-meta-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.disc-meta-row {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.disc-meta-row dt {
  flex-shrink: 0;
  width: 76px;
  color: var(--c-text-muted);
}
.disc-meta-row dd {
  margin: 0;
  color: var(--c-text);
}
</style>
