<script setup lang="ts">
/*
 * DeliveryLogsTab.vue — 日志 tab:交付生命周期操作日志(倒序)。
 *
 * 一行一条:操作类型本地化标签 + 摘要 + 操作人 + 时间。呈现与交互对齐意图侧的
 * IntentChangelogTab.vue —— 同一种审计轨迹在两个域里不该长成两个样子。
 *
 * 懒加载由容器决定:`logs === null` 表示「没拉过 / 已失效」,本组件据此上抛一次
 * list-logs,不自己缓存、不自己判新旧。摘要是服务端落库的既成事实文本,原样展示、
 * 不改写;只有操作类型走本地化,未知类型(旧库或更新的服务端)降级显示原值,不能
 * 让整张列表渲染不出来。
 */
import { watch } from 'vue'
import type { DeliveryLog, DeliveryLogOperation } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { formatDate } from '@/lib/intent-list-view'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  /** 本交付的日志(倒序);null = 尚未拉取或缓存已失效,由本组件触发一次拉取。 */
  logs: DeliveryLog[] | null
  /** 本交付的拉取是否在途(容器按 deliveryId 判定,不是全局标志)。 */
  loading: boolean
  /** 当前交付 id —— 换交付即重新判定是否需要拉取。 */
  deliveryId: string
}>()

const emit = defineEmits<{ 'list-logs': [deliveryId: string] }>()

// 懒加载信号:进入本 tab、换交付、或缓存被写操作丢弃(logs 变回 null)时各发一次。
// 在途期间不重发,否则一次写操作会引出两条相同的请求。
function fetchIfNeeded(): void {
  if (props.logs === null && !props.loading) emit('list-logs', props.deliveryId)
}

watch(() => [props.deliveryId, props.logs === null, props.loading] as const, fetchIfNeeded, {
  immediate: true,
})

// 操作类型 → 本地化标签。key 全为字面量,拼错走 vue-tsc 失败(typed t)。
const OP_LABELS: Record<DeliveryLogOperation, string> = {
  delivery_created: t('delivery.log.operationType.created'),
  delivery_updated: t('delivery.log.operationType.updated'),
  status_changed: t('delivery.log.operationType.statusChanged'),
  verification_confirmed: t('delivery.log.operationType.verificationConfirmed'),
  cancelled: t('delivery.log.operationType.cancelled'),
  delivered: t('delivery.log.operationType.delivered'),
  merge_conflict: t('delivery.log.operationType.mergeConflict'),
  intent_linked: t('delivery.log.operationType.intentLinked'),
  intent_unlinked: t('delivery.log.operationType.intentUnlinked'),
  delivery_pr_opened: t('delivery.log.operationType.deliveryPrOpened'),
}

function opLabel(op: DeliveryLogOperation): string {
  return OP_LABELS[op] ?? op
}
</script>

<template>
  <div class="delivery-logs-body" data-testid="tab-delivery-logs">
    <p v-if="props.loading && !props.logs?.length" class="delivery-logs-empty">
      {{ t('delivery.log.loading.label') }}
    </p>
    <p
      v-else-if="!props.logs?.length"
      class="delivery-logs-empty"
      data-testid="delivery-logs-empty"
    >
      {{ t('delivery.log.empty.label') }}
    </p>
    <ul v-else class="delivery-logs" data-testid="delivery-logs-list">
      <li v-for="log in props.logs" :key="log.id" class="delivery-log-row">
        <span class="delivery-log-op" :class="'delivery-log-op--' + log.operationType">{{
          opLabel(log.operationType)
        }}</span>
        <span class="delivery-log-summary">{{ log.summary }}</span>
        <span class="delivery-log-actor">{{ log.actor }}</span>
        <span class="delivery-log-time">{{ formatDate(log.createdAt, locale) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.delivery-logs-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.delivery-logs-empty {
  margin: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
/* 一行一条(操作类型标签 + 摘要 + 操作人 + 时间),倒序由服务端保证。 */
.delivery-logs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-log-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: var(--fs-caption);
}
.delivery-log-op {
  flex: 0 0 auto;
  padding: 0 var(--sp-1);
  border-radius: 4px;
  background: var(--c-bg-muted, rgba(127, 127, 127, 0.12));
  color: var(--c-text);
  white-space: nowrap;
}
.delivery-log-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--c-text);
  word-break: break-word;
}
.delivery-log-actor {
  flex: 0 0 auto;
  color: var(--c-text-muted);
}
.delivery-log-time {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  white-space: nowrap;
}
</style>
