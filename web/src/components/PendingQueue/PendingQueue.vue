<script setup lang="ts">
/*
 * PendingQueue.vue — SessionStatusBar 下方、MessageInput 上方的待发送队列。
 *
 * 普通会话运行中发送的消息进入此队列(客户端内存,按 sessionId 归集),尚未入上下文,
 * 每条可修改、删除,或停止当前运行后优先单独发送。普通待发条目在当前查看的
 * 会话就绪时合并发送;立即发送会保留其他条目,留待下一回合。
 */
import type { PendingItem } from '../../lib/pending-queue'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

defineProps<{
  items: PendingItem[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  edit: [item: PendingItem]
  delete: [id: number]
  send: [id: number]
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
      <button
        class="pending-act pending-send"
        :disabled="disabled || items.some((queued) => queued.immediate)"
        :title="t('session.queue.send.tooltip')"
        :aria-label="t('session.queue.send.ariaLabel')"
        @click="emit('send', item.id)"
      >
        ↑
      </button>
    </div>
  </div>
</template>
