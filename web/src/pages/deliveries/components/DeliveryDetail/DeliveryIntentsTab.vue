<script setup lang="ts">
/*
 * DeliveryIntentsTab.vue — 关联意图 tab。
 *
 * 列表四列:意图标题 / 意图状态 / **该意图对本交付的 PR 状态** / head 分支。第三列
 * 取服务端 `associatedIntents[].prStatus`(即 delivery_id 命中本交付的那条 PR),
 * 不是意图的全局 PR 聚合 —— 同一意图可对不同交付各有一条 PR,用全局聚合会把别的
 * 交付的状态显示到这里。本组件不做任何聚合,只渲染服务端给的行。
 *
 * 解除关联收在行尾次级位置:PR 已 merged 的行渲染为禁用态(带 tooltip),未合并行
 * 走 danger ConfirmDialog 二次确认后上抛。是否真能解除由服务端复核(本地 + forge
 * 实时状态双层),本组件的禁用只是提前表达,不构成门禁。
 *
 * 关联入口只列出「尚未归属任何交付」的意图:第一版不开放一个意图关联多个交付的
 * 入口(数据层支持多行,交互层不给路径)。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { AssociatedIntent, Delivery, Intent, IntentPrStatus } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import { statusLabel } from '@/lib/intent-list-view'

const props = defineProps<{
  delivery: Delivery
  /** Server-listed linked intents; each row's `prStatus` is toward THIS delivery. */
  associatedIntents: AssociatedIntent[]
  /** This workspace's intents, for the link picker (filtered here). */
  intents: Intent[]
}>()

const emit = defineEmits<{
  link: [intentId: string]
  unlink: [intentId: string]
}>()

const { t } = useTypedI18n()

const PR_STATUS_LABEL_KEYS = {
  reviewing: 'intent.prStatus.reviewing.label',
  rejected: 'intent.prStatus.rejected.label',
  failed: 'intent.prStatus.failed.label',
  merged: 'intent.prStatus.merged.label',
  closed: 'intent.prStatus.closed.label',
} as const

function prStatusLabel(s: IntentPrStatus | null): string {
  return s ? t(PR_STATUS_LABEL_KEYS[s]) : t('delivery.page.associatedIntents.noPr.label')
}

// ── 关联入口 ────────────────────────────────────────────────────────────────
// 候选 = 本工作区中尚未关联到任何交付的意图。过滤在这里而不是服务端,是因为
// 「不开放多交付关联」是交互层的克制,数据层依然允许多行。
const linkOpen = ref(false)
const picked = ref('')

const candidates = computed<Intent[]>(() =>
  props.intents.filter((i) => i.linkedDeliveries.length === 0),
)

function openLink(): void {
  picked.value = candidates.value[0]?.id ?? ''
  linkOpen.value = true
}

function confirmLink(): void {
  if (!picked.value) return
  emit('link', picked.value)
  linkOpen.value = false
  picked.value = ''
}

// ── 解除关联(危险操作,ConfirmDialog 二次确认) ────────────────────────────
const unlinkTarget = ref<AssociatedIntent | null>(null)

function confirmUnlink(): void {
  const target = unlinkTarget.value
  unlinkTarget.value = null
  if (target) emit('unlink', target.id)
}
</script>

<template>
  <div class="delivery-intents" data-testid="delivery-intents-tab">
    <div class="delivery-intents-head">
      <h3 class="delivery-intents-title">
        {{ t('delivery.page.associatedIntents.title.label') }}
      </h3>
      <button
        type="button"
        class="delivery-intents-link-btn"
        data-testid="delivery-intents-link"
        @click="openLink"
      >
        {{ t('delivery.action.link.label') }}
      </button>
    </div>

    <div v-if="linkOpen" class="delivery-intents-picker" data-testid="delivery-intents-picker">
      <template v-if="candidates.length">
        <label class="delivery-intents-picker-label" for="delivery-link-intent">
          {{ t('delivery.action.link.pickerTitle.label') }}
        </label>
        <select id="delivery-link-intent" v-model="picked" class="delivery-intents-picker-select">
          <option v-for="i in candidates" :key="i.id" :value="i.id">{{ i.title }}</option>
        </select>
        <button
          type="button"
          class="delivery-intents-link-btn"
          data-testid="delivery-intents-link-confirm"
          @click="confirmLink"
        >
          {{ t('delivery.action.link.confirm.label') }}
        </button>
      </template>
      <p v-else class="delivery-intents-empty" data-testid="delivery-intents-picker-empty">
        {{ t('delivery.action.link.pickerEmpty.label') }}
      </p>
      <button type="button" class="delivery-intents-link-cancel" @click="linkOpen = false">
        {{ t('common.action.cancel.label') }}
      </button>
    </div>

    <p
      v-if="associatedIntents.length === 0"
      class="delivery-intents-empty"
      data-testid="delivery-intents-empty"
    >
      {{ t('delivery.page.intentsEmpty.label') }}
    </p>

    <ul v-else class="delivery-intents-list">
      <li
        v-for="row in associatedIntents"
        :key="row.id"
        class="delivery-intents-row"
        :data-testid="`delivery-intent-row-${row.id}`"
      >
        <span class="delivery-intents-cell delivery-intents-cell--title" :title="row.title">{{
          row.title
        }}</span>
        <span class="delivery-intents-cell delivery-intents-cell--status">{{
          statusLabel(row.status)
        }}</span>
        <span
          class="delivery-intents-cell delivery-intents-cell--pr"
          :class="row.prStatus ? `req-pr-status--${row.prStatus}` : ''"
          :data-testid="`delivery-intent-pr-${row.id}`"
          >{{ prStatusLabel(row.prStatus) }}</span
        >
        <span class="delivery-intents-cell delivery-intents-cell--branch">{{
          row.headBranch ?? '—'
        }}</span>
        <button
          v-if="row.prStatus === 'merged'"
          type="button"
          class="delivery-intents-unlink-btn"
          :data-testid="`delivery-intent-unlink-${row.id}`"
          disabled
          :title="t('delivery.action.unlink.mergedDisabled.tooltip')"
        >
          {{ t('delivery.action.unlink.label') }}
        </button>
        <button
          v-else
          type="button"
          class="delivery-intents-unlink-btn"
          :data-testid="`delivery-intent-unlink-${row.id}`"
          @click="unlinkTarget = row"
        >
          {{ t('delivery.action.unlink.label') }}
        </button>
      </li>
    </ul>

    <p class="delivery-intents-ready">
      {{
        t('delivery.status.integrationReady.label', {
          merged: delivery.integration.merged,
          total: delivery.integration.total,
        })
      }}
    </p>

    <ConfirmDialog
      :open="unlinkTarget !== null"
      :title="t('delivery.action.unlink.title.label')"
      :message="t('delivery.action.unlink.body.label', { title: unlinkTarget?.title ?? '' })"
      :confirm-label="t('delivery.action.unlink.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmUnlink"
      @cancel="unlinkTarget = null"
    />
  </div>
</template>

<style scoped>
.delivery-intents {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-intents-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.delivery-intents-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}
.delivery-intents-link-btn,
.delivery-intents-link-cancel {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-intents-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-picker-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-intents-picker-select {
  flex: 1;
  min-width: 160px;
  font: inherit;
  font-size: var(--fs-caption);
  padding: var(--sp-1);
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-empty {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}
.delivery-intents-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.delivery-intents-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-cell {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.delivery-intents-cell--title {
  flex: 1;
  min-width: 120px;
  font-size: var(--fs-body);
  color: var(--c-text);
}
.delivery-intents-unlink-btn {
  flex-shrink: 0;
  margin-left: auto;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-intents-unlink-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.delivery-intents-ready {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
