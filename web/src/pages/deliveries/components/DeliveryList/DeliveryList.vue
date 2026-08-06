<script setup lang="ts">
/*
 * DeliveryList.vue — 交付列表(左栏)。
 *
 * 头部「新建交付」按钮展开内联创建表单(标题/描述/起止日历日期,纯本地数据
 * 动作,不触网)。行 = 标题 + 状态徽标 + 集成就绪 N/M,点击 emit open 上抛。
 */
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { Delivery, DeliveryStatus } from '@ccc/shared/protocol'
import { DELIVERY_STATUS_LABEL_KEYS, calendarDateToEpochMs } from '@/lib/delivery-view'

const { t } = useTypedI18n()

const props = defineProps<{
  deliveries: Delivery[]
  activeId: string | null
}>()

const emit = defineEmits<{
  open: [deliveryId: string]
  create: [
    payload: {
      title: string
      description?: string
      startDate?: number | null
      endDate?: number | null
    },
  ]
}>()

function statusLabel(status: DeliveryStatus): string {
  return t(DELIVERY_STATUS_LABEL_KEYS[status])
}

// ---- Inline create form ----
const formOpen = ref(false)
const formTitle = ref('')
const formDescription = ref('')
const formStart = ref('')
const formEnd = ref('')

function submitCreate(): void {
  const title = formTitle.value.trim()
  if (!title) return
  emit('create', {
    title,
    description: formDescription.value.trim(),
    startDate: formStart.value ? calendarDateToEpochMs(formStart.value) : null,
    endDate: formEnd.value ? calendarDateToEpochMs(formEnd.value) : null,
  })
  formTitle.value = ''
  formDescription.value = ''
  formStart.value = ''
  formEnd.value = ''
  formOpen.value = false
}
</script>

<template>
  <div class="delivery-list" data-testid="delivery-list">
    <div class="delivery-list-head">
      <h2 class="delivery-list-title">{{ t('delivery.page.title.label') }}</h2>
      <button
        type="button"
        class="delivery-new-btn"
        data-testid="delivery-new-btn"
        @click="formOpen = !formOpen"
      >
        {{ t('delivery.action.create.label') }}
      </button>
    </div>

    <form
      v-if="formOpen"
      class="delivery-create-form"
      data-testid="delivery-create-form"
      @submit.prevent="submitCreate"
    >
      <label class="delivery-form-field">
        <span>{{ t('delivery.action.form.titleLabel.label') }}</span>
        <input
          v-model="formTitle"
          type="text"
          data-testid="delivery-create-title"
          :placeholder="t('delivery.action.form.titlePlaceholder.label')"
        />
      </label>
      <label class="delivery-form-field">
        <span>{{ t('delivery.action.form.descriptionLabel.label') }}</span>
        <textarea
          v-model="formDescription"
          rows="2"
          data-testid="delivery-create-desc"
          :placeholder="t('delivery.action.form.descriptionPlaceholder.label')"
        />
      </label>
      <div class="delivery-form-row">
        <label class="delivery-form-field">
          <span>{{ t('delivery.action.form.startDateLabel.label') }}</span>
          <input v-model="formStart" type="date" data-testid="delivery-create-start" />
        </label>
        <label class="delivery-form-field">
          <span>{{ t('delivery.action.form.endDateLabel.label') }}</span>
          <input v-model="formEnd" type="date" data-testid="delivery-create-end" />
        </label>
      </div>
      <button
        type="submit"
        class="delivery-create-submit"
        :disabled="!formTitle.trim()"
        data-testid="delivery-create-submit"
      >
        {{ t('delivery.action.form.submit.label') }}
      </button>
    </form>

    <p
      v-if="props.deliveries.length === 0"
      class="delivery-list-empty"
      data-testid="delivery-list-empty"
    >
      {{ t('delivery.page.empty.label') }}
    </p>

    <ul v-else class="delivery-rows">
      <li v-for="d in props.deliveries" :key="d.id">
        <button
          type="button"
          class="delivery-row"
          :class="{ active: d.id === props.activeId }"
          :data-testid="`delivery-row-${d.status}`"
          @click="emit('open', d.id)"
        >
          <span class="delivery-row-main">
            <span class="delivery-row-title">{{ d.title }}</span>
            <span class="delivery-row-ready" data-testid="delivery-row-ready">
              {{
                t('delivery.status.integrationReady.label', {
                  merged: d.integration.merged,
                  total: d.integration.total,
                })
              }}
            </span>
          </span>
          <span
            class="delivery-row-status"
            :class="d.status"
            :data-testid="`delivery-status-${d.status}`"
          >
            {{ statusLabel(d.status) }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.delivery-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.delivery-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  flex-shrink: 0;
}
.delivery-list-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}
.delivery-new-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-primary-text);
  background: transparent;
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-create-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.delivery-form-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-form-field input,
.delivery-form-field textarea {
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
}
.delivery-form-row {
  display: flex;
  gap: var(--sp-2);
}
.delivery-form-row .delivery-form-field {
  flex: 1;
}
.delivery-create-submit {
  align-self: flex-start;
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: #fff;
  background: var(--c-primary);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-create-submit:disabled {
  opacity: 0.5;
  cursor: default;
}
.delivery-list-empty {
  margin: 0;
  padding: var(--sp-4) var(--sp-3);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}
.delivery-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}
.delivery-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  text-align: left;
  font: inherit;
  color: var(--c-text);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--c-border);
  cursor: pointer;
}
.delivery-row:hover {
  background: var(--c-card);
}
.delivery-row.active {
  background: var(--c-card);
}
.delivery-row-main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.delivery-row-title {
  font-size: var(--fs-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delivery-row-ready {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-row-status {
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-2);
}
.delivery-row-status.cancelled,
.delivery-row-status.delivered {
  opacity: 0.7;
}
</style>
