<script setup lang="ts">
/*
 * AsyncViewError.vue — 页面级异步组件的加载失败兜底。
 *
 * chunk 拉取失败(离线、部署换版导致旧 hash 404)时替代页面渲染:只给一个稳定容器
 * 和一句解释,不自动重试。此处唯一的恢复路径是整页刷新,文案也只引导刷新:动态 import
 * 失败后浏览器会把这个 URL 的失败结果记进模块图,切走再切回来虽然重新走一遍 loader,
 * 拿到的仍是那条失败记录、连请求都不会再发(Vue 侧倒是清空了自己的 pendingRequest,
 * 拦住重试的是浏览器)。失败只圈在当前视图内——其余 tab 各有各的 chunk,照常能切。
 * 不依赖任何业务组件内部实现。
 */
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()
</script>

<template>
  <div class="ave-view" role="alert" data-testid="async-view-error">
    <p class="ave-title">{{ t('common.async.error.label') }}</p>
    <p class="ave-hint">{{ t('common.async.error.hint') }}</p>
  </div>
</template>

<style scoped>
.ave-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4);
  text-align: center;
}
.ave-title {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text);
}
.ave-hint {
  margin: 0;
  max-width: 420px;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
