<script setup lang="ts">
/*
 * DiscussionList.vue — 讨论视图左栏:讨论列表 + 顶部「+」。
 *
 * 数据由 App 提供(读路径)。点击某讨论上抛 `open` 事件,由 App 拉取详情;
 * 顶部「+」上抛 `new-discussion`(R1 仅占位,写路径后续接入)。
 */
import type { Discussion, DiscussionStatus } from '@ccc/shared/protocol'
import { formatDate } from '../lib/req-list-view'

defineProps<{
  discussions: Discussion[]
  activeId: string | null
}>()

const emit = defineEmits<{
  open: [discussionId: string]
  'new-discussion': []
}>()

const STATUS_LABEL: Record<DiscussionStatus, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 updatedAt。
function datePrefix(d: Discussion): string {
  return formatDate(d.completedAt ?? d.updatedAt, { style: 'short' })
}
</script>

<template>
  <section class="disc-list">
    <div class="disc-list-head">
      <span class="disc-list-title">Discussions</span>
      <button
        type="button"
        class="disc-new-btn"
        aria-label="New discussion"
        title="New discussion"
        @click="emit('new-discussion')"
      >
        +
      </button>
    </div>
    <div class="disc-items">
      <p v-if="discussions.length === 0" class="disc-empty">No discussions yet.</p>
      <div
        v-for="d in discussions"
        :key="d.id"
        class="disc-item"
        :class="[d.status, { active: d.id === activeId }]"
        role="button"
        tabindex="0"
        :aria-pressed="d.id === activeId"
        @click="emit('open', d.id)"
        @keydown.enter.prevent="emit('open', d.id)"
        @keydown.space.prevent="emit('open', d.id)"
      >
        <div class="disc-item-head">
          <span class="disc-date">{{ datePrefix(d) }}</span>
          <span class="disc-title">{{ d.title }}</span>
        </div>
        <div class="disc-meta">
          <span class="disc-status">{{ STATUS_LABEL[d.status] }}</span>
          <span v-if="d.type" class="disc-type">{{ d.type }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.disc-list {
  width: 360px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
@media (max-width: 1024px) {
  .disc-list {
    width: min(360px, 34vw);
    min-width: 240px;
  }
}
.disc-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.disc-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
}
.disc-new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: var(--fs-title-sm);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.disc-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
}
.disc-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
}
.disc-item {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  cursor: pointer;
}
.disc-item:hover {
  border-color: var(--c-primary);
}
.disc-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.disc-item.completed,
.disc-item.cancelled {
  opacity: 0.6;
}
.disc-item-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}
.disc-date {
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.disc-meta {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
