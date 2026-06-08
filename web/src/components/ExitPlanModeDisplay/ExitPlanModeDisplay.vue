<script setup lang="ts">
/*
 * ExitPlanModeDisplay.vue — ExitPlanMode 计划独立渲染块
 *
 * 在 standalone 块内展示模型提交的计划。对 tool-use 消息解析输入负载中的计划正文
 *（Markdown 渲染）和结构化元数据（标题、步骤等）；对 tool-result 消息展示结果。
 * 解析是防御性的：Unknown / 未来数据形状会回退到全量格式化。
 */
import MarkdownText from '../MarkdownText/MarkdownText.vue'
import type { ChatMsg } from '../../lib/chat-types'
import { fmt } from '../../lib/format'

const props = defineProps<{
  /** The user-interaction tool message (tool-use or tool-result). */
  m: ChatMsg
}>()

// Fixed protocol identifiers shown verbatim (do-not-translate; bound via consts
// so `no-raw-text` doesn't flag them as hard-coded copy).
const EXIT_PLAN_MODE_LABEL = 'ExitPlanMode'

/**
 * Read the plan body/markdown from the tool-use input. Tries common field names
 * defensively; falls back to rendering the full input.
 */
function planBody(): string {
  if (props.m.kind !== 'tool-use') return ''
  const input = props.m.input as Record<string, unknown>
  if (typeof input.body === 'string' && input.body.trim()) return input.body
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan
  if (typeof input.text === 'string' && input.text.trim()) return input.text
  if (typeof input.content === 'string' && input.content.trim()) return input.content
  // Fallback: render the full input as formatted JSON
  return fmt(props.m.input)
}

/** Read the plan title from the tool-use input, or null if absent. */
function planTitle(): string | null {
  if (props.m.kind !== 'tool-use') return null
  const input = props.m.input as Record<string, unknown>
  if (typeof input.title === 'string' && input.title.trim()) return input.title.trim()
  return null
}

/** Read the plan steps list from the tool-use input (defensive). */
function planSteps(): string[] {
  if (props.m.kind !== 'tool-use') return []
  const input = props.m.input as Record<string, unknown>
  if (Array.isArray(input.steps))
    return input.steps.filter((s): s is string => typeof s === 'string')
  return []
}
</script>

<template>
  <div class="exit-plan-mode">
    <div class="label">
      {{ EXIT_PLAN_MODE_LABEL }}
    </div>

    <!-- Tool-use: show the plan content -->
    <template v-if="m.kind === 'tool-use'">
      <!-- Structured metadata: title -->
      <div v-if="planTitle()" class="plan-meta-title">{{ planTitle() }}</div>

      <!-- Structured metadata: steps index -->
      <div v-if="planSteps().length > 0" class="plan-steps-index">
        <div v-for="(step, i) in planSteps()" :key="i" class="plan-step-row">
          <span class="step-num">{{ i + 1 }}</span>
          <span class="step-label">{{ step }}</span>
        </div>
      </div>

      <!-- Plan body rendered as Markdown (full width, no chat-bubble padding) -->
      <div class="plan-body">
        <MarkdownText :text="planBody()" markdown />
      </div>
    </template>

    <!-- Tool-result: show the outcome -->
    <div v-else-if="m.kind === 'tool-result'" class="plan-result">
      <pre class="tool-body">{{ m.content || '' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.exit-plan-mode {
  --exit-plan-gap: 0.6em;
}

.exit-plan-mode .label {
  font-family: var(--ff-mono, 'SF Mono', 'Fira Code', monospace);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  margin-bottom: 0.4em;
}

/* Structured metadata: title row */
.plan-meta-title {
  font-weight: 700;
  font-size: 1em;
  line-height: 1.4;
  margin-bottom: var(--exit-plan-gap);
  color: var(--c-text);
}

/* Structured metadata: steps index */
.plan-steps-index {
  display: flex;
  flex-direction: column;
  gap: 0.3em;
  margin-bottom: var(--exit-plan-gap);
  padding: 0.5em 0.6em;
  background: var(--c-bg-soft, rgba(128, 128, 128, 0.06));
  border-radius: 6px;
}

.plan-step-row {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  line-height: 1.4;
  font-size: var(--fs-body);
}

.step-num {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6em;
  height: 1.6em;
  border-radius: 999px;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--c-primary, #5b9aff);
  background: var(--c-primary-soft, rgba(91, 154, 255, 0.12));
}

.step-label {
  color: var(--c-text);
}

/* Plan body (markdown content) */
.plan-body {
  margin-top: var(--exit-plan-gap);
}

.plan-body :deep(p:first-child) {
  margin-top: 0;
}

.plan-body :deep(p:last-child) {
  margin-bottom: 0;
}

/* Tool-result: outcome */
.plan-result {
  margin-top: var(--exit-plan-gap);
}
</style>
