<script setup lang="ts">
/*
 * DeliveryIntentsTab.vue — 关联意图 tab。
 *
 * 意图关联能力由后续阶段提供,本阶段恒空:展示「集成就绪 N/M」聚合口径的说明与
 * 空态文案。无独立 PR 列表/进度条 —— 那些信息并入概览的缺口说明区。
 */
import { useTypedI18n } from '@/i18n'
import type { Delivery } from '@ccc/shared/protocol'

defineProps<{
  delivery: Delivery
}>()

const { t } = useTypedI18n()
</script>

<template>
  <div class="delivery-intents" data-testid="delivery-intents-tab">
    <p class="delivery-intents-empty" data-testid="delivery-intents-empty">
      {{ t('delivery.page.intentsEmpty.label') }}
    </p>
    <p class="delivery-intents-ready">
      {{
        t('delivery.status.integrationReady.label', {
          merged: delivery.integration.merged,
          total: delivery.integration.total,
        })
      }}
    </p>
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
.delivery-intents-empty {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}
.delivery-intents-ready {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
