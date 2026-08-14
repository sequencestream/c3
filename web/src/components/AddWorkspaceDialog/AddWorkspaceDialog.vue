<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  confirm: [payload: { workspaceName: string; path: string }]
  cancel: []
}>()
const { t } = useTypedI18n()
const path = ref('')
const workspaceName = ref('')
const nameEdited = ref(false)
const pathInput = ref<HTMLInputElement | null>(null)

const normalizedName = computed(() => workspaceName.value.trim())
const nameLength = computed(() => Array.from(normalizedName.value).length)
const canConfirm = computed(
  () => path.value.trim().length > 0 && nameLength.value >= 1 && nameLength.value <= 64,
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    path.value = ''
    workspaceName.value = ''
    nameEdited.value = false
    nextTick(() => pathInput.value?.focus())
  },
)

function inferredName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

function onPathInput(): void {
  if (!nameEdited.value) workspaceName.value = inferredName(path.value)
}

function onNameInput(): void {
  nameEdited.value = true
}

function confirm(): void {
  if (!canConfirm.value) return
  emit('confirm', { workspaceName: normalizedName.value, path: path.value.trim() })
}
</script>

<template>
  <div
    v-if="open"
    class="awd-overlay"
    data-testid="input-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="awd-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('nav.workspace.add.prompt')"
    >
      <h3 class="awd-title">{{ t('nav.workspace.add.prompt') }}</h3>
      <label class="awd-label" for="workspace-path">{{ t('nav.workspace.add.pathLabel') }}</label>
      <input
        id="workspace-path"
        ref="pathInput"
        v-model="path"
        class="awd-input"
        data-testid="input-field"
        :placeholder="t('nav.workspace.add.placeholder')"
        @input="onPathInput"
      />
      <label class="awd-label" for="workspace-name">{{ t('nav.workspace.add.nameLabel') }}</label>
      <input
        id="workspace-name"
        v-model="workspaceName"
        class="awd-input"
        data-testid="workspace-name-field"
        :placeholder="t('nav.workspace.add.namePlaceholder')"
        @input="onNameInput"
        @keydown.enter="confirm"
      />
      <div class="awd-foot">
        <button data-testid="input-cancel" class="awd-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button data-testid="input-accept" :disabled="!canConfirm" @click="confirm">
          {{ t('nav.workspace.add.confirmLabel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.awd-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.awd-modal {
  width: min(90vw, 460px);
  padding: var(--sp-4);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.awd-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
}
.awd-label {
  display: block;
  margin-bottom: var(--sp-1);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}
.awd-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: var(--sp-3);
  padding: var(--sp-2);
  color: var(--c-text);
  background: var(--c-bg-elevated, var(--c-bg));
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  font: inherit;
}
.awd-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.awd-cancel {
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
@media (max-width: 767px) {
  .awd-overlay {
    align-items: stretch;
    background: var(--c-bg);
  }
  .awd-modal {
    width: 100vw;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
  }
  .awd-foot {
    margin-top: auto;
  }
}
</style>
