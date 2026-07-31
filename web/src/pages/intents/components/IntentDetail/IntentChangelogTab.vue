<script setup lang="ts">
/*
 * IntentChangelogTab.vue — changelog tab:意图生命周期变更日志(倒序)。
 *
 * 一行一条:操作类型标签 + 摘要 + 操作人 + 时间。懒加载与空态/加载态由容器决定后透传数据,
 * 本组件只做操作类型本地化与呈现。
 */
import type { IntentLog, IntentLogOperation } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { formatDate } from '../../../../lib/intent-list-view'

const { t, locale } = useTypedI18n()

defineProps<{
  intentLogs: IntentLog[]
  intentLogsLoading: boolean
}>()

// 操作类型 → 本地化标签。key 全为字面量,拼错走 vue-tsc 失败(typed t)。
const OP_LABELS: Record<IntentLogOperation, string> = {
  intent_created: t('intent.changelog.operationType.created'),
  intent_updated: t('intent.changelog.operationType.updated'),
  status_changed: t('intent.changelog.operationType.statusChanged'),
  spec_created: t('intent.changelog.operationType.specCreated'),
  spec_updated: t('intent.changelog.operationType.specUpdated'),
  spec_reviewed: t('intent.changelog.operationType.specReviewed'),
  spec_approved: t('intent.changelog.operationType.specApproved'),
  spec_unapproved: t('intent.changelog.operationType.specUnapproved'),
  pr_created: t('intent.changelog.operationType.prCreated'),
  pr_merged: t('intent.changelog.operationType.prMerged'),
  pr_closed: t('intent.changelog.operationType.prClosed'),
  pr_updated: t('intent.changelog.operationType.prUpdated'),
}

function opLabel(op: IntentLogOperation): string {
  return OP_LABELS[op] ?? op
}
</script>

<template>
  <div class="intent-detail-body" data-testid="tab-changelog">
    <p v-if="intentLogsLoading && intentLogs.length === 0" class="intent-detail-empty">
      {{ t('intent.changelog.loading') }}
    </p>
    <p
      v-else-if="intentLogs.length === 0"
      class="intent-detail-empty"
      data-testid="intent-detail-changelog-empty"
    >
      {{ t('intent.changelog.empty') }}
    </p>
    <ul v-else class="req-changelog" data-testid="intent-detail-changelog-list">
      <li v-for="log in intentLogs" :key="log.id" class="req-changelog-row">
        <span class="req-changelog-op" :class="'req-changelog-op--' + log.operationType">{{
          opLabel(log.operationType)
        }}</span>
        <span class="req-changelog-summary">{{ log.summary }}</span>
        <span class="req-changelog-actor">{{ log.actor }}</span>
        <span class="req-changelog-time">{{ formatDate(log.createdAt, locale) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.intent-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.intent-detail-empty {
  margin: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
/* 变更日志:一行一条(操作类型标签 + 摘要 + 操作人 + 时间),倒序由数据保证。 */
.req-changelog {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.req-changelog-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: var(--fs-caption);
}
.req-changelog-op {
  flex: 0 0 auto;
  padding: 0 var(--sp-1);
  border-radius: 4px;
  background: var(--c-bg-muted, rgba(127, 127, 127, 0.12));
  color: var(--c-text);
  white-space: nowrap;
}
.req-changelog-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--c-text);
  word-break: break-word;
}
.req-changelog-actor {
  flex: 0 0 auto;
  color: var(--c-text-muted);
}
.req-changelog-time {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  white-space: nowrap;
}
</style>
