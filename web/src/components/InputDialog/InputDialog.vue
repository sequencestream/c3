<script setup lang="ts">
/*
 * InputDialog.vue — 受控的「单行文本输入」模态框(ConfirmDialog 风格 + 单行 input)。
 *
 * 用于替换 window.prompt 一类「弹框收集一行文本」的场景(如新增工作区收集绝对路径)。
 * 沿用 ConfirmDialog 的受控模态范式(父持 open 状态、遮罩/Esc/取消均 emit cancel、移动端
 * 全屏 sheet),但确认携带输入文本。与 ResetSessionDialog 的区别:此处是单行 input(路径等
 * 短文本),而非多行 textarea(意图引导)。
 *
 * 输入为空(去空白后)时确认按钮禁用。打开时聚焦输入框并清空上次内容;Enter 提交。
 * 标题/占位/按钮文案由 props 注入,保证 i18n 与上下文一致。
 */
import { ref, watch, nextTick, computed } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  placeholder: string
  confirmLabel: string
  cancelLabel: string
}>()

const emit = defineEmits<{
  confirm: [text: string]
  cancel: []
}>()

const text = ref('')
const input = ref<HTMLInputElement | null>(null)
const canConfirm = computed<boolean>(() => text.value.trim().length > 0)

// 每次打开:清空上次输入并聚焦输入框(便于直接键入)。
watch(
  () => props.open,
  (open) => {
    if (open) {
      text.value = ''
      nextTick(() => input.value?.focus())
    }
  },
)

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm', text.value.trim())
}
</script>

<template>
  <div
    v-if="open"
    class="id-overlay"
    data-testid="input-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div class="id-modal" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="id-title">{{ title }}</h3>
      <input
        ref="input"
        v-model="text"
        class="id-input"
        type="text"
        data-testid="input-field"
        :placeholder="placeholder"
        @keydown.enter="onConfirm"
      />
      <div class="id-foot">
        <button class="id-cancel" data-testid="input-cancel" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          class="id-confirm"
          data-testid="input-accept"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.id-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.id-modal {
  max-width: 460px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.id-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.id-input {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: var(--c-bg-elevated, var(--c-bg));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  padding: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.id-input:focus {
  outline: none;
  border-color: var(--c-accent, var(--c-text));
}
.id-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.id-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.id-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.id-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog / ResetSessionDialog 范式)。 */
@media (max-width: 767px) {
  .id-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .id-modal {
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
  .id-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
