<script setup lang="ts">
/*
 * IntentEngineeringProgress.vue — 意图详情头部的只读工程进度条(意图→[规范]→工作→[PR])。
 *
 * 状态派生唯一以 deriveIntentEngineeringProgress 为规则源;本组件只负责阶段/状态的本地化、
 * 无障碍标注与响应式布局,不复制 PR / Spec / Work 的派生判断。SDD 关闭、或 fast 意图尚无
 * 规范数据时省略规范段,仅 worktree 模式追加 PR 段——均由纯函数按既有字段决定。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import {
  deriveIntentEngineeringProgress,
  type EngineeringProgressInput,
  type EngineeringProgressStage,
  type EngineeringProgressState,
} from '../../../../lib/intent-engineering-progress'

const { t } = useTypedI18n()

const props = defineProps<{
  intent: EngineeringProgressInput
  sddEnabled: boolean
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
}>()

const progress = computed(() =>
  deriveIntentEngineeringProgress(
    props.intent,
    props.sddEnabled === true,
    props.workspaceGitBranchMode,
  ),
)

function progressStageLabel(stage: EngineeringProgressStage): string {
  if (stage === 'intent') return t('intent.engineeringProgress.stage.intent')
  if (stage === 'spec') return t('intent.engineeringProgress.stage.spec')
  if (stage === 'work') return t('intent.engineeringProgress.stage.work')
  return t('intent.engineeringProgress.stage.pr')
}

function progressStateLabel(state: EngineeringProgressState): string {
  if (state === 'not_started') return t('intent.engineeringProgress.state.notStarted')
  if (state === 'in_progress') return t('intent.engineeringProgress.state.inProgress')
  if (state === 'completed') return t('intent.engineeringProgress.state.completed')
  return t('intent.engineeringProgress.state.closed')
}
</script>

<template>
  <ol
    class="intent-engineering-progress"
    data-testid="intent-engineering-progress"
    :aria-label="t('intent.engineeringProgress.ariaLabel')"
  >
    <li
      v-for="item in progress"
      :key="item.stage"
      class="intent-engineering-progress-stage"
      :class="`is-${item.state}`"
      :data-stage="item.stage"
      :data-state="item.state"
    >
      <span class="intent-engineering-progress-name">{{ progressStageLabel(item.stage) }}</span>
      <span class="intent-engineering-progress-marker" aria-hidden="true"></span>
      <span class="intent-engineering-progress-state">{{ progressStateLabel(item.state) }}</span>
    </li>
  </ol>
</template>

<style scoped>
.intent-engineering-progress {
  width: min(100%, 560px);
  margin: var(--sp-3) 0 0;
  padding: 0;
  display: flex;
  list-style: none;
  overflow-x: auto;
}
.intent-engineering-progress-stage {
  position: relative;
  min-width: 112px;
  flex: 1 0 112px;
  display: grid;
  grid-template-rows: auto 12px auto;
  row-gap: var(--sp-1);
  justify-items: start;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  text-align: left;
}
.intent-engineering-progress-stage:not(:last-child)::after {
  content: '';
  position: absolute;
  top: calc(1em * var(--lh-normal) + var(--sp-1) + 5px);
  left: 6px;
  right: -6px;
  height: 2px;
  background: var(--c-border);
}
.intent-engineering-progress-marker {
  z-index: 1;
  width: 12px;
  height: 12px;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--c-bg);
}
.intent-engineering-progress-name {
  color: var(--c-text);
  font-weight: 600;
  white-space: nowrap;
}
.intent-engineering-progress-state {
  white-space: nowrap;
}
.intent-engineering-progress-stage.is-in_progress .intent-engineering-progress-marker {
  border-color: var(--c-success);
  box-shadow: inset 0 0 0 2px var(--c-bg);
  background: var(--c-success);
}
.intent-engineering-progress-stage.is-completed .intent-engineering-progress-marker {
  border-color: var(--c-primary);
  background: var(--c-primary);
}
.intent-engineering-progress-stage.is-in_progress .intent-engineering-progress-state {
  color: var(--c-success-text);
}
.intent-engineering-progress-stage.is-completed .intent-engineering-progress-state {
  color: var(--c-primary);
}
.intent-engineering-progress-stage.is-closed .intent-engineering-progress-marker {
  border-color: var(--c-error);
  background: var(--c-error);
}
</style>
