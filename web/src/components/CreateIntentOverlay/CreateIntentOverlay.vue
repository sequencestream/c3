<script setup lang="ts">
/*
 * CreateIntentOverlay.vue — 创建意图进度遮罩。
 *
 * 仅服务于「增加意图」弹窗提交带内容创建后的等待:服务端在一次请求里连做 fetch 基准/交付分支、
 * worktree 准备、落库意图与启动意图会话,耗时可达数十秒。提交后立即以全屏阻断遮罩按序展示四个
 * 阶段(下载关联分支 / 拉取关联分支 / 创建意图 / 打开意图会话),并以最小停留时间防止快速完成时
 * 闪烁。成功、拒绝或安全超时后由控制层关闭(model 置空);与创建 PR 遮罩一致,不提供取消入口。
 * 本组件是纯展示:不持有计时器/状态,只渲染传入的 model 与派生步骤(判定逻辑在
 * lib/create-intent-view.ts,可单测;阶段是前端按固定节奏的近似还原,协议无进度帧)。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import {
  CREATE_INTENT_STEPS,
  createIntentStepStatuses,
  type CreateIntentModel,
  type CreateIntentStep,
  type CreateIntentStepStatus,
} from '@/lib/create-intent-view'

const props = defineProps<{ model: CreateIntentModel | null }>()
const { t } = useTypedI18n()

// 仅当存在在途创建时渲染遮罩。
const shown = computed(() => !!props.model)

// 步骤 → 文案 key(字面量,保证 typed t 编译期校验)。
const STEP_LABEL_KEY: Record<CreateIntentStep, Parameters<typeof t>[0]> = {
  'fetch-branch': 'intent.createIntentProgress.step.fetchBranch',
  'prepare-worktree': 'intent.createIntentProgress.step.prepareWorktree',
  'create-intent': 'intent.createIntentProgress.step.createIntent',
  'open-session': 'intent.createIntentProgress.step.openSession',
}

const steps = computed<{ key: CreateIntentStep; label: string; status: CreateIntentStepStatus }[]>(
  () => {
    const phase = props.model?.phase ?? CREATE_INTENT_STEPS[0]
    const statuses = createIntentStepStatuses(phase)
    return CREATE_INTENT_STEPS.map((step, i) => ({
      key: step,
      label: t(STEP_LABEL_KEY[step]),
      status: statuses[i],
    }))
  },
)
</script>

<template>
  <div
    v-if="shown"
    class="cio-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-busy="true"
    :aria-label="t('intent.createIntentProgress.title')"
    data-testid="create-intent-overlay"
  >
    <div class="cio-panel">
      <h3 class="cio-title">{{ t('intent.createIntentProgress.title') }}</h3>
      <ol class="cio-steps">
        <li
          v-for="step in steps"
          :key="step.key"
          class="cio-step"
          :class="`is-${step.status}`"
          :data-status="step.status"
        >
          <span class="cio-marker" aria-hidden="true">
            <span v-if="step.status === 'done'" class="cio-check">✓</span>
            <span v-else-if="step.status === 'active'" class="cio-spinner" />
            <span v-else class="cio-dot" />
          </span>
          <span class="cio-label">{{ step.label }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
/* 全屏阻断层:盖住新增意图弹窗与所有内容并吃掉点击(z-index 低于全局 toast 1000,
   拒绝/超时提示仍可见)。 */
.cio-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1px);
}
.cio-panel {
  width: 90vw;
  max-width: 380px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.cio-title {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-body);
  font-weight: 600;
}
.cio-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.cio-step {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.cio-step.is-done {
  color: var(--c-text);
}
.cio-step.is-active {
  color: var(--c-text);
  font-weight: 600;
}
.cio-marker {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cio-check {
  color: var(--c-success-text);
  font-size: 14px;
  line-height: 1;
}
.cio-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--c-border);
}
.cio-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: cio-spin 0.7s linear infinite;
}
@keyframes cio-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cio-spinner {
    animation-duration: 1.6s;
  }
}

/* 移动端:面板贴近全宽。 */
@media (max-width: 767px) {
  .cio-panel {
    width: calc(100vw - 2 * var(--sp-4));
    max-width: none;
  }
}
</style>
