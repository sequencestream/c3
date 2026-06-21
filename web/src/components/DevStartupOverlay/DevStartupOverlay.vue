<script setup lang="ts">
/*
 * DevStartupOverlay.vue — 开发启动进度遮罩。
 *
 * 仅服务于需求详情页「Start Dev」触发的 start_development 启动等待:当启动耗时超过
 * 阈值(>5s)时,以全屏阻断遮罩按有序步骤展示后端推送的粗粒度阶段进度,启动就绪/失败/
 * 安全超时后由控制层关闭(model 置空)。本组件是纯展示:不持有计时器/状态,只渲染传入的
 * model 与派生步骤(判定逻辑在 lib/dev-launch-view.ts,可单测)。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import {
  DEV_LAUNCH_STEPS,
  stepStatusesForPhase,
  type DevLaunchModel,
  type DevLaunchStep,
  type StepStatus,
} from '@/lib/dev-launch-view'

const props = defineProps<{ model: DevLaunchModel | null }>()
const { t } = useTypedI18n()

// 仅当存在在途启动且已越过显示阈值(visible)时才渲染遮罩。
const shown = computed(() => !!props.model && props.model.visible)

// 步骤 → 文案 key(字面量,保证 typed t 编译期校验)。
const STEP_LABEL_KEY: Record<DevLaunchStep, Parameters<typeof t>[0]> = {
  'prepare-workspace': 'intent.devLaunch.step.prepareWorkspace',
  'launch-session': 'intent.devLaunch.step.launchSession',
  'enter-session': 'intent.devLaunch.step.enterSession',
}

const steps = computed<{ key: DevLaunchStep; label: string; status: StepStatus }[]>(() => {
  const phase = props.model?.phase ?? 'preparing-workspace'
  const statuses = stepStatusesForPhase(phase)
  return DEV_LAUNCH_STEPS.map((step, i) => ({
    key: step,
    label: t(STEP_LABEL_KEY[step]),
    status: statuses[i],
  }))
})
</script>

<template>
  <div
    v-if="shown"
    class="dso-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-busy="true"
    :aria-label="t('intent.devLaunch.title')"
    data-testid="dev-startup-overlay"
  >
    <div class="dso-panel">
      <h3 class="dso-title">{{ t('intent.devLaunch.title') }}</h3>
      <ol class="dso-steps">
        <li
          v-for="step in steps"
          :key="step.key"
          class="dso-step"
          :class="`is-${step.status}`"
          :data-status="step.status"
        >
          <span class="dso-marker" aria-hidden="true">
            <span v-if="step.status === 'done'" class="dso-check">✓</span>
            <span v-else-if="step.status === 'active'" class="dso-spinner" />
            <span v-else class="dso-dot" />
          </span>
          <span class="dso-label">{{ step.label }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
/* 全屏阻断层:盖住所有内容并吃掉点击(z-index 低于全局 toast 1000,失败 toast 仍可见)。 */
.dso-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1px);
}
.dso-panel {
  width: 90vw;
  max-width: 380px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-5);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.dso-title {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-body);
  font-weight: 600;
}
.dso-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.dso-step {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.dso-step.is-done {
  color: var(--c-text);
}
.dso-step.is-active {
  color: var(--c-text);
  font-weight: 600;
}
.dso-marker {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dso-check {
  color: var(--c-success, #2e9e44);
  font-size: 14px;
  line-height: 1;
}
.dso-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--c-border);
}
.dso-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  animation: dso-spin 0.7s linear infinite;
}
@keyframes dso-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dso-spinner {
    animation-duration: 1.6s;
  }
}

/* 移动端:面板贴近全宽。 */
@media (max-width: 767px) {
  .dso-panel {
    width: calc(100vw - 2 * var(--sp-4));
    max-width: none;
  }
}
</style>
