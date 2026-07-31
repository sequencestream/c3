<script setup lang="ts">
/*
 * CreatePrOverlay.vue — 创建 PR 进度遮罩。
 *
 * 仅服务于需求详情页「创建 PR」触发的 create_pr 等待:该操作包含 commit、push 与托管平台调用,
 * 可能持续数秒。点击后立即以全屏阻断遮罩按序展示后端推送的四个阶段(分析代码变更 / 提交 /
 * 推送 / 创建 PR),并以最小停留时间防止快速完成时闪烁。成功、失败或安全超时后由控制层关闭
 * (model 置空);与 Start Work 遮罩一致,不提供取消入口。本组件是纯展示:不持有计时器/状态,
 * 只渲染传入的 model 与派生步骤(判定逻辑在 lib/create-pr-view.ts,可单测)。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import {
  CREATE_PR_STEPS,
  createPrStepStatuses,
  type CreatePrModel,
  type CreatePrStep,
  type CreatePrStepStatus,
} from '@/lib/create-pr-view'

const props = defineProps<{ model: CreatePrModel | null }>()
const { t } = useTypedI18n()

// 仅当存在在途创建时渲染遮罩。
const shown = computed(() => !!props.model)

// 步骤 → 文案 key(字面量,保证 typed t 编译期校验)。
const STEP_LABEL_KEY: Record<CreatePrStep, Parameters<typeof t>[0]> = {
  'analyze-changes': 'intent.createPrProgress.step.analyzeChanges',
  commit: 'intent.createPrProgress.step.commit',
  push: 'intent.createPrProgress.step.push',
  'create-pr': 'intent.createPrProgress.step.createPr',
}

const steps = computed<{ key: CreatePrStep; label: string; status: CreatePrStepStatus }[]>(() => {
  const phase = props.model?.phase ?? 'analyzing-changes'
  const statuses = createPrStepStatuses(phase)
  return CREATE_PR_STEPS.map((step, i) => ({
    key: step,
    label: t(STEP_LABEL_KEY[step]),
    status: statuses[i],
  }))
})
</script>

<template>
  <div
    v-if="shown"
    class="cpo-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-busy="true"
    :aria-label="t('intent.createPrProgress.title')"
    data-testid="create-pr-overlay"
  >
    <div class="cpo-panel">
      <h3 class="cpo-title">{{ t('intent.createPrProgress.title') }}</h3>
      <ol class="cpo-steps">
        <li
          v-for="step in steps"
          :key="step.key"
          class="cpo-step"
          :class="`is-${step.status}`"
          :data-status="step.status"
        >
          <span class="cpo-marker" aria-hidden="true">
            <span v-if="step.status === 'done'" class="cpo-check">✓</span>
            <span v-else-if="step.status === 'active'" class="cpo-spinner" />
            <span v-else class="cpo-dot" />
          </span>
          <span class="cpo-label">{{ step.label }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
/* 全屏阻断层:盖住所有内容并吃掉点击(z-index 低于全局 toast 1000,失败提示仍可见)。 */
.cpo-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1px);
}
.cpo-panel {
  width: 90vw;
  max-width: 380px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.cpo-title {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-body);
  font-weight: 600;
}
.cpo-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.cpo-step {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.cpo-step.is-done {
  color: var(--c-text);
}
.cpo-step.is-active {
  color: var(--c-text);
  font-weight: 600;
}
.cpo-marker {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cpo-check {
  color: var(--c-success-text);
  font-size: 14px;
  line-height: 1;
}
.cpo-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--c-border);
}
.cpo-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: cpo-spin 0.7s linear infinite;
}
@keyframes cpo-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cpo-spinner {
    animation-duration: 1.6s;
  }
}

/* 移动端:面板贴近全宽。 */
@media (max-width: 767px) {
  .cpo-panel {
    width: calc(100vw - 2 * var(--sp-4));
    max-width: none;
  }
}
</style>
