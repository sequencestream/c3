<script setup lang="ts">
/*
 * AsyncViewError.vue — 页面级异步组件的加载失败兜底。
 *
 * chunk 拉取失败(离线、部署换版导致旧 hash 404)时替代页面渲染:只给一个稳定容器
 * 和一句解释,不自动重试——重试路径是用户自己的动作(切到别的 tab 再切回来会重新
 * 发起一次加载,刷新页面则取到新版本清单)。不依赖任何业务组件内部实现。
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
