<script setup lang="ts">
/*
 * DiscussionList.vue — 讨论视图左栏:讨论列表 + 顶部「+」。
 *
 * 数据由 App 提供(读路径)。点击某讨论上抛 `open` 事件,由 App 拉取详情;
 * 顶部「+」展开内联新建表单(类型/目标/上下文),提交上抛 `create`(写路径)。
 */
import { ref } from 'vue'
import type { Discussion, DiscussionStatus } from '@ccc/shared/protocol'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { formatDate } from '../lib/req-list-view'

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

const STATUS_LABEL: Record<DiscussionStatus, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 updatedAt。
function datePrefix(d: Discussion): string {
  return formatDate(d.completedAt ?? d.updatedAt, { style: 'short' })
}
</script>

<template>
  <section class="disc-list">
    <div class="disc-list-head">
      <span class="disc-list-title">Discussions</span>
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
        role="button"
        tabindex="0"
        :aria-pressed="d.id === activeId"
        @click="emit('open', d.id)"
        @keydown.enter.prevent="emit('open', d.id)"
        @keydown.space.prevent="emit('open', d.id)"
      >
        <div class="disc-item-head">
          <span class="disc-date">{{ datePrefix(d) }}</span>
          <span class="disc-title">{{ d.title }}</span>
        </div>
        <div class="disc-meta">
          <span class="disc-status">{{ STATUS_LABEL[d.status] }}</span>
          <span v-if="d.type" class="disc-type">{{ d.type }}</span>
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
}
@media (max-width: 1024px) {
  .disc-list {
    width: min(360px, 34vw);
    min-width: 240px;
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
.disc-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
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
  gap: var(--sp-1);
  cursor: pointer;
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
.disc-item-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}
.disc-date {
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.disc-meta {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
