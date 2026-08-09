<script setup lang="ts">
/*
 * WorktreeBaselineBanner.vue —— 「这个意图的 worktree 落后于基准分支」的常驻提示。
 *
 * 它刻意不是弹窗。会话已经起来了,目录只是没坐在基准分支的最新提交上,而这件事真正
 * 需要处理的时点是 PR 合并 —— 落后本身既不影响写代码,也不该在每次启动时把人挡在
 * 一个对话框后面。所以这里只陈述事实并把两个动作摆在手边:
 *
 *   - 合入基准分支:在 worktree 里显式 merge,冲突原样浮出。
 *   - 重建 worktree:**仅在无未提交改动时**才渲染 —— 重建会丢掉未提交的工作,
 *     c3 从不代人做这个决定,有改动时连按钮都不给,只说清先提交或暂存。
 *
 * 受控组件:不发消息,只上抛用户的选择。
 */
import { computed } from 'vue'
import type { WorktreeBaselineNotice } from '@/lib/worktree-baseline'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  /** 该意图最近一次被告知的基线不符;null 时整条不渲染。 */
  notice: WorktreeBaselineNotice | null
}>()

const emit = defineEmits<{
  /** 执行一个显式修复出口。 */
  repair: [intentId: string, mode: 'rebuild' | 'merge']
  /** 用户收下了这条提示 —— 只关提示,不改 worktree。 */
  dismiss: [intentId: string]
}>()

/** 事实句:期望基线 + 目录当前实际位置。有未提交改动时补一句为什么没有重建按钮。 */
const message = computed(() => {
  const n = props.notice
  if (!n) return ''
  const params = {
    branch: n.branch,
    currentBranch: n.currentBranch,
    currentHead: n.currentHead,
  }
  const head = n.deliveryTitle
    ? t('intent.worktreeBaseline.staleInDelivery', { ...params, delivery: n.deliveryTitle })
    : t('intent.worktreeBaseline.stale', params)
  return n.canRebuild ? head : `${head} ${t('intent.worktreeBaseline.dirtyHint')}`
})
</script>

<template>
  <div v-if="notice" class="wb-banner" role="status" data-testid="worktree-baseline-banner">
    <span class="wb-text">{{ message }}</span>
    <div class="wb-actions">
      <button
        class="wb-action"
        data-testid="worktree-baseline-merge"
        @click="emit('repair', notice.intentId, 'merge')"
      >
        {{ t('intent.worktreeBaseline.merge.label') }}
      </button>
      <button
        v-if="notice.canRebuild"
        class="wb-action"
        data-testid="worktree-baseline-rebuild"
        @click="emit('repair', notice.intentId, 'rebuild')"
      >
        {{ t('intent.worktreeBaseline.rebuild.label') }}
      </button>
      <button
        class="wb-dismiss"
        data-testid="worktree-baseline-dismiss"
        @click="emit('dismiss', notice.intentId)"
      >
        {{ t('intent.worktreeBaseline.dismiss.label') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 提醒而非告警:警告色描边 + 浅底,不用危险色 —— 落后于基准分支不是错误状态。 */
.wb-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.12);
  color: var(--c-warning-text);
  font-size: var(--fs-caption);
}
.wb-text {
  flex: 1 1 240px;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.wb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.wb-action,
.wb-dismiss {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-warning-text);
  font-size: var(--fs-caption);
  cursor: pointer;
}
.wb-dismiss {
  border-color: var(--c-border);
  color: var(--c-text-muted);
}
.wb-action:hover,
.wb-dismiss:hover {
  filter: brightness(1.08);
}
.wb-action:focus-visible,
.wb-dismiss:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
</style>
