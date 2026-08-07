<script setup lang="ts">
/*
 * DeliveryList.vue — 交付列表(左栏)。
 *
 * 头部最左「收缩/展开」按钮在两栏正常与窄条之间切换列宽;最右「+」按钮展开内联
 * 创建表单(标题/描述/起止日历日期,纯本地数据动作,不触网)。行 = 标题 + 状态
 * 徽标 + 集成就绪 N/M,点击 emit open 上抛。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { Delivery, DeliveryStatus } from '@ccc/shared/protocol'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
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

// ---- 折叠态 ----
// 持久化 UI 状态:收缩态把整列收窄成窄条,并隐藏头部标题与行内次要信息(集成就绪
// N/M);跨页面切换乃至刷新后保持原状。图标/tooltip 反映点击后将切换到的目标态。
const collapsed = usePersistentToggle('c3.deliveryListCollapsed')
const toggleLabel = computed(() =>
  collapsed.value
    ? { icon: '⇥', title: t('delivery.list.expand.tooltip') }
    : { icon: '⇤', title: t('delivery.list.collapse.tooltip') },
)

function togglePanel(): void {
  collapsed.value = !collapsed.value
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
  <div class="delivery-list" :class="{ collapsed }" data-testid="delivery-list">
    <div class="delivery-list-head">
      <div class="delivery-list-head-left">
        <button
          type="button"
          class="delivery-collapse-btn"
          data-testid="delivery-collapse-btn"
          :title="toggleLabel.title"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ toggleLabel.icon }}
        </button>
        <h2 v-if="!collapsed" class="delivery-list-title">{{ t('delivery.page.title.label') }}</h2>
      </div>
      <button
        type="button"
        class="delivery-new-btn"
        data-testid="delivery-new-btn"
        :title="t('delivery.action.create.tooltip')"
        :aria-label="t('delivery.action.create.tooltip')"
        @click="formOpen = !formOpen"
      >
        +
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
            <span v-if="!collapsed" class="delivery-row-ready" data-testid="delivery-row-ready">
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
  width: 960px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--c-border);
  transition: width 0.2s ease;
}
/* 收缩态:宽度减半成窄条,标题与行内次要信息由组件 v-if 不渲染 */
.delivery-list.collapsed {
  width: 480px;
}
/* 窄屏回退:侧栏按视口比例收窄,避免挤压详情区(与 .req-list / .disc-list 一致) */
@media (max-width: 1024px) {
  .delivery-list {
    width: min(960px, 68vw);
    min-width: 450px;
  }
  .delivery-list.collapsed {
    width: min(480px, 34vw);
    min-width: 280px;
  }
}
/* 移动端 drill-down:列表即当前单栏,撑满全宽;清除 min-width 否则会横向溢出 */
@media (max-width: 767px) {
  .delivery-list,
  .delivery-list.collapsed {
    width: 100%;
    min-width: 0;
    border-right: none;
  }
}
.delivery-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  flex-shrink: 0;
}
.delivery-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.delivery-list-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 展开/收缩切换按钮:标题前,图标反映点击后将切换到的目标态 */
.delivery-collapse-btn {
  flex-shrink: 0;
  padding: 2px 8px;
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.delivery-collapse-btn:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
/* 新建交付:纯「+」图标按钮,可发现性由 tooltip / aria-label 兜底 */
.delivery-new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font: inherit;
  font-size: var(--fs-title-sm);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
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
