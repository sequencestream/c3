<script setup lang="ts">
/*
 * PendingQueue.vue — SessionStatusBar 下方、MessageInput 上方的待发送队列。
 *
 * 普通会话运行中发送的消息进入此队列(客户端内存,按 sessionId 归集),尚未入上下文,
 * 故每条带 修改(✎)/ 删除(🗑):修改回填输入框、删除移除该条。当前查看的会话回到
 * 就绪且队列非空时,由 App 合并为一条 prompt flush 出去并清空。
 */
import type { PendingItem } from '../../lib/pending-queue'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

defineProps<{
  items: PendingItem[]
}>()

const emit = defineEmits<{
  edit: [item: PendingItem]
  delete: [id: number]
}>()
</script>

<template>
  <div v-if="items.length" class="pending-queue" :aria-label="t('session.queue.ariaLabel')">
    <div class="pending-head">{{ t('session.queue.head', { count: items.length }) }}</div>
    <div v-for="item in items" :key="item.id" class="pending-item">
      <span class="pending-text">{{ item.text }}</span>
      <span v-if="item.images?.length" class="pending-images">
        {{ t('session.queue.imageCount', { count: item.images.length }) }}
      </span>
      <button
        class="pending-act"
        :title="t('session.queue.edit.tooltip')"
        :aria-label="t('session.queue.edit.ariaLabel')"
        @click="emit('edit', item)"
      >
        ✎
      </button>
      <button
        class="pending-act"
        :title="t('session.queue.delete.tooltip')"
        :aria-label="t('session.queue.delete.ariaLabel')"
        @click="emit('delete', item.id)"
      >
        🗑
      </button>
    </div>
  </div>
</template>
