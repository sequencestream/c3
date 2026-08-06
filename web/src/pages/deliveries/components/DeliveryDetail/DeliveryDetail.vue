<script setup lang="ts">
/*
 * DeliveryDetail.vue — 交付详情容器。
 *
 * 常驻标题栏(交付标题 + 状态徽标 + 取消动作)跨 tab 不变;其下仅两个 Tab:
 * 概览(状态分段选择器 + 常驻缺口 + 元信息)与关联意图。不设 PR/设置/分支独立
 * Tab。状态推进/返工/取消一律上抛由控制层发 WS,服务端回包为准 —— 本组件不自行
 * 复制状态规则。取消走 danger ConfirmDialog(web 规范,不用 window.confirm)。
 */
import { ref, computed, nextTick } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { Delivery, DeliveryStatus, DeliveryTransitionPlan } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import { DELIVERY_STATUS_LABEL_KEYS, type DeliveryBranchInitState } from '@/lib/delivery-view'
import DeliveryOverviewTab from './DeliveryOverviewTab.vue'
import DeliveryIntentsTab from './DeliveryIntentsTab.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  delivery: Delivery
  plan: DeliveryTransitionPlan
  branchInit: DeliveryBranchInitState | null
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
  cancel: [deliveryId: string]
  transition: [to: DeliveryStatus, confirmVerified: boolean]
  'init-branch': [payload: { mode: 'create' | 'bind'; branchName: string }]
  'cleanup-branch': [deliveryId: string]
  'open-workspace-settings': []
}>()

const TAB_OVERVIEW = 'overview' as const
const TAB_INTENTS = 'intents' as const
type DeliveryTabKind = typeof TAB_OVERVIEW | typeof TAB_INTENTS

// Tab 选中态是页面内部展示状态,不写回 App/协议。概览 → 关联意图的缺口跳转由此切换。
const activeTab = ref<DeliveryTabKind>(TAB_OVERVIEW)

const cancelOpen = ref(false)

function statusLabel(status: DeliveryStatus): string {
  return t(DELIVERY_STATUS_LABEL_KEYS[status])
}

// The overview tab's branch-init section, so a `branchNotReady` gap jump can
// focus it (scroll + focus the input).
const overviewRef = ref<InstanceType<typeof DeliveryOverviewTab> | null>(null)

// 缺口跳转:关联意图 → 切到关联意图 tab;分支未就绪 → 切到概览并聚焦分支初始化区;
// 工作区设置 → 上抛由 App 打开设置页。
function onJump(target: 'associated-intents' | 'workspace-settings' | 'branch'): void {
  if (target === 'associated-intents') {
    activeTab.value = TAB_INTENTS
  } else if (target === 'branch') {
    activeTab.value = TAB_OVERVIEW
    void nextTick(() => overviewRef.value?.focusBranchInit?.())
  } else {
    emit('open-workspace-settings')
  }
}

// 终态说明文案:已发布 / 已取消。
const terminalNote = computed<{ label: string; params?: Record<string, unknown> } | null>(() => {
  if (props.delivery.status === 'delivered') {
    return {
      label: t('delivery.page.terminalDelivered.label', { baseBranch: props.delivery.baseBranch }),
    }
  }
  if (props.delivery.status === 'cancelled') {
    return { label: t('delivery.page.terminalCancelled.label') }
  }
  return null
})
</script>

<template>
  <div class="delivery-detail">
    <div class="delivery-detail-head">
      <h2 class="delivery-detail-title" :title="props.delivery.title">
        {{ props.delivery.title }}
      </h2>
      <span
        class="delivery-detail-status"
        :class="props.delivery.status"
        :data-testid="`delivery-detail-status-${props.delivery.status}`"
      >
        {{ statusLabel(props.delivery.status) }}
      </span>
      <button
        type="button"
        class="delivery-cancel-btn"
        data-testid="delivery-cancel-btn"
        @click="cancelOpen = true"
      >
        {{ t('delivery.action.cancel.label') }}
      </button>
    </div>

    <p v-if="terminalNote" class="delivery-terminal-note" data-testid="delivery-terminal-note">
      {{ terminalNote.label }}
    </p>

    <nav class="delivery-pane-tabs" data-testid="delivery-pane-tabs">
      <button
        type="button"
        class="delivery-pane-tab"
        :class="{ active: activeTab === TAB_OVERVIEW }"
        :data-testid="`delivery-pane-tab-${TAB_OVERVIEW}`"
        :aria-pressed="activeTab === TAB_OVERVIEW"
        @click="activeTab = TAB_OVERVIEW"
      >
        {{ t('delivery.page.tab.overview.label') }}
      </button>
      <button
        type="button"
        class="delivery-pane-tab"
        :class="{ active: activeTab === TAB_INTENTS }"
        :data-testid="`delivery-pane-tab-${TAB_INTENTS}`"
        :aria-pressed="activeTab === TAB_INTENTS"
        @click="activeTab = TAB_INTENTS"
      >
        {{ t('delivery.page.tab.intents.label') }}
      </button>
    </nav>

    <DeliveryOverviewTab
      v-if="activeTab === TAB_OVERVIEW"
      ref="overviewRef"
      :delivery="props.delivery"
      :plan="props.plan"
      :branch-init="props.branchInit"
      :workspace-git-branch-mode="props.workspaceGitBranchMode"
      @update="(p) => emit('update', p)"
      @transition="(to, confirm) => emit('transition', to, confirm)"
      @init-branch="(payload) => emit('init-branch', payload)"
      @cleanup-branch="(id: string) => emit('cleanup-branch', id)"
      @jump="onJump"
    />
    <DeliveryIntentsTab v-else :delivery="props.delivery" />

    <ConfirmDialog
      :open="cancelOpen"
      :title="t('delivery.action.cancelTitle.label')"
      :message="t('delivery.action.cancelBody.label', { title: props.delivery.title })"
      :confirm-label="t('delivery.action.cancel.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="
        () => {
          cancelOpen = false
          emit('cancel', props.delivery.id)
        }
      "
      @cancel="cancelOpen = false"
    />
  </div>
</template>

<style scoped>
.delivery-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.delivery-detail-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.delivery-detail-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delivery-detail-status {
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-2);
}
.delivery-cancel-btn {
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
.delivery-terminal-note {
  margin: 0;
  padding: var(--sp-2) var(--sp-4);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
  background: var(--c-card);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.delivery-pane-tabs {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--c-border);
  padding: 0 var(--sp-2);
}
.delivery-pane-tab {
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
}
.delivery-pane-tab:hover {
  color: var(--c-text);
}
.delivery-pane-tab.active {
  color: var(--c-primary-text);
  border-bottom-color: var(--c-primary);
}
</style>
