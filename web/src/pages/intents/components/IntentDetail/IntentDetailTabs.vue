<script setup lang="ts">
/*
 * IntentDetailTabs.vue — 意图详情页的 Tab 导航条。
 *
 * 纯呈现:渲染可见 Tab 列表、高亮当前激活项,并在意图/规范/评审/工作会话 Tab 标签内联运行中
 * 状态点(复用全局 .session-status 视觉)。选择动作以 select 事件上抛,可见性/激活/状态点均由
 * 容器(Tab 状态机 composable)决定。
 */
import type { SessionStatus } from '@ccc/shared/protocol'
import type { DetailTab, DetailTabItem } from './useIntentDetailTabs'

defineProps<{
  tabs: DetailTabItem[]
  activeTab: DetailTab
  workSessionStatusDot: SessionStatus | null
  intentSessionStatusDot: SessionStatus | null
  specSessionStatusDot: SessionStatus | null
  specReviewSessionStatusDot: SessionStatus | null
}>()

const emit = defineEmits<{ select: [tab: DetailTab] }>()
</script>

<template>
  <nav class="intent-detail-tabs" data-testid="intent-detail-tabs">
    <div v-for="tab in tabs" :key="tab.key" class="intent-detail-tab-item">
      <button
        type="button"
        class="intent-detail-tab"
        :class="{ active: activeTab === tab.key }"
        :data-tab="tab.key"
        :aria-pressed="activeTab === tab.key"
        @click="emit('select', tab.key)"
      >
        {{ tab.label }}
        <span
          v-if="tab.key === 'workSession' && workSessionStatusDot"
          class="session-status"
          :class="workSessionStatusDot"
          :title="workSessionStatusDot"
          data-testid="intent-detail-work-session-status"
        ></span>
        <span
          v-if="tab.key === 'intentSession' && intentSessionStatusDot"
          class="session-status"
          :class="intentSessionStatusDot"
          :title="intentSessionStatusDot"
          data-testid="intent-detail-intent-session-status"
        ></span>
        <span
          v-if="tab.key === 'specSession' && specSessionStatusDot"
          class="session-status"
          :class="specSessionStatusDot"
          :title="specSessionStatusDot"
          data-testid="intent-detail-spec-session-status"
        ></span>
        <span
          v-if="tab.key === 'specReviewSession' && specReviewSessionStatusDot"
          class="session-status"
          :class="specReviewSessionStatusDot"
          :title="specReviewSessionStatusDot"
          data-testid="intent-detail-spec-review-session-status"
        ></span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.intent-detail-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  overflow-x: auto;
}
.intent-detail-tab-item {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--sp-1);
}
.intent-detail-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-2) var(--sp-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.intent-detail-tab:hover {
  color: var(--c-text);
}
.intent-detail-tab.active {
  color: var(--c-text);
  border-bottom-color: var(--c-accent, var(--c-text));
  font-weight: 600;
}
/* 工作/意图/规范会话 tab 标签内联运行中状态点(复用全局 .session-status 视觉,inline 对齐文字)。 */
.intent-detail-tab .session-status {
  display: inline-block;
  margin-left: var(--sp-1);
  vertical-align: middle;
}
</style>
