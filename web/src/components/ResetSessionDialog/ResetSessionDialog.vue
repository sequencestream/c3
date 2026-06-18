<script setup lang="ts">
/*
 * ResetSessionDialog.vue — 受控的「重置会话」输入弹框(ConfirmDialog 风格 + 输入框)。
 *
 * 用于 intent session / spec session 的重置:用户在输入框写下新的引导内容,确认后由调用方
 * 以「新输入 + 意图/spec 内容」拼接新起会话。沿用 ConfirmDialog 的受控模态范式(父持 open
 * 状态、遮罩/Esc/取消均 emit cancel、移动端全屏 sheet),但确认携带输入文本。
 *
 * 输入为空(去空白后)时确认按钮禁用——重置必须带着新的引导意图。打开时聚焦输入框并清空上次内容。
 */
import { ref, watch, nextTick, computed } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  message: string
  placeholder: string
  confirmLabel: string
  cancelLabel: string
}>()

const emit = defineEmits<{
  confirm: [text: string]
  cancel: []
}>()

const text = ref('')
const input = ref<HTMLTextAreaElement | null>(null)
const canConfirm = computed<boolean>(() => text.value.trim().length > 0)

// 每次打开:清空上次输入并聚焦输入框(便于直接键入新内容)。
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
    class="rs-overlay"
    data-testid="reset-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div class="rs-modal" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="rs-title">{{ title }}</h3>
      <p class="rs-message">{{ message }}</p>
      <textarea
        ref="input"
        v-model="text"
        class="rs-input"
        data-testid="reset-input"
        :placeholder="placeholder"
        rows="4"
      />
      <div class="rs-foot">
        <button class="rs-cancel" data-testid="reset-cancel" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          class="rs-confirm"
          data-testid="reset-accept"
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
.rs-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.rs-modal {
  max-width: 520px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-5);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.rs-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.rs-message {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text-muted);
  white-space: pre-line;
  word-break: break-word;
}
.rs-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: var(--c-bg-elevated, var(--c-bg));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  padding: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.rs-input:focus {
  outline: none;
  border-color: var(--c-accent, var(--c-text));
}
.rs-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.rs-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.rs-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.rs-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog / SkillApprovalModal 范式)。 */
@media (max-width: 767px) {
  .rs-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .rs-modal {
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
  .rs-input {
    flex: 1;
  }
  .rs-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
