<script setup lang="ts">
/*
 * ConfirmDialog.vue — 通用二次确认模态框。
 *
 * 项目约定:删除等不可逆/危险操作的二次确认统一走该组件弹窗,不再用 window.confirm
 * (原生弹框无法承载任务名样式、移动端体验差、无法测试焦点行为)。
 *
 * 受控组件:父持有 open 状态。确认 → emit confirm;取消(点取消按钮/遮罩/Esc)→ emit cancel。
 * 标题/正文/按钮文案由调用方注入,保证 i18n 与上下文一致。danger=true 时确认按钮转危险色。
 */
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** 确认按钮是否渲染为危险色(删除等不可逆操作)。 */
  danger?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

// 打开时焦点落在「取消」:危险操作默认聚焦安全选项,误按 Enter 不会触发删除;
// 同时让 Esc 的 keydown 有承接元素(冒泡到 overlay)。
const cancelBtn = ref<HTMLButtonElement | null>(null)
watch(
  () => props.open,
  (open) => {
    if (open) nextTick(() => cancelBtn.value?.focus())
  },
)
</script>

<template>
  <div
    v-if="open"
    class="cd-overlay"
    data-testid="confirm-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div class="cd-modal" role="alertdialog" aria-modal="true" :aria-label="title">
      <h3 class="cd-title">{{ title }}</h3>
      <p class="cd-message">{{ message }}</p>
      <div class="cd-foot">
        <button
          ref="cancelBtn"
          class="cd-cancel"
          data-testid="confirm-cancel"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button
          class="cd-confirm"
          :class="{ danger }"
          data-testid="confirm-accept"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.cd-modal {
  max-width: 460px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.cd-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.cd-message {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text);
  white-space: pre-line;
  word-break: break-word;
}
.cd-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.cd-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.cd-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
/* 确认:默认主色;danger=true 时填充危险色,强调不可逆。 */
.cd-confirm.danger {
  background: var(--c-error);
  border: 1px solid var(--c-error);
  color: #fff;
}

/* 移动端全屏 sheet(对齐 SkillApprovalModal 范式)。 */
@media (max-width: 767px) {
  .cd-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .cd-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }
  .cd-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
