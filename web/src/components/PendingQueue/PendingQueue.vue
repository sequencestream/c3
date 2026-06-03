<script setup lang="ts">
/*
 * PendingQueue.vue — SessionStatusBar 下方、MessageInput 上方的待发送队列。
 *
 * 普通会话运行中发送的消息进入此队列(客户端内存,按 sessionId 归集),尚未入上下文,
 * 故每条带 修改(✎)/ 删除(🗑):修改回填输入框、删除移除该条。当前查看的会话回到
 * 就绪且队列非空时,由 App 合并为一条 prompt flush 出去并清空。
 */
import type { PendingItem } from '../../lib/pending-queue'

defineProps<{
  items: PendingItem[]
}>()

const emit = defineEmits<{
  edit: [item: PendingItem]
  delete: [id: number]
}>()
</script>

<template>
  <div v-if="items.length" class="pending-queue" aria-label="Pending queue">
    <div class="pending-head">Queued · merged into the next turn ({{ items.length }})</div>
    <div v-for="item in items" :key="item.id" class="pending-item">
      <span class="pending-text">{{ item.text }}</span>
      <button
        class="pending-act"
        title="Edit: pull back into the input box to re-edit"
        aria-label="Edit"
        @click="emit('edit', item)"
      >
        ✎
      </button>
      <button
        class="pending-act"
        title="Delete: remove from the queue"
        aria-label="Delete"
        @click="emit('delete', item.id)"
      >
        🗑
      </button>
    </div>
  </div>
</template>
