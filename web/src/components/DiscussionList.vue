<script setup lang="ts">
/*
 * DiscussionList.vue — 讨论视图左栏:讨论列表 + 顶部「+」。
 *
 * 数据由 App 提供(读路径)。点击某讨论上抛 `open` 事件,由 App 拉取详情;
 * 顶部「+」展开内联新建表单(类型/目标/上下文),提交上抛 `create`(写路径)。
 */
import { computed, ref } from 'vue'
import type { Discussion } from '@ccc/shared/protocol'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { formatDate } from '../lib/req-list-view'
import { panelToggleLabel, rowVisibility, statusLabel } from '../lib/discussion-view'

defineProps<{
  discussions: Discussion[]
  activeId: string | null
}>()

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
function toggleDetail(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

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
          class="disc-input"
          rows="2"
          placeholder="What should this discussion achieve?"
        />
      </label>
      <label class="disc-field">
        <span class="disc-field-label">Context</span>
        <textarea
          v-model="formContext"
          class="disc-input"
          rows="3"
          placeholder="Background material (a research agent will complete it)"
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
        <div
          class="disc-item-main"
          role="button"
          tabindex="0"
          :aria-expanded="d.id === expandedId"
          @click="toggleDetail(d.id)"
          @keydown.enter.prevent="toggleDetail(d.id)"
          @keydown.space.prevent="toggleDetail(d.id)"
        >
          <div class="disc-item-head">
            <span
              class="disc-chevron"
              :class="{ 'disc-chevron--open': d.id === expandedId }"
              aria-hidden="true"
              >▸</span
            >
            <span class="disc-date">{{ datePrefix(d) }}</span>
            <span v-if="rowVis.showMeta && d.type" class="disc-type">{{ typeLabel(d) }}</span>
            <span class="disc-title" :title="d.goal || d.title">{{ d.title }}</span>
            <span class="disc-status" :class="d.status">{{ statusLabel(d.status) }}</span>
          </div>
          <div class="disc-actions" @click.stop>
            <button
              type="button"
              class="disc-open-btn"
              title="Open chat history and orchestration view"
              @click="emit('open', d.id)"
            >
              Open chat
            </button>
          </div>
        </div>
        <div v-if="d.id === expandedId" class="disc-detail">
          <p v-if="d.goal" class="disc-detail-block"><strong>Goal:</strong> {{ d.goal }}</p>
          <p v-if="d.context" class="disc-detail-block">
            <strong>Context:</strong> {{ d.context }}
          </p>
          <p v-if="d.conclusion" class="disc-detail-block">
            <strong>Conclusion:</strong> {{ d.conclusion }}
          </p>
        </div>
        <div v-if="d.id === expandedId" class="disc-detail-meta">
          <span class="disc-meta-item">Type: {{ typeLabel(d) }}</span>
          <span class="disc-meta-item">Status: {{ statusLabel(d.status) }}</span>
          <span class="disc-meta-item">Created: {{ formatDate(d.createdAt) }}</span>
          <span v-if="d.completedAt" class="disc-meta-item"
            >Completed: {{ formatDate(d.completedAt) }}</span
          >
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.disc-list {
  width: 360px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
/* 收缩态:收窄面板,隐藏行内次要元信息(由组件 v-if 不渲染) */
.disc-list.collapsed {
  width: 240px;
}
@media (max-width: 1024px) {
  .disc-list {
    width: min(360px, 34vw);
    min-width: 240px;
  }
  .disc-list.collapsed {
    width: min(240px, 24vw);
    min-width: 180px;
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
.disc-chevron {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  transition: transform 0.15s ease;
}
.disc-chevron--open {
  transform: rotate(90deg);
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
.disc-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.disc-open-btn {
  padding: 2px 8px;
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.disc-open-btn:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
/* 手风琴展开详情:正文块,保留换行 */
.disc-detail {
  margin-top: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--c-hover);
  border: 1px solid var(--c-border);
  color: var(--c-text);
  font-size: var(--fs-body);
  line-height: 1.6;
}
.disc-detail-block {
  margin: 0 0 var(--sp-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.disc-detail-block:last-child {
  margin-bottom: 0;
}
/* 展开详情下方的次要元信息行:type/status/时间,字号小且灰 */
.disc-detail-meta {
  margin-top: var(--sp-1);
  padding: var(--sp-1) var(--sp-3) 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  line-height: 1.8;
}
.disc-meta-item {
  display: inline;
}
.disc-meta-item + .disc-meta-item::before {
  content: '·';
  margin: 0 var(--sp-1);
  color: var(--c-border);
}
</style>
