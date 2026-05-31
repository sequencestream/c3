<script setup lang="ts">
/*
 * PendingQueue.vue — SessionStatusBar 下方、MessageInput 上方的待发送队列。
 *
 * 普通会话运行中发送的消息进入此队列(客户端内存,按 sessionId 归集),尚未入上下文,
 * 故每条带 修改(✎)/ 删除(🗑):修改回填输入框、删除移除该条。当前查看的会话回到
 * 就绪且队列非空时,由 App 合并为一条 prompt flush 出去并清空。
 */
import type { PendingItem } from '../lib/pending-queue'

defineProps<{
  items: PendingItem[]
}>()

const emit = defineEmits<{
  edit: [item: PendingItem]
  delete: [id: number]
}>()
</script>

<template>
  <div v-if="items.length" class="pending-queue" aria-label="待发送队列">
    <div class="pending-head">待发送 · 回合结束后合并入下一轮({{ items.length }})</div>
    <div v-for="item in items" :key="item.id" class="pending-item">
      <span class="pending-text">{{ item.text }}</span>
      <button
        class="pending-act"
        title="修改:取回到输入框重新编辑"
        aria-label="修改"
        @click="emit('edit', item)"
      >
        ✎
      </button>
      <button
        class="pending-act"
        title="删除:从队列移除"
        aria-label="删除"
        @click="emit('delete', item.id)"
      >
        🗑
      </button>
    </div>
  </div>
</template>
