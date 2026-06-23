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
      <ol>
        <li v-for="item in steps" :key="item.step" :data-status="item.status">{{ item.label }}</li>
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
ol {
  margin: 0;
  padding-left: var(--sp-4);
  color: var(--c-text-muted);
}
li[data-status='active'] {
  color: var(--c-text);
  font-weight: 600;
}
li[data-status='done'] {
  color: var(--c-text);
}
</style>
