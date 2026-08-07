<script setup lang="ts">
/*
 * DeliveryEditDialog.vue — 交付编辑弹窗(标题/描述/起止日期)。
 *
 * 取代概览 tab 里的内联编辑表单:编辑与阅读不再挤在同一容器,展开长字段也不会
 * 让整页布局跳动。受控模态范式沿用 InputDialog/ConfirmDialog(父持 open、遮罩/
 * Esc/取消一律 emit cancel、移动端全屏 sheet),差别只在承载的是一组字段。
 *
 * 每次打开以当前交付值重新预填并聚焦标题,取消不写回任何字段——因此不会残留上次
 * 草稿。标题去空白后非空才允许保存;日期以「日历日 → UTC 零点 epoch」编码,留空落
 * null,与内联表单时期的载荷完全一致。
 *
 * 宽度取设计规范的弹窗默认值:页面宽度的二分之一(上下限兜住超宽屏与窄屏),移动
 * 端由全屏 sheet 规则接管。
 */
import { ref, watch, nextTick, computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { Delivery } from '@ccc/shared/protocol'
import { calendarDateToEpochMs, epochMsToCalendarDate } from '@/lib/delivery-view'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  delivery: Delivery
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

// 每次打开以当前交付值重新预填(而非沿用上次草稿)并聚焦标题。
watch(
  () => props.open,
  (open) => {
    if (!open) return
    title.value = props.delivery.title
    description.value = props.delivery.description
    startDate.value = epochMsToCalendarDate(props.delivery.startDate)
    endDate.value = epochMsToCalendarDate(props.delivery.endDate)
    void nextTick(() => titleInput.value?.focus())
  },
  { immediate: true },
)

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm', {
    title: title.value.trim(),
    description: description.value,
    startDate: startDate.value ? calendarDateToEpochMs(startDate.value) : null,
    endDate: endDate.value ? calendarDateToEpochMs(endDate.value) : null,
  })
}
</script>

<template>
  <div
    v-if="props.open"
    class="de-overlay"
    data-testid="delivery-edit-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="de-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('delivery.action.editTitle.label')"
      data-testid="delivery-edit-dialog"
    >
      <h3 class="de-title">{{ t('delivery.action.editTitle.label') }}</h3>

      <form class="de-form" data-testid="delivery-edit-form" @submit.prevent="onConfirm">
        <label class="de-field">
          <span>{{ t('delivery.action.form.titleLabel.label') }}</span>
          <input
            ref="titleInput"
            v-model="title"
            type="text"
            data-testid="delivery-edit-title"
            :placeholder="t('delivery.action.form.titlePlaceholder.label')"
          />
        </label>
        <label class="de-field">
          <span>{{ t('delivery.action.form.descriptionLabel.label') }}</span>
          <textarea
            v-model="description"
            rows="4"
            data-testid="delivery-edit-desc"
            :placeholder="t('delivery.action.form.descriptionPlaceholder.label')"
          />
        </label>
        <div class="de-row">
          <label class="de-field">
            <span>{{ t('delivery.action.form.startDateLabel.label') }}</span>
            <input v-model="startDate" type="date" data-testid="delivery-edit-start" />
          </label>
          <label class="de-field">
            <span>{{ t('delivery.action.form.endDateLabel.label') }}</span>
            <input v-model="endDate" type="date" data-testid="delivery-edit-end" />
          </label>
        </div>
      </form>

      <div class="de-foot">
        <button class="de-cancel" data-testid="delivery-edit-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          class="de-confirm"
          data-testid="delivery-edit-save"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          {{ t('delivery.action.save.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.de-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
/* 弹窗默认宽度 = 页面宽度的二分之一(设计规范);上下限只兜住超宽屏拉成长条与
   窄屏挤没两种极端,不改变默认值本身。 */
.de-modal {
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
.de-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.de-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.de-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.de-field input,
.de-field textarea {
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
.de-field input:focus,
.de-field textarea:focus {
  outline: none;
  border-color: var(--c-primary);
}
.de-row {
  display: flex;
  gap: var(--sp-3);
}
.de-row .de-field {
  flex: 1;
  min-width: 0;
}
.de-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.de-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.de-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.de-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog / InputDialog 范式),页脚按钮吸底。 */
@media (max-width: 767px) {
  .de-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .de-modal {
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
  .de-row {
    flex-direction: column;
  }
  .de-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
