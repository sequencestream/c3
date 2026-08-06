<script setup lang="ts">
/*
 * DeliveryOverviewTab.vue — 概览 tab。
 *
 * 顶部:状态分段选择器 + 常驻缺口(含集成就熟 N/M);`current-branch` 模式下
 * 追加说明文案(交付在此仅为聚合视图,分支/PR/合并动作不可用——本阶段本就无这些
 * 动作,文案先行)。下方:概览元信息(状态/交付分支/基线分支/起止日期/交付 PR 链接/
 * 创建与更新时间/描述)与内联编辑表单。不设 PR、设置或分支独立 Tab。
 */
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { Delivery, DeliveryStatus, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import { formatDate } from '@/lib/intent-list-view'
import {
  DELIVERY_STATUS_LABEL_KEYS,
  epochMsToCalendarDate,
  calendarDateToEpochMs,
} from '@/lib/delivery-view'
import DeliveryStatusSelector from './DeliveryStatusSelector.vue'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  delivery: Delivery
  plan: DeliveryTransitionPlan
  workspaceGitBranchMode: 'worktree' | 'current-branch'
}>()

const emit = defineEmits<{
  update: [
    payload: {
      deliveryId: string
      title?: string
      description?: string
      startDate?: number | null
      endDate?: number | null
    },
  ]
  transition: [to: DeliveryStatus, confirmVerified: boolean]
  jump: [target: 'associated-intents' | 'workspace-settings']
}>()

// ---- Inline edit form ----
const editing = ref(false)
const editTitle = ref('')
const editDescription = ref('')
const editStart = ref('')
const editEnd = ref('')

function startEdit(): void {
  editTitle.value = props.delivery.title
  editDescription.value = props.delivery.description
  editStart.value = epochMsToCalendarDate(props.delivery.startDate)
  editEnd.value = epochMsToCalendarDate(props.delivery.endDate)
  editing.value = true
}

function saveEdit(): void {
  if (!editTitle.value.trim()) return
  emit('update', {
    deliveryId: props.delivery.id,
    title: editTitle.value.trim(),
    description: editDescription.value,
    startDate: editStart.value ? calendarDateToEpochMs(editStart.value) : null,
    endDate: editEnd.value ? calendarDateToEpochMs(editEnd.value) : null,
  })
  editing.value = false
}

function onJump(target: 'associated-intents' | 'workspace-settings'): void {
  emit('jump', target)
}

function statusLabel(status: DeliveryStatus): string {
  return t(DELIVERY_STATUS_LABEL_KEYS[status])
}
</script>

<template>
  <div class="delivery-overview" data-testid="delivery-overview">
    <!-- current-branch: 交付仅为聚合视图的说明文案(动作区分支/PR/合并动作不渲染) -->
    <p
      v-if="props.workspaceGitBranchMode === 'current-branch'"
      class="delivery-cb-note"
      data-testid="delivery-current-branch-note"
    >
      {{ t('delivery.page.currentBranchNote.label') }}
    </p>

    <DeliveryStatusSelector
      :status="props.delivery.status"
      :plan="props.plan"
      :integration="props.delivery.integration"
      :workspace-git-branch-mode="props.workspaceGitBranchMode"
      @transition="(to, confirm) => emit('transition', to, confirm)"
      @jump="onJump"
    />

    <dl class="delivery-meta" data-testid="delivery-meta">
      <div class="delivery-meta-row" data-testid="delivery-meta-status">
        <dt>{{ t('delivery.page.meta.status.label') }}</dt>
        <dd>{{ statusLabel(props.delivery.status) }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-base-branch">
        <dt>{{ t('delivery.page.meta.baseBranch.label') }}</dt>
        <dd>{{ props.delivery.baseBranch }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-branch">
        <dt>{{ t('delivery.page.meta.branch.label') }}</dt>
        <dd>{{ props.delivery.branchName ?? '—' }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-start">
        <dt>{{ t('delivery.page.meta.startDate.label') }}</dt>
        <dd>{{ epochMsToCalendarDate(props.delivery.startDate) || '—' }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-end">
        <dt>{{ t('delivery.page.meta.endDate.label') }}</dt>
        <dd>{{ epochMsToCalendarDate(props.delivery.endDate) || '—' }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-pr">
        <dt>{{ t('delivery.page.meta.pr.label') }}</dt>
        <dd>—</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-created">
        <dt>{{ t('delivery.page.meta.created.label') }}</dt>
        <dd>{{ formatDate(props.delivery.createdAt, locale) }}</dd>
      </div>
      <div class="delivery-meta-row" data-testid="delivery-meta-updated">
        <dt>{{ t('delivery.page.meta.updated.label') }}</dt>
        <dd>{{ formatDate(props.delivery.updatedAt, locale) }}</dd>
      </div>
      <div
        v-if="props.delivery.description"
        class="delivery-meta-row delivery-meta-desc"
        data-testid="delivery-meta-description"
      >
        <dt>{{ t('delivery.page.meta.description.label') }}</dt>
        <dd>{{ props.delivery.description }}</dd>
      </div>
    </dl>

    <div v-if="!editing" class="delivery-overview-actions">
      <button
        type="button"
        class="delivery-edit-btn"
        data-testid="delivery-edit-btn"
        @click="startEdit"
      >
        {{ t('delivery.action.edit.label') }}
      </button>
    </div>

    <form
      v-else
      class="delivery-edit-form"
      data-testid="delivery-edit-form"
      @submit.prevent="saveEdit"
    >
      <label class="delivery-form-field">
        <span>{{ t('delivery.action.form.titleLabel.label') }}</span>
        <input
          v-model="editTitle"
          type="text"
          data-testid="delivery-edit-title"
          :placeholder="t('delivery.action.form.titlePlaceholder.label')"
        />
      </label>
      <label class="delivery-form-field">
        <span>{{ t('delivery.action.form.descriptionLabel.label') }}</span>
        <textarea
          v-model="editDescription"
          rows="3"
          data-testid="delivery-edit-desc"
          :placeholder="t('delivery.action.form.descriptionPlaceholder.label')"
        />
      </label>
      <div class="delivery-form-row">
        <label class="delivery-form-field">
          <span>{{ t('delivery.action.form.startDateLabel.label') }}</span>
          <input v-model="editStart" type="date" data-testid="delivery-edit-start" />
        </label>
        <label class="delivery-form-field">
          <span>{{ t('delivery.action.form.endDateLabel.label') }}</span>
          <input v-model="editEnd" type="date" data-testid="delivery-edit-end" />
        </label>
      </div>
      <div class="delivery-edit-actions">
        <button
          type="submit"
          class="delivery-save-btn"
          :disabled="!editTitle.trim()"
          data-testid="delivery-edit-save"
        >
          {{ t('delivery.action.save.label') }}
        </button>
        <button
          type="button"
          class="delivery-cancel-edit-btn"
          data-testid="delivery-edit-cancel"
          @click="editing = false"
        >
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.delivery-overview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.delivery-cb-note {
  margin: 0;
  padding: var(--sp-2);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-meta-row {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-body);
}
.delivery-meta-row dt {
  flex-shrink: 0;
  width: 110px;
  color: var(--c-text-muted);
}
.delivery-meta-row dd {
  margin: 0;
  color: var(--c-text);
  word-break: break-word;
}
.delivery-meta-desc dd {
  white-space: pre-wrap;
}
.delivery-overview-actions {
  display: flex;
}
.delivery-edit-btn,
.delivery-save-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: #fff;
  background: var(--c-primary);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-cancel-edit-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-form-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-form-field input,
.delivery-form-field textarea {
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
}
.delivery-form-row {
  display: flex;
  gap: var(--sp-2);
}
.delivery-form-row .delivery-form-field {
  flex: 1;
}
.delivery-edit-actions {
  display: flex;
  gap: var(--sp-2);
}
.delivery-save-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
