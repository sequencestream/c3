<script setup lang="ts">
/*
 * AsyncOverlayLoading.vue — 弹窗/覆盖层级异步组件的 loading 占位。
 *
 * 设置页、modal、进度覆盖层都是「打开即全屏遮罩 + 居中面板」的形态,首次打开要等
 * 一次 chunk 往返。这里先渲染同一层级的遮罩(z-index 900,低于全局 toast 1000)与
 * 一个进度指示,面板到位后原地替换:遮罩不闪、不留白屏、也不改变页面布局。
 */
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()
</script>

<template>
  <div
    class="aol-overlay"
    role="status"
    aria-busy="true"
    :aria-label="t('common.async.loading.label')"
    data-testid="async-overlay-loading"
  >
    <span class="aol-spinner" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.aol-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.aol-spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: aol-spin 0.7s linear infinite;
}
@keyframes aol-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
