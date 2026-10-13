<script setup lang="ts">
/*
 * AddWorkspaceDialog.vue — 新增工作区弹框。
 *
 * 路径可直接输入,也可点「选择目录」由服务端在自己所在主机弹系统原生目录对话框。
 * 选中的绝对路径回填到输入框;服务端在登记时验证路径是否为已有目录。
 *
 * 三种回复各有归宿:
 *   - 选中 —— 回填路径,并按既有 basename 规则推断名称(用户已改过名称就不覆盖)。
 *   - 取消 —— 什么都不做。用户在系统对话框里按了取消不是错误,不清空、不提示。
 *   - 调起失败 —— 就地给出本地化说明,用户仍可直接输入路径。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'

const props = defineProps<{
  open: boolean
  /** 原生目录对话框正在打开中:此间禁止重复请求与保存。 */
  pickerPending: boolean
  /** 已本地化的调起失败说明;null 表示这次没有失败。 */
  pickerError: string | null
  /** 最近一次选中的目录。每次选中都是新对象,故重复选中同一路径也会触发回填。 */
  pickerSelection: { path: string } | null
}>()
const emit = defineEmits<{
  confirm: [payload: { workspaceName: string; path: string }]
  cancel: []
  selectDirectory: []
}>()
const { t } = useTypedI18n()
const path = ref('')
const workspaceName = ref('')
const nameEdited = ref(false)
const pathInput = ref<HTMLInputElement | null>(null)

const normalizedName = computed(() => workspaceName.value.trim())
const nameLength = computed(() => Array.from(normalizedName.value).length)
const canConfirm = computed(
  () =>
    !props.pickerPending &&
    path.value.trim().length > 0 &&
    nameLength.value >= 1 &&
    nameLength.value <= 64,
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    path.value = ''
    workspaceName.value = ''
    nameEdited.value = false
    void nextTick(() => pathInput.value?.focus())
  },
)

watch(
  () => props.pickerSelection,
  (selection) => {
    if (!selection) return
    path.value = selection.path
    if (!nameEdited.value) workspaceName.value = inferredName(selection.path)
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
        @keydown.enter="confirm"
      />
      <button
        class="awd-pick"
        data-testid="select-directory"
        :disabled="pickerPending"
        @click="emit('selectDirectory')"
      >
        {{
          pickerPending
            ? t('nav.workspace.add.selectDirectory.pending.label')
            : t('nav.workspace.add.selectDirectory.label')
        }}
      </button>
      <p v-if="pickerError" class="awd-picker-error" data-testid="picker-error" role="alert">
        {{ pickerError }}
      </p>
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
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  font: inherit;
}
.awd-pick {
  margin-bottom: var(--sp-3);
}
.awd-picker-error {
  margin: calc(-1 * var(--sp-2)) 0 var(--sp-3);
  color: var(--c-error-text);
  font-size: var(--fs-caption);
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
