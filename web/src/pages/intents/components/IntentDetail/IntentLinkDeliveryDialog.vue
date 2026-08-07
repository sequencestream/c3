<script setup lang="ts">
/*
 * IntentLinkDeliveryDialog.vue — 意图侧「关联交付」选择弹窗。
 *
 * 受控组件:open 由 IntentTitleBarActions 持有,本组件只渲染候选与上抛选择,不发消息、
 * 不判断门禁。候选过滤(排除 delivered / cancelled)是展示规则 —— 服务端 link 本身没有
 * 终态守卫,交付页入口同权,这里不代替服务端做门禁。
 *
 * 标题栏右侧的「当前意图独立交付」是本弹窗的第二个出口:一键为当前意图建一次专属交付并
 * 关联。它只在 worktree 模式渲染 —— current-branch 模式下交付侧本就不提供分支初始化与
 * 交付 PR 入口,一键创建也到不了「能建 PR」这个目的。
 */
import { computed, ref, watch } from 'vue'
import type { Delivery } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { isDeliveryTerminal } from '@/lib/delivery-view'

const props = defineProps<{
  open: boolean
  /** 本意图所在工作区的交付列表(未过滤);终态项在此剔除。 */
  deliveries: Delivery[]
  /** 仅 worktree 模式渲染「当前意图独立交付」。 */
  standaloneEnabled: boolean
  /** 「当前意图独立交付」在飞行中:禁用按钮,防双发。 */
  standalonePending: boolean
}>()

const emit = defineEmits<{
  confirm: [deliveryId: string]
  standalone: []
  cancel: []
}>()

const { t } = useTypedI18n()

const picked = ref('')

// 候选 = 非终态交付。planned / integrating / verifying / verified 都还能接纳意图;
// delivered / cancelled 已经结账,再往里塞意图只会制造无法交付的关联。
const candidates = computed<Delivery[]>(() =>
  props.deliveries.filter((d) => !isDeliveryTerminal(d.status)),
)

// 每次打开重置选择:列表可能在关闭期间被广播刷新,留着上次的 id 会选中一个已经不在候选里的交付。
watch(
  () => props.open,
  (open) => {
    if (open) picked.value = candidates.value[0]?.id ?? ''
  },
)

function confirm(): void {
  if (!picked.value) return
  emit('confirm', picked.value)
}
</script>

<template>
  <div
    v-if="open"
    class="ild-overlay"
    data-testid="intent-link-delivery-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="ild-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('intent.linkDelivery.title.label')"
    >
      <div class="ild-head">
        <h3 class="ild-title">{{ t('intent.linkDelivery.title.label') }}</h3>
        <button
          v-if="standaloneEnabled"
          type="button"
          class="ild-standalone"
          data-testid="intent-link-delivery-standalone"
          :disabled="standalonePending"
          :title="t('intent.linkDelivery.standalone.tooltip')"
          @click="emit('standalone')"
        >
          {{ t('intent.linkDelivery.standalone.label') }}
        </button>
      </div>

      <template v-if="candidates.length">
        <label class="ild-label" for="intent-link-delivery-select">
          {{ t('intent.linkDelivery.pickerTitle.label') }}
        </label>
        <select id="intent-link-delivery-select" v-model="picked" class="ild-select">
          <option v-for="d in candidates" :key="d.id" :value="d.id">{{ d.title }}</option>
        </select>
      </template>
      <p v-else class="ild-empty" data-testid="intent-link-delivery-empty">
        {{ t('intent.linkDelivery.pickerEmpty.label') }}
      </p>

      <div class="ild-foot">
        <button type="button" class="ild-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          type="button"
          class="ild-confirm"
          data-testid="intent-link-delivery-confirm"
          :disabled="!picked"
          @click="confirm"
        >
          {{ t('intent.linkDelivery.confirm.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ild-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.ild-modal {
  width: 90vw;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.ild-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.ild-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--c-text);
}
/* 次级描边按钮:覆盖全局 button 的渐变填充,与 ConfirmDialog 的取消键同款。 */
.ild-standalone,
.ild-cancel {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ild-standalone:hover:not(:disabled),
.ild-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.ild-confirm {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ild-standalone:disabled,
.ild-confirm:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ild-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.ild-select {
  font: inherit;
  font-size: var(--fs-body);
  padding: var(--sp-2);
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.ild-empty {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}
.ild-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 移动端全屏 sheet(对齐 ConfirmDialog 范式)。 */
@media (max-width: 767px) {
  .ild-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .ild-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }
  .ild-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
