<script setup lang="ts">
/*
 * DeliveryStatusSelector.vue — 状态分段选择器 + 常驻缺口说明。
 *
 * 分段选择器只含「当前状态 + 合法推进/回退目标」(非法目标不出现):可执行目标
 * 亮起可点,守卫未满足或系统专属的目标置灰。选择器下方常驻当前具体缺口
 * (delivery.guard.* 文案)、对应跳转入口与「集成就绪 N/M」——N/M 并入这段说明,
 * 不做独立进度条。所有可达性/缺口来自服务端 `transitionPlan`,本组件只渲染,
 * 不复制状态规则。verifying→verified 需显式人工确认,点击先弹 ConfirmDialog。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type {
  DeliveryIntegration,
  DeliveryStatus,
  DeliveryTargetTransition,
  DeliveryTransitionPlan,
} from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import {
  DELIVERY_STATUS_LABEL_KEYS,
  deliveryGapReasons,
  deliveryTargetInvokable,
  isDeliveryReworkTarget,
  isVerificationConfirmTarget,
} from '@/lib/delivery-view'

const { t } = useTypedI18n()

const props = defineProps<{
  status: DeliveryStatus
  plan: DeliveryTransitionPlan
  integration: DeliveryIntegration
  workspaceGitBranchMode: 'worktree' | 'current-branch'
}>()

const emit = defineEmits<{
  transition: [to: DeliveryStatus, confirmVerified: boolean]
  jump: [target: 'associated-intents' | 'workspace-settings']
}>()

// The verifying→verified confirmation gate: clicking that enabled target pops a
// ConfirmDialog; only an explicit human confirmation invokes the transition.
const confirmTarget = ref<DeliveryStatus | null>(null)

function statusLabel(status: DeliveryStatus): string {
  return t(DELIVERY_STATUS_LABEL_KEYS[status])
}

function targetLabel(target: DeliveryTargetTransition): string {
  return isDeliveryReworkTarget(props.status, target.to)
    ? t('delivery.action.rework.label')
    : statusLabel(target.to)
}

function onSelect(target: DeliveryTargetTransition): void {
  if (!deliveryTargetInvokable(target)) return
  if (isVerificationConfirmTarget(props.status, target.to)) {
    confirmTarget.value = target.to
    return
  }
  emit('transition', target.to, false)
}

function confirmVerified(): void {
  const to = confirmTarget.value
  confirmTarget.value = null
  if (to) emit('transition', to, true)
}

// Flattened, de-duplicated, guard-ordered gaps across every failed target.
// `delivery.guard.*` codes ARE the locale leaf keys — the template translates
// them directly via t(code, params).
const gaps = computed(() => deliveryGapReasons(props.plan))

function jumpLabel(target: 'associated-intents' | 'workspace-settings'): string {
  return target === 'associated-intents'
    ? t('delivery.action.jumpToIntents.label')
    : t('delivery.action.jumpToSettings.label')
}

function onJump(target: 'associated-intents' | 'workspace-settings'): void {
  emit('jump', target)
}
</script>

<template>
  <div class="delivery-status-block" data-testid="delivery-status-block">
    <div
      class="delivery-selector"
      role="group"
      aria-label="delivery status"
      data-testid="delivery-selector"
    >
      <span
        class="delivery-seg delivery-seg-current"
        :data-testid="`delivery-seg-current-${props.status}`"
      >
        {{ statusLabel(props.status) }}
      </span>
      <button
        v-for="target in props.plan.targets"
        :key="target.to"
        type="button"
        class="delivery-seg"
        :class="{
          'delivery-seg-ready': deliveryTargetInvokable(target),
          'delivery-seg-blocked': !deliveryTargetInvokable(target),
          'delivery-seg-rework': isDeliveryReworkTarget(props.status, target.to),
        }"
        :disabled="!deliveryTargetInvokable(target)"
        :title="!deliveryTargetInvokable(target) ? targetLabel(target) : undefined"
        :data-testid="`delivery-seg-${target.to}`"
        @click="onSelect(target)"
      >
        {{ targetLabel(target) }}
      </button>
    </div>

    <div v-if="gaps.length" class="delivery-gaps" data-testid="delivery-gaps">
      <p class="delivery-gaps-title">{{ t('delivery.page.gap.label') }}</p>
      <ul class="delivery-gaps-list">
        <li
          v-for="gap in gaps"
          :key="gap.code"
          class="delivery-gap"
          :data-testid="`delivery-gap-${gap.code}`"
        >
          <span class="delivery-gap-text">{{ t(gap.code as never, gap.params as never) }}</span>
          <button
            v-if="gap.jumpTo"
            type="button"
            class="delivery-gap-jump"
            @click="onJump(gap.jumpTo!)"
          >
            {{ jumpLabel(gap.jumpTo) }}
          </button>
        </li>
      </ul>
    </div>

    <!-- 「集成就绪 N/M」并入缺口说明区,不做独立进度条 -->
    <p class="delivery-ready-line" data-testid="delivery-ready-line">
      {{
        t('delivery.status.integrationReady.label', {
          merged: props.integration.merged,
          total: props.integration.total,
        })
      }}
    </p>

    <ConfirmDialog
      :open="confirmTarget !== null"
      :title="t('delivery.action.confirmVerified.label')"
      :message="t('delivery.status.verifying.label')"
      :confirm-label="t('delivery.action.confirmVerified.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmVerified"
      @cancel="confirmTarget = null"
    />
  </div>
</template>

<style scoped>
.delivery-status-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-selector {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: var(--sp-1);
}
.delivery-seg {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: default;
}
.delivery-seg-current {
  color: var(--c-primary-text);
  border-color: var(--c-primary);
  font-weight: 600;
}
.delivery-seg-ready {
  color: var(--c-primary-text);
  border-color: var(--c-primary);
  cursor: pointer;
}
.delivery-seg-ready:hover {
  background: var(--c-card);
}
.delivery-seg-blocked {
  opacity: 0.55;
  text-decoration: line-through;
  text-decoration-color: var(--c-border);
}
.delivery-seg-rework {
  border-style: dashed;
}
.delivery-gaps {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-gaps-title {
  margin: 0;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-text-muted);
}
.delivery-gaps-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.delivery-gap {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--fs-body);
}
.delivery-gap-text {
  color: var(--c-text);
}
.delivery-gap-jump {
  flex-shrink: 0;
  padding: 0;
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-primary-text);
  background: transparent;
  border: none;
  cursor: pointer;
  text-decoration: underline;
}
.delivery-ready-line {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
