<script setup lang="ts">
/*
 * GateEscapeDialog.vue — 启动被闸门拦下后的「出口」弹窗。
 *
 * 与 IntentActionErrorDialog 的分工:那个只负责把失败说清楚,这个负责在说清楚之后
 * 给出用户可以做的事。两者不叠加 —— 有出口时只弹这一个。
 *
 * 两种出口形态共用一套骨架:
 *   - 依赖闸门 → 「强制放行并启动」。必须先看到风险说明才有按钮可点,因为放行的
 *     后果(合并冲突、返工)只有用户能判断值不值。
 *   - 多交付关联 → 选定本次开发针对的交付,再启动。不提供默认值。
 *
 * worktree 基线不符已不在此列:它不再拦启动,重建 / 合入两个动作改由意图详情里的
 * WorktreeBaselineBanner 常驻提供。
 *
 * 受控组件:父持有 open 状态与出口种类;本组件不发消息,只上抛用户的选择。
 */
import { computed, ref, watch } from 'vue'
import type { IntentDeliveryRef } from '@ccc/shared/protocol'
import type { GateEscape } from '@/lib/gate-escape'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  escape: GateEscape | null
  /** 已本地化的服务端拒绝文案 —— 出口之上永远先摆事实。 */
  message: string
  /** `delivery-context` 出口的候选交付;其它出口忽略。 */
  deliveries?: IntentDeliveryRef[]
}>()

const emit = defineEmits<{
  cancel: []
  /** 强制放行依赖闸门并重新启动。 */
  forceDependency: [intentId: string]
  /** 以选定的交付上下文重新启动。 */
  chooseDelivery: [intentId: string, deliveryId: string]
}>()

const chosen = ref<string | null>(null)
watch(
  () => props.escape,
  () => {
    chosen.value = null
  },
)

const open = computed(() => props.escape !== null)

const title = computed(() => {
  switch (props.escape?.kind) {
    case 'dependency':
      return t('intent.gateEscape.dependency.title.label')
    case 'delivery-context':
      return t('intent.gateEscape.deliveryContext.title.label')
    default:
      return ''
  }
})

/** 风险说明:只有依赖闸门这一处存在「知情后仍可继续」的选择。 */
const risk = computed(() =>
  props.escape?.kind === 'dependency' ? t('intent.gateEscape.dependency.risk.label') : null,
)
</script>

<template>
  <div
    v-if="open && escape"
    class="ge-overlay"
    data-testid="gate-escape-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div class="ge-modal" role="alertdialog" aria-modal="true" :aria-label="title">
      <h3 class="ge-title">{{ title }}</h3>
      <p class="ge-message">{{ message }}</p>
      <p v-if="risk" class="ge-risk" data-testid="gate-escape-risk">{{ risk }}</p>

      <div v-if="escape.kind === 'delivery-context'" class="ge-picker">
        <label
          v-for="d in deliveries ?? []"
          :key="d.id"
          class="ge-option"
          :class="{ active: chosen === d.id }"
        >
          <input v-model="chosen" type="radio" :value="d.id" name="gate-escape-delivery" />
          <span>{{ d.title }}</span>
        </label>
      </div>

      <div class="ge-foot">
        <button class="ge-cancel" data-testid="gate-escape-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>

        <template v-if="escape.kind === 'dependency'">
          <button
            class="ge-confirm danger"
            data-testid="gate-escape-force"
            @click="emit('forceDependency', escape.intentId)"
          >
            {{ t('intent.gateEscape.dependency.confirm.label') }}
          </button>
        </template>

        <template v-else>
          <button
            class="ge-confirm"
            data-testid="gate-escape-choose"
            :disabled="!chosen"
            @click="chosen && emit('chooseDelivery', escape.intentId, chosen)"
          >
            {{ t('intent.gateEscape.deliveryContext.confirm.label') }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ge-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.ge-modal {
  max-width: 520px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}

.ge-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}

.ge-message {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text);
  white-space: pre-line;
  word-break: break-word;
}

/* 风险说明:警示色描边 + 警示文字色,和普通说明拉开层级。 */
.ge-risk {
  margin: var(--sp-3) 0 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-md, 6px);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-warning-text);
}

.ge-picker {
  margin-top: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.ge-option {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  font-size: var(--fs-caption);
  color: var(--c-text);
  cursor: pointer;
}

.ge-option.active {
  border-color: var(--c-accent, var(--c-text));
}

.ge-foot {
  margin-top: var(--sp-4);
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.ge-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}

.ge-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}

/* 危险动作(强制放行 / 重建 worktree)填充危险色,强调后果不可逆。 */
.ge-confirm.danger {
  background: var(--c-error-text);
  border: 1px solid var(--c-error-text);
  color: #fff;
}

.ge-foot button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog 范式)。 */
@media (max-width: 767px) {
  .ge-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }

  .ge-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    overflow-y: auto;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }
}
</style>
