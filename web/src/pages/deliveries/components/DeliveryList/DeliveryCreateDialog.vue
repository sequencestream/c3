<script setup lang="ts">
/*
 * DeliveryCreateDialog.vue — 新建交付弹窗(标题/描述/起止日期)。
 *
 * 取代列表左栏的内联创建表单:新增不再占用列表空间,正常/窄条/移动端三种列宽下
 * 行为一致。受控模态范式沿用 DeliveryEditDialog(父持 open、遮罩/Esc/取消一律
 * emit cancel、移动端全屏 sheet),与编辑共用同一组字段文案与日期语义,但不与
 * 编辑合并成共享表单组件——新增没有预填来源,编辑入口也不该被牵动。
 *
 * 每次打开清空四个字段并聚焦标题,因此关闭再打开不残留上次草稿。标题去空白后非空
 * 才允许提交;日期以「日历日 → UTC 零点 epoch」编码,留空落 null,与内联表单时期
 * 的 create 载荷完全一致。
 *
 * 宽度取设计规范的弹窗默认值:页面宽度的二分之一(上下限兜住超宽屏与窄屏),移动
 * 端由全屏 sheet 规则接管。
 */
import { ref, watch, nextTick, computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import { calendarDateToEpochMs } from '@/lib/delivery-view'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  confirm: [
    payload: {
      title: string
      description: string
      startDate: number | null
      endDate: number | null
    },
  ]
  cancel: []
}>()

const title = ref('')
const description = ref('')
const startDate = ref('')
const endDate = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const canConfirm = computed<boolean>(() => title.value.trim().length > 0)

// 每次打开清空四个字段(而非沿用上次草稿)并聚焦标题。
watch(
  () => props.open,
  (open) => {
    if (!open) return
    title.value = ''
    description.value = ''
    startDate.value = ''
    endDate.value = ''
    void nextTick(() => titleInput.value?.focus())
  },
  { immediate: true },
)

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm', {
    title: title.value.trim(),
    description: description.value.trim(),
    startDate: startDate.value ? calendarDateToEpochMs(startDate.value) : null,
    endDate: endDate.value ? calendarDateToEpochMs(endDate.value) : null,
  })
}
</script>

<template>
  <div
    v-if="props.open"
    class="dc-overlay"
    data-testid="delivery-create-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="dc-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('delivery.action.createTitle.label')"
      data-testid="delivery-create-dialog"
    >
      <h3 class="dc-title">{{ t('delivery.action.createTitle.label') }}</h3>

      <form class="dc-form" data-testid="delivery-create-form-fields" @submit.prevent="onConfirm">
        <label class="dc-field">
          <span>{{ t('delivery.action.form.titleLabel.label') }}</span>
          <input
            ref="titleInput"
            v-model="title"
            type="text"
            data-testid="delivery-create-title"
            :placeholder="t('delivery.action.form.titlePlaceholder.label')"
          />
        </label>
        <label class="dc-field">
          <span>{{ t('delivery.action.form.descriptionLabel.label') }}</span>
          <textarea
            v-model="description"
            rows="4"
            data-testid="delivery-create-desc"
            :placeholder="t('delivery.action.form.descriptionPlaceholder.label')"
          />
        </label>
        <div class="dc-row">
          <label class="dc-field">
            <span>{{ t('delivery.action.form.startDateLabel.label') }}</span>
            <input v-model="startDate" type="date" data-testid="delivery-create-start" />
          </label>
          <label class="dc-field">
            <span>{{ t('delivery.action.form.endDateLabel.label') }}</span>
            <input v-model="endDate" type="date" data-testid="delivery-create-end" />
          </label>
        </div>
      </form>

      <div class="dc-foot">
        <button class="dc-cancel" data-testid="delivery-create-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          class="dc-confirm"
          data-testid="delivery-create-submit"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          {{ t('delivery.action.form.submit.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dc-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
/* 弹窗默认宽度 = 页面宽度的二分之一(设计规范);上下限与编辑弹窗取同一对值,只兜住
   超宽屏拉成长条与窄屏挤没两种极端,不改变默认值本身。 */
.dc-modal {
  width: 50vw;
  min-width: 420px;
  max-width: 860px;
  box-sizing: border-box;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.dc-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.dc-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.dc-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.dc-field input,
.dc-field textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  padding: var(--sp-1) var(--sp-2);
}
.dc-field input:focus,
.dc-field textarea:focus {
  outline: none;
  border-color: var(--c-primary);
}
.dc-row {
  display: flex;
  gap: var(--sp-3);
}
.dc-row .dc-field {
  flex: 1;
  min-width: 0;
}
.dc-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.dc-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.dc-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.dc-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog / InputDialog / DeliveryEditDialog 范式),
   页脚按钮吸底。 */
@media (max-width: 767px) {
  .dc-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .dc-modal {
    width: 100vw;
    min-width: 0;
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
  .dc-row {
    flex-direction: column;
  }
  .dc-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
