<script setup lang="ts">
/*
 * AutomationSaveOverlay.vue — automation 保存进度遮罩。
 *
 * 创建/编辑 automation 提交后立即显示全屏阻断遮罩和"正在保存"提示，覆盖普通创建与从模板
 * 创建两条路径；保存完成或失败后由控制层关闭(prop 置 false)。
 *
 * 纯展示组件：不持有计时器/状态，只渲染传入的 saving prop。
 */
import { useTypedI18n } from '@/i18n'

defineProps<{ saving: boolean }>()
const { t } = useTypedI18n()
</script>

<template>
  <div
    v-if="saving"
    class="sso-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-busy="true"
    :aria-label="t('automation.saveOverlay.title')"
    data-testid="automation-save-overlay"
  >
    <div class="sso-panel">
      <div class="sso-spinner" aria-hidden="true" />
      <span class="sso-label">{{ t('automation.saveOverlay.label') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 全屏阻断层：盖住 automation 表单(z-index 200)等内容但低于 toast(z-index 1000)。 */
.sso-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1px);
}
.sso-panel {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4) var(--sp-5);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.sso-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: sso-spin 0.7s linear infinite;
  flex-shrink: 0;
}
.sso-label {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--c-text);
}
@keyframes sso-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sso-spinner {
    animation-duration: 1.6s;
  }
}
</style>
