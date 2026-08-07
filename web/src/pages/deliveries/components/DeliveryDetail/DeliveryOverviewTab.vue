<script setup lang="ts">
/*
 * DeliveryOverviewTab.vue — 概览 tab。
 *
 * 概览不含任何状态内容——状态的展示与推进整体收敛在 DeliveryDetail 的常驻标题栏。
 * 这里只回归「交付分支 / 合并 / 元信息」:`current-branch` 模式下顶部一句说明文案
 * (交付在此仅为聚合视图,分支/PR/合并动作不可用),下方是分支初始化/同步主线区、
 * 合并区,以及概览元信息(基线分支/交付分支/起止日期/交付 PR 链接/创建与更新时间/
 * 描述)与打开编辑弹窗的入口。不设 PR、设置或分支独立 Tab。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { Delivery, DeliveryPr } from '@ccc/shared/protocol'
import { formatDate } from '@/lib/intent-list-view'
import {
  defaultDeliveryBranchName,
  DELIVERY_STATUS_LABEL_KEYS,
  epochMsToCalendarDate,
  isDeliveryTerminal,
  type DeliveryBranchInitPhase,
  type DeliveryBranchInitState,
} from '@/lib/delivery-view'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import DeliveryEditDialog from './DeliveryEditDialog.vue'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  delivery: Delivery
  branchInit: DeliveryBranchInitState | null
  workspaceGitBranchMode: 'worktree' | 'current-branch'
  /** How far mainline is ahead of the delivery branch; null = unknown / N/A. */
  mainlineAhead: number | null
  /** How far the delivery branch is ahead of mainline; null = unknown / N/A. */
  deliveryBranchAhead: number | null
  /** In-flight 「同步主线」 phase; null = idle. */
  syncPhase: 'fetching' | 'merging' | 'pushing' | null
  /** The delivery's latest 「交付分支 → 主线」 PR; null = none opened. */
  deliveryPr: DeliveryPr | null
  /** Whether a delivery-PR create / sync round trip is in flight. */
  deliveryPrBusy: boolean
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
  'init-branch': [payload: { mode: 'create' | 'bind'; branchName: string }]
  'cleanup-branch': [deliveryId: string]
  'sync-mainline': [deliveryId: string]
  'create-delivery-pr': [deliveryId: string]
  'sync-delivery-pr': [deliveryId: string]
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

// ---- Merge section (交付 PR) ----
//
// Only ever shown in `worktree` mode: `current-branch` has no delivery branch, so
// there is nothing to propose for mainline. It appears from `verified` on, and
// stays visible afterwards so the PR that delivered the batch remains linkable.
const showMergeBlock = computed(
  () =>
    props.workspaceGitBranchMode === 'worktree' &&
    (props.delivery.status === 'verified' ||
      props.delivery.status === 'delivered' ||
      props.deliveryPr !== null),
)

/** No PR yet, or the last one was closed — the delivery PR is there to be opened. */
const canCreateDeliveryPr = computed(
  () =>
    props.delivery.status === 'verified' &&
    (props.deliveryPr === null || props.deliveryPr.status === 'closed'),
)

/**
 * When the merge block renders but the create button does not, list the state
 * facts that gate it, one per line — so "why is the button gone" is answered by
 * the page itself instead of being a mystery. Pure read of props, no logic.
 */
const diagnosisFacts = computed<
  { key: 'branchMode' | 'status' | 'branch' | 'pr' | 'diff'; text: string }[]
>(() => {
  const branch =
    props.delivery.branchReady && props.delivery.branchName
      ? t('delivery.deliveryPr.diagnosis.branch.label', { branch: props.delivery.branchName })
      : t('delivery.deliveryPr.diagnosis.branchNotReady.label')
  const pr = props.deliveryPr
    ? t('delivery.deliveryPr.diagnosis.pr.label', {
        number: props.deliveryPr.number,
        status: t(DELIVERY_PR_STATUS_KEYS[props.deliveryPr.status]),
      })
    : t('delivery.deliveryPr.diagnosis.prNone.label')
  const ahead = props.deliveryBranchAhead
  const diff =
    ahead === null
      ? t('delivery.deliveryPr.diagnosis.diff.unknown.label')
      : ahead > 0
        ? t('delivery.deliveryPr.diagnosis.diff.ahead.label', { count: ahead })
        : t('delivery.deliveryPr.diagnosis.diff.none.label')
  const mode =
    props.workspaceGitBranchMode === 'worktree'
      ? t('workspaceSetting.gitBranchMode.option.worktree.label')
      : t('workspaceSetting.gitBranchMode.option.currentBranch.label')
  return [
    {
      key: 'branchMode',
      text: t('delivery.deliveryPr.diagnosis.branchMode.label', { mode }),
    },
    {
      key: 'status',
      text: t('delivery.deliveryPr.diagnosis.status.label', {
        status: t(DELIVERY_STATUS_LABEL_KEYS[props.delivery.status]),
      }),
    },
    { key: 'branch', text: branch },
    { key: 'pr', text: pr },
    { key: 'diff', text: diff },
  ]
})

/**
 * The forge says merged while c3 still says `verified` — the acknowledged
 * awareness window. Syncing settles it; the banner exists so the state does not
 * read as "stuck".
 */
const awaitingConfirmation = computed(
  () => props.deliveryPr?.status === 'merged' && props.delivery.status !== 'delivered',
)

/**
 * 「合并受阻」 — the code is fine, an external condition is not. Deliberately NOT
 * a status rollback: making the user re-verify because CI is red would waste the
 * verification they already did.
 */
const blockedReasonLabel = computed(() => {
  const reason = props.deliveryPr?.blockedReason
  if (!reason || props.deliveryPr?.status !== 'reviewing') return ''
  return reason === 'ci_failed'
    ? t('delivery.deliveryPr.blocked.ciFailed.label')
    : t('delivery.deliveryPr.blocked.approval.label')
})

const conflictFiles = computed(() => props.deliveryPr?.conflictFiles ?? [])

const DELIVERY_PR_STATUS_KEYS: Record<DeliveryPr['status'], LocaleKey> = {
  reviewing: 'delivery.deliveryPr.status.reviewing.label',
  merged: 'delivery.deliveryPr.status.merged.label',
  closed: 'delivery.deliveryPr.status.closed.label',
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

// ---- Edit dialog ----
//
// 概览只持有 open 状态与「编辑」入口;字段、预填与日期编码整体在弹窗里,
// 保存后的 update 载荷与内联表单时期一字不差。
const editOpen = ref(false)

function saveEdit(payload: {
  title: string
  description: string
  startDate: number | null
  endDate: number | null
}): void {
  editOpen.value = false
  emit('update', { deliveryId: props.delivery.id, ...payload })
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

    <!-- 合并区(仅 worktree):建交付 PR / PR 链接与状态 / 等待确认 / 合并受阻 /
         冲突文件 / 手动同步。合并本身在 forge 上由人完成,c3 从不代合。 -->
    <div v-if="showMergeBlock" class="delivery-merge-block" data-testid="delivery-merge-block">
      <p class="delivery-branch-title">{{ t('delivery.deliveryPr.title.label') }}</p>

      <p v-if="!props.deliveryPr" class="delivery-merge-hint" data-testid="delivery-merge-intro">
        {{ t('delivery.deliveryPr.intro.label', { base: props.delivery.baseBranch }) }}
      </p>

      <div v-else class="delivery-merge-pr" data-testid="delivery-merge-pr">
        <a
          v-if="props.deliveryPr.url"
          class="delivery-merge-pr-link"
          :href="props.deliveryPr.url"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="delivery-merge-pr-link"
        >
          {{ t('delivery.deliveryPr.link.label', { number: props.deliveryPr.number }) }}
        </a>
        <span v-else class="delivery-merge-pr-link" data-testid="delivery-merge-pr-number">
          {{ t('delivery.deliveryPr.link.label', { number: props.deliveryPr.number }) }}
        </span>
        <span class="delivery-merge-pr-status">
          {{ t(DELIVERY_PR_STATUS_KEYS[props.deliveryPr.status]) }}
        </span>
      </div>

      <p
        v-if="awaitingConfirmation"
        class="delivery-merge-awaiting"
        data-testid="delivery-merge-awaiting"
      >
        {{ t('delivery.deliveryPr.awaiting.label') }}
      </p>

      <p
        v-if="blockedReasonLabel"
        class="delivery-merge-blocked"
        data-testid="delivery-merge-blocked"
      >
        {{ blockedReasonLabel }}
      </p>

      <div
        v-if="conflictFiles.length"
        class="delivery-merge-conflicts"
        data-testid="delivery-merge-conflicts"
      >
        <p class="delivery-merge-hint">
          {{ t('delivery.deliveryPr.conflict.label', { count: conflictFiles.length }) }}
        </p>
        <ul class="delivery-merge-conflict-list">
          <li v-for="file in conflictFiles" :key="file">{{ file }}</li>
        </ul>
      </div>

      <div class="delivery-merge-actions">
        <button
          v-if="canCreateDeliveryPr"
          type="button"
          class="delivery-branch-init-btn"
          :disabled="props.deliveryPrBusy"
          data-testid="delivery-create-pr-btn"
          @click="emit('create-delivery-pr', props.delivery.id)"
        >
          {{ t('delivery.deliveryPr.create.label') }}
        </button>
        <button
          v-if="props.deliveryPr"
          type="button"
          class="delivery-sync-btn"
          :disabled="props.deliveryPrBusy"
          data-testid="delivery-sync-pr-btn"
          @click="emit('sync-delivery-pr', props.delivery.id)"
        >
          {{ t('delivery.deliveryPr.sync.label') }}
        </button>
        <p v-if="props.deliveryPrBusy" class="delivery-branch-progress">
          {{ t('delivery.deliveryPr.running.label') }}
        </p>
      </div>

      <!-- 按钮未显示时的逐条事实诊断:合并区渲染但 canCreateDeliveryPr 为 false,
           把门控的每条状态事实列出来,「为何按钮消失」由页面自己回答。 -->
      <div
        v-if="!canCreateDeliveryPr"
        class="delivery-pr-diagnosis"
        data-testid="delivery-pr-not-shown-diagnosis"
      >
        <p class="delivery-pr-diagnosis-title">
          {{ t('delivery.deliveryPr.diagnosis.title.label') }}
        </p>
        <ul class="delivery-pr-diagnosis-list">
          <li
            v-for="fact in diagnosisFacts"
            :key="fact.key"
            class="delivery-pr-diagnosis-fact"
            :data-testid="`delivery-pr-diagnosis-${fact.key}`"
          >
            {{ fact.text }}
          </li>
        </ul>
      </div>
    </div>

    <dl class="delivery-meta" data-testid="delivery-meta">
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
        <dd>
          <a
            v-if="props.deliveryPr?.url"
            :href="props.deliveryPr.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('delivery.deliveryPr.link.label', { number: props.deliveryPr.number }) }}
          </a>
          <template v-else-if="props.deliveryPr">
            {{ t('delivery.deliveryPr.link.label', { number: props.deliveryPr.number }) }}
          </template>
          <template v-else>—</template>
        </dd>
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

    <div class="delivery-overview-actions">
      <button
        type="button"
        class="delivery-edit-btn"
        data-testid="delivery-edit-btn"
        @click="editOpen = true"
      >
        {{ t('delivery.action.edit.label') }}
      </button>
    </div>

    <DeliveryEditDialog
      :open="editOpen"
      :delivery="props.delivery"
      @confirm="saveEdit"
      @cancel="editOpen = false"
    />
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
.delivery-merge-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-merge-hint {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text-muted);
}
.delivery-merge-pr {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-body);
}
.delivery-merge-pr-link {
  color: var(--c-primary-text);
  word-break: break-all;
}
.delivery-merge-pr-status {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-1);
}
.delivery-merge-awaiting,
.delivery-merge-blocked {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-warning-text);
}
.delivery-merge-conflicts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.delivery-merge-conflict-list {
  margin: 0;
  padding-left: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--c-text);
  word-break: break-all;
}
.delivery-merge-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
/* 诊断块:按钮未显示时的事实列表。中性提示区,不带错误红/警告橙——它只是在陈述
   门控的状态,不是在报错。信息不依赖颜色:每行本身就是完整的可读句子。 */
.delivery-pr-diagnosis {
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px dashed var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-card);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-pr-diagnosis-title {
  margin: 0 0 var(--sp-1);
  font-weight: 600;
}
.delivery-pr-diagnosis-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.delivery-pr-diagnosis-fact {
  overflow-wrap: anywhere;
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
.delivery-edit-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: #fff;
  background: var(--c-primary);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
</style>
