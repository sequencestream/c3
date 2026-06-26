<script setup lang="ts">
/**
 * ScheduleDetail.vue — schedules 视图右栏:选中 schedule 的详情面板。
 *
 * 当左侧列表选中一个 schedule 但未选中具体执行时展示,包含:
 *  - Vendor 品牌名 + 色点
 *  - 类型、命令或 Prompt、执行超时与 mcpMode
 *  - toolAllowlist 单行换行列表
 *
 * Props:
 *  - schedule: 选中的定时任务对象(null 时隐藏)
 *  - toolManifest: per-vendor 工具清单缓存,用于判断工具读写属性
 */
import { computed } from 'vue'
import { describeCron } from '@ccc/shared/cron'
import type { AgentConfig, Schedule, ToolManifestEntry } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  schedule: Schedule | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
  agents: AgentConfig[]
}>()

const cronDescription = computed(() =>
  props.schedule?.triggerType === 'cron' ? describeCron(props.schedule.cronExpression) : '',
)

const agentLabel = computed(() => {
  const agentId = props.schedule?.agentId
  if (!agentId) return '—'
  return props.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId
})

/** toolAllowlist 条目数量。 */
const allowlistCount = computed(() => props.schedule?.toolAllowlist.length ?? 0)

function configText(config: unknown, key: 'command' | 'prompt'): string {
  if (!config || typeof config !== 'object') return '—'
  const value = (config as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : '—'
}

const taskContent = computed(() => {
  const schedule = props.schedule
  return schedule
    ? configText(schedule.config, schedule.type === 'command' ? 'command' : 'prompt')
    : '—'
})

const timeout = computed(() => {
  const value = props.schedule?.maxWallClockMs
  return value === null || value === undefined
    ? t('schedule.form.maxWallClockMs.placeholder')
    : `${value} ms`
})

function eventTopicLabel(topic: Schedule['eventTopic']): string {
  switch (topic) {
    case 'run:started':
      return t('schedule.form.event.topic.started.label')
    case 'run:settled':
      return t('schedule.form.event.topic.settled.label')
    case 'pr:operation':
      return t('schedule.form.event.topic.prOperation.label')
    default:
      return '—'
  }
}

function reasonLabel(reason: 'complete' | 'error' | 'aborted'): string {
  switch (reason) {
    case 'complete':
      return t('schedule.form.event.reason.complete.label')
    case 'error':
      return t('schedule.form.event.reason.error.label')
    case 'aborted':
      return t('schedule.form.event.reason.aborted.label')
  }
}

function prOperationLabel(operation: 'create' | 'review' | 'merge' | 'close' | 'comment'): string {
  switch (operation) {
    case 'create':
      return t('schedule.form.event.pr.op.create.label')
    case 'review':
      return t('schedule.form.event.pr.op.review.label')
    case 'merge':
      return t('schedule.form.event.pr.op.merge.label')
    case 'close':
      return t('schedule.form.event.pr.op.close.label')
    case 'comment':
      return t('schedule.form.event.pr.op.comment.label')
  }
}

function prResultLabel(result: 'success' | 'failure'): string {
  return result === 'success'
    ? t('schedule.form.event.pr.result.success.label')
    : t('schedule.form.event.pr.result.failure.label')
}

const eventTopic = computed(() => eventTopicLabel(props.schedule?.eventTopic ?? null))
const reasonFilter = computed(() => props.schedule?.eventReasonFilter?.map(reasonLabel) ?? [])
const prOperationFilter = computed(
  () => props.schedule?.eventPrFilter?.operations?.map(prOperationLabel) ?? [],
)
const prResultFilter = computed(
  () => props.schedule?.eventPrFilter?.results?.map(prResultLabel) ?? [],
)

/** mode → 显示标签。不再走 i18n（mode token 本身已是英文可读值）。 */
function modeLabel(mode: unknown): string {
  // CodexPolicy object
  if (mode && typeof mode === 'object') {
    const p = mode as { sandboxMode?: string; approvalPolicy?: string }
    return `${p.sandboxMode ?? '?'} / ${p.approvalPolicy ?? '?'}`
  }
  // Legacy McpMode values that may still exist in the database.
  const s = String(mode)
  return s
}

function vendorDotBg(vendor: string): string {
  return VENDOR_COLOR[vendor as keyof typeof VENDOR_COLOR] || '#888'
}
function vendorLabel(vendor: string): string {
  return VENDOR_LABEL[vendor as keyof typeof VENDOR_LABEL] || vendor
}
</script>

<template>
  <div v-if="schedule" class="sched-detail-wrap">
    <div class="sched-detail-head">
      <span class="sched-detail-title">{{ t('schedule.list.title.label') }}</span>
      <span class="sched-detail-id mono">{{ schedule.id }}</span>
    </div>

    <div class="sched-detail-body">
      <!-- Vendor -->
      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.vendor.label') }}</span>
        <span class="sd-value sd-value--vendor">
          <span class="vendor-dot" :style="{ backgroundColor: vendorDotBg(schedule.vendor) }" />
          {{ vendorLabel(schedule.vendor) }}
        </span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.agent.label') }}</span>
        <span class="sd-value">{{ agentLabel }}</span>
      </div>

      <!-- mode -->
      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.meta.mode.label') }}</span>
        <span class="sd-value">{{ modeLabel(schedule.mode) }}</span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.taskType.label') }}</span>
        <span class="sd-value">{{
          schedule.type === 'command'
            ? t('schedule.form.type.command.label')
            : t('schedule.form.type.llm.label')
        }}</span>
      </div>

      <div class="sd-row sd-row--content">
        <span class="sd-label">{{
          schedule.type === 'command'
            ? t('schedule.form.command.label')
            : t('schedule.form.prompt.label')
        }}</span>
        <code class="sd-task-content">{{ taskContent }}</code>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.maxWallClockMs.label') }}</span>
        <span class="sd-value">{{ timeout }}</span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.trigger.label') }}</span>
        <span class="sd-value">{{
          schedule.triggerType === 'cron'
            ? t('schedule.form.trigger.cron.label')
            : t('schedule.form.trigger.event.label')
        }}</span>
      </div>

      <template v-if="schedule.triggerType === 'event'">
        <div class="sd-row">
          <span class="sd-label">{{ t('schedule.form.event.topic.label') }}</span>
          <span class="sd-value">{{ eventTopic }}</span>
        </div>
        <div v-if="schedule.eventTopic === 'run:settled'" class="sd-row sd-row--content">
          <span class="sd-label">{{ t('schedule.form.event.reason.label') }}</span>
          <span v-if="reasonFilter.length" class="sd-value">{{ reasonFilter.join(' · ') }}</span>
          <span v-else class="sd-value sd-value--hint">{{
            t('schedule.form.event.reason.hint')
          }}</span>
        </div>
        <template v-if="schedule.eventTopic === 'pr:operation'">
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('schedule.form.event.pr.op.label') }}</span>
            <span v-if="prOperationFilter.length" class="sd-value">{{
              prOperationFilter.join(' · ')
            }}</span>
            <span v-else class="sd-value sd-value--hint">{{
              t('schedule.form.event.pr.hint')
            }}</span>
          </div>
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('schedule.form.event.pr.result.label') }}</span>
            <span v-if="prResultFilter.length" class="sd-value">{{
              prResultFilter.join(' · ')
            }}</span>
            <span v-else class="sd-value sd-value--hint">{{
              t('schedule.form.event.pr.hint')
            }}</span>
          </div>
        </template>
      </template>

      <div v-if="schedule.triggerType === 'cron'" class="sd-row sd-row--schedule">
        <span class="sd-label">{{ t('schedule.form.schedule.label') }}</span>
        <code class="sd-cron">{{ schedule.cronExpression }}</code>
        <span class="sd-cron-description">{{ cronDescription }}</span>
      </div>

      <!-- Tool Allowlist -->
      <div class="sd-section">
        <h4 class="sd-section-title">{{ t('schedule.form.tools.label') }}</h4>

        <!-- 空列表:全部工具无限制 -->
        <p v-if="allowlistCount === 0" class="sd-tools-empty">
          {{ t('schedule.list.toolSummaryAll') }}
        </p>

        <ul v-else class="sd-tool-list">
          <li
            v-for="name in schedule.toolAllowlist"
            :key="name"
            data-testid="sd-tool-item"
            class="sd-tool-item"
          >
            {{ name }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched-detail-wrap {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  color: var(--c-text);
  overflow: hidden;
}

.sched-detail-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.sched-detail-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  white-space: nowrap;
}
.sched-detail-id {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-detail-id.mono {
  font-family: var(--ff-mono, monospace);
}

.sched-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sd-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.sd-label {
  color: var(--c-text-muted);
  min-width: 80px;
  flex-shrink: 0;
}
.sd-value {
  color: var(--c-text);
}
.sd-value--vendor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sd-value--hint {
  color: var(--c-text-muted);
  font-style: italic;
}
.sd-row--schedule {
  flex-wrap: wrap;
}
.sd-row--content {
  align-items: flex-start;
}
.sd-cron {
  color: var(--c-text);
  font-family: var(--ff-mono, monospace);
}
.sd-cron-description {
  color: var(--c-text-muted);
}
.sd-task-content {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--c-text);
  font-family: var(--ff-mono, monospace);
}

.sd-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sd-section-title {
  font-size: var(--fs-body);
  font-weight: 600;
  margin: var(--sp-2) 0 0 0;
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--c-border);
}

.sd-tool-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.sd-tool-item {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  color: var(--c-text);
  background: var(--c-hover);
  overflow-wrap: anywhere;
}

.sd-tools-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
  font-style: italic;
}
</style>
