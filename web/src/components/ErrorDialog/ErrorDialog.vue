<script setup lang="ts">
/*
 * ErrorDialog.vue — 需要用户明确确认的失败提示。
 *
 * `message` 是主展示,`detail` 是可选的原始诊断文本(如 Git/托管平台命令的原始输出):
 * 两者都以纯文本渲染并保留换行,绝不插入 HTML;`detail` 另外限制高度并允许滚动,
 * 长输出不会把对话框撑破。
 *
 * `actionLabel` 存在时才多出一个动作按钮(如「重试原动作」),点击只上抛 `action`,
 * 由调用方决定做什么 —— 组件自身不导航、不重试。缺失即不渲染按钮,这样一个无法被
 * 识别的失败描述符只会退回到纯错误展示。
 */
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  message: string
  closeLabel: string
  /** 可选的原始错误详情;空/缺失则整块不渲染。 */
  detail?: string
  /** 详情区的标题文案;仅在有 `detail` 时使用。 */
  detailLabel?: string
  /** 可选动作按钮的文案;缺失即不渲染按钮。 */
  actionLabel?: string
}>()

const emit = defineEmits<{
  close: []
  action: []
}>()

const hasDetail = computed(() => !!props.detail && props.detail.trim() !== '')

const closeBtn = ref<HTMLButtonElement | null>(null)
watch(
  () => props.open,
  (open) => {
    if (open) nextTick(() => closeBtn.value?.focus())
  },
)
</script>

<template>
  <div
    v-if="open"
    class="ed-overlay"
    data-testid="error-dialog-overlay"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <div class="ed-modal" role="alertdialog" aria-modal="true" :aria-label="title">
      <h3 class="ed-title">{{ title }}</h3>
      <p class="ed-message" data-testid="error-dialog-message">{{ message }}</p>
      <div v-if="hasDetail" class="ed-detail" data-testid="error-dialog-detail">
        <div v-if="detailLabel" class="ed-detail-label">{{ detailLabel }}</div>
        <pre class="ed-detail-text">{{ detail }}</pre>
      </div>
      <div class="ed-foot">
        <button
          v-if="actionLabel"
          class="ed-action"
          data-testid="error-dialog-action"
          @click="emit('action')"
        >
          {{ actionLabel }}
        </button>
        <button
          ref="closeBtn"
          class="ed-close"
          data-testid="error-dialog-close"
          @click="emit('close')"
        >
          {{ closeLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ed-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.ed-modal {
  max-width: 460px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.ed-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.ed-message {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--c-text);
  white-space: pre-line;
  word-break: break-word;
}
/* 原始诊断输出:等宽、保留换行、限高可滚,长输出不撑破布局。 */
.ed-detail {
  margin: 0 0 var(--sp-4);
}
.ed-detail-label {
  margin-bottom: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.ed-detail-text {
  margin: 0;
  max-height: 30vh;
  overflow: auto;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-code);
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.ed-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 重试等可选动作:次级描边按钮(覆盖全局 button 的渐变填充),
   关闭仍是这个对话框的默认动作。 */
.ed-action {
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
}
.ed-action:hover:not(:disabled) {
  background: var(--c-hover);
  filter: none;
}

@media (max-width: 767px) {
  .ed-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .ed-modal {
    display: flex;
    flex-direction: column;
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .ed-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
