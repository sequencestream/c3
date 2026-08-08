<script setup lang="ts">
/*
 * AsyncOverlayError.vue — 弹窗/覆盖层级异步组件的加载失败兜底。
 *
 * 失败时绝不留一层吃掉点击的黑遮罩:承载层 pointer-events:none,只有卡片本身可点,
 * 应用其余部分照常可用。卡片上的「关闭」只收起这张卡片:打开状态由 App 的门控 ref
 * (skillApprovalRequest、automationSaving 等)持有,本组件够不着也不该去改。所以收起
 * 之后那条流程仍停在打开态,后续也换不回真正的面板——失败的 chunk 已被浏览器记进模块图,
 * 重开只会拿回同一条失败记录。与页面级兜底同源:唯一的恢复路径是整页刷新,文案照此引导,
 * 不自动重试。收起卡片换来的是「不挡着用应用其余部分」,不是那条流程已经收尾。
 */
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()
const dismissed = ref(false)
</script>

<template>
  <div v-if="!dismissed" class="aoe-layer" data-testid="async-overlay-error">
    <div class="aoe-card" role="alert">
      <p class="aoe-title">{{ t('common.async.error.label') }}</p>
      <p class="aoe-hint">{{ t('common.async.error.hint') }}</p>
      <div class="aoe-actions">
        <button type="button" class="aoe-close" @click="dismissed = true">
          {{ t('common.action.close.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aoe-layer {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 失败态不阻断应用:只有卡片吃指针事件。 */
  pointer-events: none;
}
.aoe-card {
  pointer-events: auto;
  width: 90vw;
  max-width: 380px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.aoe-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--c-text);
}
.aoe-hint {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.aoe-actions {
  margin-top: var(--sp-4);
  display: flex;
  justify-content: flex-end;
}
.aoe-close {
  padding: 6px 14px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-input);
  color: var(--c-text);
  font-size: var(--fs-caption);
  cursor: pointer;
}
.aoe-close:hover {
  border-color: var(--c-accent, #3b82f6);
}
</style>
