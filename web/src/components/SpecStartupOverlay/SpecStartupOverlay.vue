<script setup lang="ts">
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import {
  SPEC_LAUNCH_STEPS,
  specLaunchStepStatuses,
  type SpecLaunchModel,
  type SpecLaunchStep,
} from '@/lib/spec-launch-view'
const props = defineProps<{ model: SpecLaunchModel | null }>()
const { t } = useTypedI18n()
const keys: Record<SpecLaunchStep, Parameters<typeof t>[0]> = {
  'checking-dependencies': 'intent.specLaunch.step.checkDependencies',
  'pulling-code': 'intent.specLaunch.step.pullCode',
  'launching-session': 'intent.specLaunch.step.launchSession',
}
const steps = computed(() =>
  SPEC_LAUNCH_STEPS.map((step, i) => ({
    step,
    label: t(keys[step]),
    status: specLaunchStepStatuses(props.model?.phase ?? 'checking-dependencies')[i],
  })),
)
</script>
<template>
  <div
    v-if="model"
    class="sso-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-busy="true"
    data-testid="spec-startup-overlay"
  >
    <div class="sso-panel">
      <h3>{{ t('intent.specLaunch.title') }}</h3>
      <ol class="sso-steps">
        <li
          v-for="item in steps"
          :key="item.step"
          class="sso-step"
          :class="`is-${item.status}`"
          :data-status="item.status"
        >
          <span class="sso-marker" aria-hidden="true">
            <span v-if="item.status === 'done'" class="sso-check">✓</span>
            <span v-else-if="item.status === 'active'" class="sso-spinner" />
            <span v-else class="sso-dot" />
          </span>
          <span class="sso-label">{{ item.label }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>
<style scoped>
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
  width: 90vw;
  max-width: 380px;
  padding: var(--sp-4);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.sso-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sso-step {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sso-step.is-active {
  color: var(--c-text);
  font-weight: 600;
}
.sso-step.is-done {
  color: var(--c-text);
}
.sso-marker {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sso-check {
  color: var(--c-success, #2e9e44);
  font-size: 14px;
  line-height: 1;
}
.sso-dot {
  width: 8px;
  height: 8px;
  border: 1px solid var(--c-border);
  border-radius: 50%;
}
.sso-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-accent, #3b82f6);
  border-radius: 50%;
  animation: sso-spin 0.7s linear infinite;
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
