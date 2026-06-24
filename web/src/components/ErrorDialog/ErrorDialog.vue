<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  message: string
  closeLabel: string
}>()

const emit = defineEmits<{
  close: []
}>()

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
      <p class="ed-message">{{ message }}</p>
      <div class="ed-foot">
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
.ed-foot {
  display: flex;
  justify-content: flex-end;
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
