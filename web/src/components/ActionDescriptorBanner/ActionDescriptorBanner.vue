<script setup lang="ts">
/*
 * ActionDescriptorBanner.vue — 派生「下一步」提示的唯一展示单元。
 *
 * 服务端把不可自动解决的阻塞态派生成 ActionDescriptor(稳定码 + 跳转目标),本组件
 * 是它在前端的唯一渲染:意图列表行与意图详情头部共用同一份组件、同一套文案映射,
 * 因此两处永远不会对同一个阻塞给出不同说法。
 *
 * 呈现取现有危险语义的最高层级:高对比提示区 + 明确按钮文案,并且信息不依赖颜色
 * ——图标、正文与按钮文字都是可读文本,按钮是原生 button(可 Tab 聚焦、可回车触发)。
 * 组件本身不导航:点击只上抛 target,由调用方接到同一个分发器上。
 *
 * 少数阻塞还要交代「卡在哪」:自动返工触顶时正文下方展示审核理由原文(换行保留、按纯
 * 文本渲染),理由为空则给兜底文案,绝不伪造验收项。按钮始终只有一个,触顶时它就是人工
 * 接管入口,组件不提供任何重试动作。
 */
import { computed } from 'vue'
import type { ActionDescriptor, ActionTarget } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import {
  actionBlockerFallbackKey,
  actionButtonKey,
  actionMessageKey,
} from '@/lib/action-descriptor'

const { t } = useTypedI18n()

const props = defineProps<{
  /** 派生的下一步;null 表示无阻塞,整块不渲染。 */
  descriptor: ActionDescriptor | null
  /** 当前有效审核结论的理由原文,用作卡点摘要;仅带摘要的阻塞会用到。 */
  reviewReason?: string | null
}>()

const emit = defineEmits<{
  navigate: [target: ActionTarget]
}>()

const message = computed(() =>
  props.descriptor ? t(actionMessageKey(props.descriptor.labelCode)) : '',
)
const buttonLabel = computed(() => (props.descriptor ? t(actionButtonKey(props.descriptor)) : ''))
const blocker = computed(() => {
  if (!props.descriptor) return ''
  const fallbackKey = actionBlockerFallbackKey(props.descriptor.labelCode)
  if (!fallbackKey) return ''
  return props.reviewReason?.trim() || t(fallbackKey)
})
</script>

<template>
  <div v-if="descriptor" class="ad-banner" role="alert" data-testid="action-descriptor-banner">
    <span class="ad-icon" aria-hidden="true">⚠</span>
    <span class="ad-message" data-testid="action-descriptor-message">{{ message }}</span>
    <button
      type="button"
      class="ad-action"
      data-testid="action-descriptor-action"
      @click.stop="emit('navigate', descriptor.target)"
    >
      {{ buttonLabel }}
    </button>
    <p v-if="blocker" class="ad-blocker" data-testid="action-descriptor-blocker">{{ blocker }}</p>
  </div>
</template>

<style scoped>
/* 高对比危险提示区:实底描边 + 危险色文字,浅深两主题都自己挣够对比度。 */
.ad-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-error);
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error-text);
  font-size: var(--fs-caption);
}
.ad-icon {
  flex-shrink: 0;
}
.ad-message {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
/* 卡点摘要:审核理由原文独占一行,保留换行,长内容自动折行不撑破提示区。 */
.ad-blocker {
  flex-basis: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.ad-action {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid var(--c-error);
  border-radius: var(--radius-sm);
  background: var(--c-error);
  color: #fff;
  font-size: var(--fs-caption);
  font-weight: 600;
  cursor: pointer;
}
.ad-action:hover {
  filter: brightness(1.08);
}
.ad-action:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
</style>
