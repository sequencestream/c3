<script setup lang="ts">
/*
 * DeliveryOverviewTab.vue — 概览 tab。
 *
 * 顶部:状态分段选择器 + 常驻缺口(含集成就熟 N/M);`current-branch` 模式下
 * 追加说明文案(交付在此仅为聚合视图,分支/PR/合并动作不可用——本阶段本就无这些
 * 动作,文案先行)。下方:概览元信息(状态/交付分支/基线分支/起止日期/交付 PR 链接/
 * 创建与更新时间/描述)与内联编辑表单。不设 PR、设置或分支独立 Tab。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { Delivery, DeliveryStatus, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import { formatDate } from '@/lib/intent-list-view'
import {
  DELIVERY_STATUS_LABEL_KEYS,
  defaultDeliveryBranchName,
  epochMsToCalendarDate,
  calendarDateToEpochMs,
  isDeliveryTerminal,
  type DeliveryBranchInitPhase,
  type DeliveryBranchInitState,
} from '@/lib/delivery-view'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import DeliveryStatusSelector from './DeliveryStatusSelector.vue'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  delivery: Delivery
  plan: DeliveryTransitionPlan
  branchInit: DeliveryBranchInitState | null
  workspaceGitBranchMode: 'worktree' | 'current-branch'
  /** How far mainline is ahead of the delivery branch; null = unknown / N/A. */
  mainlineAhead: number | null
  /** In-flight 「同步主线」 phase; null = idle. */
  syncPhase: 'fetching' | 'merging' | 'pushing' | null
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
  'init-branch': [payload: { mode: 'create' | 'bind'; branchName: string }]
  'cleanup-branch': [deliveryId: string]
  'sync-mainline': [deliveryId: string]
  jump: [target: 'associated-intents' | 'workspace-settings' | 'branch']
}>()

// ---- Branch init form ----
const mode = ref<'create' | 'bind'>('create')
const branchName = ref('')
const branchInputRef = ref<HTMLInputElement | null>(null)
const cleanupOpen = ref(false)
const syncOpen = ref(false)

/**
 * 「同步主线」is offered ONLY while a delivery is `integrating` on a ready branch
 * — that is the whole window in which merging mainline in is both meaningful and
 * safe. From `verifying` on, changing the tree is exactly what invalidates the
 * verification, so the action disappears rather than failing on the server.
 */
const canSyncMainline = computed(
  () =>
    props.workspaceGitBranchMode === 'worktree' &&
    props.delivery.status === 'integrating' &&
    props.delivery.branchReady &&
    !!props.delivery.branchName,
)

/** Mainline holds commits this delivery branch does not — sync now, not at merge time. */
const mainlineBehind = computed(() => (props.mainlineAhead ?? 0) > 0)

function doSyncMainline(): void {
  syncOpen.value = false
  emit('sync-mainline', props.delivery.id)
}

/** Reset the editable branch-name default when opening a different delivery. */
watch(
  () => props.delivery.id,
  () => {
    if (!props.delivery.branchReady) {
      branchName.value = defaultDeliveryBranchName(props.delivery.id, props.delivery.title)
    }
  },
  { immediate: true },
)

const isTerminal = computed(() => isDeliveryTerminal(props.delivery.status))

/** Whether a branch-init run is in flight FOR THIS delivery. */
const inFlight = computed(
  () => props.branchInit !== null && props.branchInit.deliveryId === props.delivery.id,
)

const BRANCH_INIT_PHASE_KEYS: Record<DeliveryBranchInitPhase, LocaleKey> = {
  fetching: 'delivery.branch.init.progress.fetching.label',
  creating: 'delivery.branch.init.progress.creating.label',
  pushing: 'delivery.branch.init.progress.pushing.label',
  binding: 'delivery.branch.init.progress.binding.label',
}

const initProgressLabel = computed(() =>
  props.branchInit ? t(BRANCH_INIT_PHASE_KEYS[props.branchInit.phase]) : '',
)

function doInit(): void {
  const name = branchName.value.trim()
  if (!name || inFlight.value) return
  emit('init-branch', { mode: mode.value, branchName: name })
}

function doCleanup(): void {
  cleanupOpen.value = false
  emit('cleanup-branch', props.delivery.id)
}

/** Scroll the branch section into view + focus the input (jump from the gap). */
function focusBranchInit(): void {
  const input = branchInputRef.value
  if (!input) return
  // `scrollIntoView` is absent in some test DOMs — focus alone still works.
  if (typeof input.scrollIntoView === 'function') {
    input.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  input.focus()
}

defineExpose({ focusBranchInit })

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

function onJump(target: 'associated-intents' | 'workspace-settings' | 'branch'): void {
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

    <!-- 交付分支区(仅 worktree 模式):未就绪 → 初始化表单;就绪 → 分支名;
         终态 → 仅手动清理入口(需二次确认,只删本地引用,远端分支永不自动删)。 -->
    <div
      v-if="props.workspaceGitBranchMode === 'worktree'"
      class="delivery-branch-block"
      data-testid="delivery-branch-block"
    >
      <template v-if="!props.delivery.branchReady && !isTerminal">
        <p class="delivery-branch-title">{{ t('delivery.branch.init.title.label') }}</p>
        <div class="delivery-branch-mode" data-testid="delivery-branch-mode">
          <button
            type="button"
            class="delivery-branch-mode-btn"
            :class="{ active: mode === 'create' }"
            :disabled="inFlight"
            data-testid="delivery-branch-mode-create"
            @click="mode = 'create'"
          >
            {{ t('delivery.branch.init.create.label') }}
          </button>
          <button
            type="button"
            class="delivery-branch-mode-btn"
            :class="{ active: mode === 'bind' }"
            :disabled="inFlight"
            data-testid="delivery-branch-mode-bind"
            @click="mode = 'bind'"
          >
            {{ t('delivery.branch.init.bind.label') }}
          </button>
        </div>
        <label class="delivery-branch-field">
          <span>{{ t('delivery.branch.init.branchLabel.label') }}</span>
          <input
            ref="branchInputRef"
            v-model="branchName"
            type="text"
            :disabled="inFlight"
            data-testid="delivery-branch-name-input"
            :placeholder="t('delivery.branch.init.branchPlaceholder.label')"
          />
        </label>
        <div class="delivery-branch-actions">
          <button
            type="button"
            class="delivery-branch-init-btn"
            :disabled="!branchName.trim() || inFlight"
            data-testid="delivery-branch-init-btn"
            @click="doInit"
          >
            {{ t('delivery.branch.init.submit.label') }}
          </button>
          <p
            v-if="inFlight"
            class="delivery-branch-progress"
            data-testid="delivery-branch-init-progress"
          >
            {{ initProgressLabel }}
          </p>
        </div>
      </template>
      <template v-else-if="props.delivery.branchReady">
        <p class="delivery-branch-ready" data-testid="delivery-branch-ready">
          {{ t('delivery.branch.ready.label', { branch: props.delivery.branchName ?? '' }) }}
        </p>
        <div v-if="canSyncMainline" class="delivery-sync" data-testid="delivery-sync-mainline">
          <p
            v-if="mainlineBehind"
            class="delivery-sync-hint"
            data-testid="delivery-sync-mainline-hint"
          >
            {{ t('delivery.syncMainline.behind.label', { count: props.mainlineAhead ?? 0 }) }}
          </p>
          <div class="delivery-sync-actions">
            <button
              type="button"
              class="delivery-sync-btn"
              :disabled="syncPhase !== null"
              data-testid="delivery-sync-mainline-btn"
              @click="syncOpen = true"
            >
              {{ t('delivery.syncMainline.action.label') }}
            </button>
            <p v-if="syncPhase" class="delivery-branch-progress">
              {{ t('delivery.syncMainline.running.label') }}
            </p>
          </div>
          <ConfirmDialog
            :open="syncOpen"
            :title="t('delivery.syncMainline.confirm.title.label')"
            :message="
              t('delivery.syncMainline.confirm.body.label', {
                base: props.delivery.baseBranch,
                branch: props.delivery.branchName ?? '',
              })
            "
            :confirm-label="t('delivery.syncMainline.action.label')"
            :cancel-label="t('common.action.cancel.label')"
            @confirm="doSyncMainline"
            @cancel="syncOpen = false"
          />
        </div>
      </template>
      <div
        v-else-if="isTerminal && props.delivery.branchName"
        class="delivery-branch-cleanup"
        data-testid="delivery-branch-cleanup"
      >
        <span class="delivery-branch-cleanup-name">{{ props.delivery.branchName }}</span>
        <button
          type="button"
          class="delivery-branch-cleanup-btn"
          data-testid="delivery-branch-cleanup-btn"
          @click="cleanupOpen = true"
        >
          {{ t('delivery.branch.cleanup.label') }}
        </button>
        <ConfirmDialog
          :open="cleanupOpen"
          :title="t('delivery.branch.cleanupTitle.label')"
          :message="
            t('delivery.branch.cleanupBody.label', { branch: props.delivery.branchName ?? '' })
          "
          :confirm-label="t('delivery.branch.cleanup.label')"
          :cancel-label="t('common.action.cancel.label')"
          danger
          @confirm="doCleanup"
          @cancel="cleanupOpen = false"
        />
      </div>
    </div>

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
.delivery-branch-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-branch-title {
  margin: 0;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-text-muted);
}
.delivery-branch-mode {
  display: flex;
  gap: var(--sp-1);
}
.delivery-branch-mode-btn {
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-branch-mode-btn.active {
  color: var(--c-primary-text);
  border-color: var(--c-primary);
}
.delivery-branch-mode-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.delivery-branch-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-branch-field input {
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
}
.delivery-branch-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.delivery-sync {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.delivery-sync-hint {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text-muted);
}

.delivery-sync-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.delivery-sync-btn {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md, 6px);
  border: 1px solid var(--c-border);
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  cursor: pointer;
}

.delivery-sync-btn:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}

.delivery-sync-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delivery-branch-init-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: #fff;
  background: var(--c-primary);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-branch-init-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.delivery-branch-progress {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-branch-ready {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text);
}
.delivery-branch-cleanup {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.delivery-branch-cleanup-name {
  font-size: var(--fs-body);
  color: var(--c-text);
  word-break: break-all;
}
.delivery-branch-cleanup-btn {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-danger-text, #c53030);
  background: transparent;
  border: 1px solid var(--c-danger, #e53e3e);
  border-radius: var(--radius-sm);
  cursor: pointer;
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
