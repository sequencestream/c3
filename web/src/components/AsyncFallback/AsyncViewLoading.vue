<script setup lang="ts">
/*
 * AsyncViewLoading.vue — 页面级异步组件的 loading 占位。
 *
 * App.vue 把业务页面改为动态 import 后,首次进入某个 tab 需要一次 chunk 往返。
 * 这个占位只做一件事:占住页面原本的 flex 位置(flex:1 + min-*:0),让顶栏/底栏
 * 不因内容区暂时为空而位移,并给一个可识别的进度指示。纯展示,无 props、无副作用。
 */
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()
</script>

<template>
  <div
    class="avl-view"
    role="status"
    aria-busy="true"
    :aria-label="t('common.async.loading.label')"
    data-testid="async-view-loading"
  >
    <span class="avl-spinner" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.avl-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}
.avl-spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: avl-spin 0.7s linear infinite;
}
@keyframes avl-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
