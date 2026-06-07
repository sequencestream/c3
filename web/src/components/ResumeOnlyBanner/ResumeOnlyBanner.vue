<script setup lang="ts">
/*
 * ResumeOnlyBanner.vue — read='none' vendor 的会话详情横幅(诚实兜底)
 *
 * 某些 vendor（Codex）的 session `read` 能力为 `none`：c3 不旁路捕获其会话内容、
 * 也无法回读历史，详情页只能是「空 baseline + live buffer」。点进这类 session 时，
 * 会话区一片空白会被误读成「加载失败/历史丢了」——这条横幅把真相说清楚：
 * 该 vendor 不支持历史回读，只显示新消息，且只能从中断点续接。
 *
 * 纯展示组件，按**能力态**门控（`read === 'none'`），零 `if (vendor === …)`：
 * 任何未来自报 `read: 'none'` 的 vendor 都自动命中（与 SR-R12 / row-action gating 同范式）。
 */
import { computed } from 'vue'
import { VENDOR_LABEL } from '../../lib/vendor'
import { useTypedI18n } from '@/i18n'
import type { CapabilityState, VendorId } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  /** 活动 session 的 vendor，品牌名经 VENDOR_LABEL 注入文案。null ⇒ 不渲染。 */
  vendor?: VendorId | null
  /** 该 vendor 的 session `read` 能力态；仅 `none` 时渲染横幅。 */
  read?: CapabilityState
}>()

// 双重前置：能力态为 none 且 vendor 已知（才能给出品牌名）。
const banner = computed(() =>
  props.read === 'none' && props.vendor
    ? t('session.chat.resumeOnly', { vendor: VENDOR_LABEL[props.vendor] })
    : null,
)
</script>

<template>
  <div v-if="banner" class="resume-only-banner" data-testid="resume-only-banner" role="note">
    {{ banner }}
  </div>
</template>

<style scoped>
/* notice 风格：柔和警示底 + 主题 token，不抢消息区焦点，仅作引导。 */
.resume-only-banner {
  margin: 0.5rem 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--c-border);
  border-radius: var(--radius, 6px);
  background: var(--c-warning-soft, rgba(245, 158, 11, 0.12));
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  line-height: 1.4;
}
</style>
