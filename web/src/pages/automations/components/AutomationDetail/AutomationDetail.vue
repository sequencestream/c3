<script setup lang="ts">
/**
 * AutomationDetail.vue — automations 视图右栏:选中 automation 的详情面板。
 *
 * 当左侧列表选中一个 automation 但未选中具体执行时展示,包含:
 *  - Vendor 品牌名 + 色点
 *  - 类型、命令或 Prompt、执行超时与 mcpMode
 *  - toolAllowlist 单行换行列表
 *
 * Props:
 *  - automation: 选中的自动化对象(null 时隐藏)
 *  - toolManifest: per-vendor 工具清单缓存,用于判断工具读写属性
 */
import { computed, ref, watch } from 'vue'
import { describeCron } from '@ccc/shared/cron'
import type {
  AgentConfig,
  ClientToServer,
  IntentLifecyclePhase,
  PrOperation,
  PrOperationResult,
  RunEndReason,
  Automation,
  ScheduleEventTopic,
  SessionKind,
  ToolManifestEntry,
} from '@ccc/shared/protocol'
import {
  INTENT_LIFECYCLE_PHASES,
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  SESSION_KINDS,
} from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

/** The simulate-trigger payload (client message minus its `type` tag). */
type SimulateInput = Omit<Extract<ClientToServer, { type: 'simulate_automation_trigger' }>, 'type'>

const props = defineProps<{
  automation: Automation | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
  agents: AgentConfig[]
  /** Latest simulation result for the selected automation (null = none run yet). */
  simulationResult: {
    automationId: string
    matched: boolean
    breakdown: { name: string; passed: boolean }[]
  } | null
}>()

const emit = defineEmits<{
  simulate: [input: SimulateInput]
}>()

const cronDescription = computed(() =>
  props.automation?.triggerType === 'cron' ? describeCron(props.automation.cronExpression) : '',
)

const agentLabel = computed(() => {
  const agentId = props.automation?.agentId
  if (!agentId) return '—'
  return props.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId
})

/** toolAllowlist 条目数量。 */
const allowlistCount = computed(() => props.automation?.toolAllowlist.length ?? 0)

function configText(config: unknown, key: 'command' | 'prompt'): string {
  if (!config || typeof config !== 'object') return '—'
  const value = (config as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : '—'
}

const taskContent = computed(() => {
  const automation = props.automation
  return automation
    ? configText(automation.config, automation.type === 'command' ? 'command' : 'prompt')
    : '—'
})

const timeout = computed(() => {
  const value = props.automation?.maxWallClockMs
  return value === null || value === undefined
    ? t('automation.form.maxWallClockMs.placeholder')
    : `${value} ms`
})

function eventTopicLabel(topic: Automation['eventTopic']): string {
  switch (topic) {
    case 'run:started':
      return t('automation.form.event.topic.started.label')
    case 'run:settled':
      return t('automation.form.event.topic.settled.label')
    case 'pr:operation':
      return t('automation.form.event.topic.prOperation.label')
    default:
      return '—'
  }
}

function reasonLabel(reason: 'complete' | 'error' | 'aborted'): string {
  switch (reason) {
    case 'complete':
      return t('automation.form.event.reason.complete.label')
    case 'error':
      return t('automation.form.event.reason.error.label')
    case 'aborted':
      return t('automation.form.event.reason.aborted.label')
  }
}

function prOperationLabel(operation: 'create' | 'review' | 'merge' | 'close' | 'comment'): string {
  switch (operation) {
    case 'create':
      return t('automation.form.event.pr.op.create.label')
    case 'review':
      return t('automation.form.event.pr.op.review.label')
    case 'merge':
      return t('automation.form.event.pr.op.merge.label')
    case 'close':
      return t('automation.form.event.pr.op.close.label')
    case 'comment':
      return t('automation.form.event.pr.op.comment.label')
  }
}

function prResultLabel(result: PrOperationResult): string {
  switch (result) {
    case 'success':
      return t('automation.form.event.pr.result.success.label')
    case 'failure':
      return t('automation.form.event.pr.result.failure.label')
    case 'error':
      return t('automation.form.event.pr.result.error.label')
  }
}

function sessionKindLabel(kind: SessionKind): string {
  switch (kind) {
    case 'work':
      return t('automation.form.event.sessionKind.work.label')
    case 'intent':
      return t('automation.form.event.sessionKind.intent.label')
    case 'discussion':
      return t('automation.form.event.sessionKind.discussion.label')
    case 'automation':
      return t('automation.form.event.sessionKind.automation.label')
    case 'consensus':
      return t('automation.form.event.sessionKind.consensus.label')
    case 'tool':
      return t('automation.form.event.sessionKind.tool.label')
    case 'spec':
      return t('automation.form.event.sessionKind.spec.label')
  }
}

const eventTopic = computed(() => eventTopicLabel(props.automation?.eventTopic ?? null))
const reasonFilter = computed(() => props.automation?.eventReasonFilter?.map(reasonLabel) ?? [])
const metadataEntries = computed(() => Object.entries(props.automation?.metadata ?? {}))
const sessionKindFilterLabels = computed(
  () => props.automation?.eventSessionKindFilter?.map(sessionKindLabel) ?? [],
)
const isRunLifecycleTopic = computed(
  () =>
    props.automation?.eventTopic === 'run:started' ||
    props.automation?.eventTopic === 'run:settled',
)
const metadataConditionText = computed(() => {
  const filter = props.automation?.eventMetadataFilter
  if (!filter?.conditions.length) return ''
  const joiner =
    filter.combinator === 'OR'
      ? ` ${t('automation.form.event.metadataFilter.or')} `
      : ` ${t('automation.form.event.metadataFilter.and')} `
  return filter.conditions.map((c) => `${c.key}=${c.value}`).join(joiner)
})
const prOperationFilter = computed(
  () => props.automation?.eventPrFilter?.operations?.map(prOperationLabel) ?? [],
)
const prResultFilter = computed(
  () => props.automation?.eventPrFilter?.results?.map(prResultLabel) ?? [],
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

// ---- Simulate trigger (diagnostic) ----------------------------------------
const isEventAutomation = computed(() => props.automation?.triggerType === 'event')

const SIM_TOPICS: ScheduleEventTopic[] = [
  'run:started',
  'run:settled',
  'pr:operation',
  'intent:lifecycle',
]
const simTopic = ref<ScheduleEventTopic>('run:settled')
const simSessionKind = ref<SessionKind>('work')
const simReason = ref<RunEndReason>('complete')
const simOperation = ref<PrOperation>('merge')
const simResult = ref<PrOperationResult>('success')
const simPhase = ref<IntentLifecyclePhase>('done')
const simMetadataRows = ref<{ key: string; value: string }[]>([])

// Reset the simulate form to the selected automation's configured topic on change.
watch(
  () => props.automation?.id,
  () => {
    simTopic.value = props.automation?.eventTopic ?? 'run:settled'
    simMetadataRows.value = []
  },
  { immediate: true },
)

const simIsRunLifecycle = computed(
  () => simTopic.value === 'run:started' || simTopic.value === 'run:settled',
)

const SIM_SESSION_KIND_OPTIONS = computed(() =>
  SESSION_KINDS.map((value) => ({ value, label: sessionKindLabel(value) })),
)
const SIM_REASON_OPTIONS = computed(() =>
  (['complete', 'error', 'aborted'] as RunEndReason[]).map((value) => ({
    value,
    label: reasonLabel(value),
  })),
)
const SIM_OPERATION_OPTIONS = computed(() =>
  PR_OPERATIONS.map((value) => ({ value, label: prOperationLabel(value) })),
)
const SIM_RESULT_OPTIONS = computed(() =>
  PR_OPERATION_RESULTS.map((value) => ({ value, label: prResultLabel(value) })),
)
const SIM_PHASE_OPTIONS = computed(() =>
  INTENT_LIFECYCLE_PHASES.map((value) => ({ value, label: value })),
)

function topicLabelFull(topic: ScheduleEventTopic): string {
  switch (topic) {
    case 'run:started':
      return t('automation.form.event.topic.started.label')
    case 'run:settled':
      return t('automation.form.event.topic.settled.label')
    case 'pr:operation':
      return t('automation.form.event.topic.prOperation.label')
    case 'intent:lifecycle':
      return t('automation.form.event.topic.intentLifecycle.label')
  }
}

function addSimMetadataRow(): void {
  simMetadataRows.value.push({ key: '', value: '' })
}
function removeSimMetadataRow(index: number): void {
  simMetadataRows.value.splice(index, 1)
}

function runSimulate(): void {
  const automation = props.automation
  if (!automation) return
  const metadata: Record<string, string> = {}
  for (const row of simMetadataRows.value) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (key && value) metadata[key] = value
  }
  emit('simulate', {
    automationId: automation.id,
    topic: simTopic.value,
    sessionKind: simIsRunLifecycle.value ? simSessionKind.value : undefined,
    reason: simTopic.value === 'run:settled' ? simReason.value : undefined,
    metadata: simIsRunLifecycle.value && Object.keys(metadata).length ? metadata : undefined,
    operation: simTopic.value === 'pr:operation' ? simOperation.value : undefined,
    result: simTopic.value === 'pr:operation' ? simResult.value : undefined,
    phase: simTopic.value === 'intent:lifecycle' ? simPhase.value : undefined,
  })
}

// The result belongs to this automation (guard against a stale result for another).
const currentResult = computed(() =>
  props.simulationResult && props.simulationResult.automationId === props.automation?.id
    ? props.simulationResult
    : null,
)

function breakdownLabel(name: string): string {
  switch (name) {
    case 'topic':
      return t('automation.simulate.dim.topic')
    case 'workspace':
      return t('automation.simulate.dim.workspace')
    case 'sessionKind':
      return t('automation.simulate.dim.sessionKind')
    case 'reason':
      return t('automation.simulate.dim.reason')
    case 'pr':
      return t('automation.simulate.dim.pr')
    case 'intentPhase':
      return t('automation.simulate.dim.intentPhase')
    case 'metadata':
      return t('automation.simulate.dim.metadata')
    default:
      return name
  }
}
</script>

<template>
  <div v-if="automation" class="sched-detail-wrap">
    <div class="sched-detail-head">
      <span class="sched-detail-title">{{ t('automation.list.title.label') }}</span>
      <span class="sched-detail-id mono">{{ automation.id }}</span>
    </div>

    <div class="sched-detail-body">
      <!-- Vendor -->
      <div class="sd-row">
        <span class="sd-label">{{ t('automation.form.vendor.label') }}</span>
        <span class="sd-value sd-value--vendor">
          <span class="vendor-dot" :style="{ backgroundColor: vendorDotBg(automation.vendor) }" />
          {{ vendorLabel(automation.vendor) }}
        </span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('automation.form.agent.label') }}</span>
        <span class="sd-value">{{ agentLabel }}</span>
      </div>

      <!-- mode -->
      <div class="sd-row">
        <span class="sd-label">{{ t('automation.meta.mode.label') }}</span>
        <span class="sd-value">{{ modeLabel(automation.mode) }}</span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('automation.form.taskType.label') }}</span>
        <span class="sd-value">{{
          automation.type === 'command'
            ? t('automation.form.type.command.label')
            : t('automation.form.type.llm.label')
        }}</span>
      </div>

      <div class="sd-row sd-row--content">
        <span class="sd-label">{{
          automation.type === 'command'
            ? t('automation.form.command.label')
            : t('automation.form.prompt.label')
        }}</span>
        <code class="sd-task-content">{{ taskContent }}</code>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('automation.form.maxWallClockMs.label') }}</span>
        <span class="sd-value">{{ timeout }}</span>
      </div>

      <div class="sd-row">
        <span class="sd-label">{{ t('automation.form.trigger.label') }}</span>
        <span class="sd-value">{{
          automation.triggerType === 'cron'
            ? t('automation.form.trigger.cron.label')
            : t('automation.form.trigger.event.label')
        }}</span>
      </div>

      <template v-if="automation.triggerType === 'event'">
        <div class="sd-row">
          <span class="sd-label">{{ t('automation.form.event.topic.label') }}</span>
          <span class="sd-value">{{ eventTopic }}</span>
        </div>
        <div v-if="automation.eventTopic === 'run:settled'" class="sd-row sd-row--content">
          <span class="sd-label">{{ t('automation.form.event.reason.label') }}</span>
          <span v-if="reasonFilter.length" class="sd-value">{{ reasonFilter.join(' · ') }}</span>
          <span v-else class="sd-value sd-value--hint">{{
            t('automation.form.event.reason.hint')
          }}</span>
        </div>
        <template v-if="isRunLifecycleTopic">
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('automation.form.event.sessionKind.label') }}</span>
            <span v-if="sessionKindFilterLabels.length" class="sd-value">{{
              sessionKindFilterLabels.join(' · ')
            }}</span>
            <span v-else class="sd-value sd-value--hint">—</span>
          </div>
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('automation.form.event.metadataFilter.label') }}</span>
            <span v-if="metadataConditionText" class="sd-value mono">{{
              metadataConditionText
            }}</span>
            <span v-else class="sd-value sd-value--hint">{{
              t('automation.form.event.metadataFilter.none')
            }}</span>
          </div>
        </template>
        <template v-if="automation.eventTopic === 'pr:operation'">
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('automation.form.event.pr.op.label') }}</span>
            <span v-if="prOperationFilter.length" class="sd-value">{{
              prOperationFilter.join(' · ')
            }}</span>
            <span v-else class="sd-value sd-value--hint">{{
              t('automation.form.event.pr.hint')
            }}</span>
          </div>
          <div class="sd-row sd-row--content">
            <span class="sd-label">{{ t('automation.form.event.pr.result.label') }}</span>
            <span v-if="prResultFilter.length" class="sd-value">{{
              prResultFilter.join(' · ')
            }}</span>
            <span v-else class="sd-value sd-value--hint">{{
              t('automation.form.event.pr.hint')
            }}</span>
          </div>
        </template>
      </template>

      <div v-if="automation.triggerType === 'cron'" class="sd-row sd-row--automation">
        <span class="sd-label">{{ t('automation.form.automation.label') }}</span>
        <code class="sd-cron">{{ automation.cronExpression }}</code>
        <span class="sd-cron-description">{{ cronDescription }}</span>
      </div>

      <!-- Tool Allowlist -->
      <div class="sd-section">
        <h4 class="sd-section-title">{{ t('automation.form.tools.label') }}</h4>

        <!-- 空列表:全部工具无限制 -->
        <p v-if="allowlistCount === 0" class="sd-tools-empty">
          {{ t('automation.list.toolSummaryAll') }}
        </p>

        <ul v-else class="sd-tool-list">
          <li
            v-for="name in automation.toolAllowlist"
            :key="name"
            data-testid="sd-tool-item"
            class="sd-tool-item"
          >
            {{ name }}
          </li>
        </ul>
      </div>

      <!-- Metadata annotations -->
      <div class="sd-section">
        <h4 class="sd-section-title">{{ t('automation.form.metadata.label') }}</h4>
        <p v-if="!metadataEntries.length" class="sd-tools-empty">
          {{ t('automation.detail.metadata.empty') }}
        </p>
        <ul v-else class="sd-tool-list">
          <li
            v-for="[key, value] in metadataEntries"
            :key="key"
            data-testid="sd-metadata-item"
            class="sd-tool-item"
          >
            {{ key }}={{ value }}
          </li>
        </ul>
      </div>

      <!-- Simulate trigger (diagnostic; event automations only) -->
      <div v-if="isEventAutomation" class="sd-section" data-testid="automation-simulate">
        <h4 class="sd-section-title">{{ t('automation.simulate.title') }}</h4>
        <p class="sd-tools-empty">{{ t('automation.simulate.hint') }}</p>

        <div class="sd-sim-row">
          <span class="sd-label">{{ t('automation.simulate.topic.label') }}</span>
          <select v-model="simTopic" class="sd-sim-select">
            <option v-for="topic in SIM_TOPICS" :key="topic" :value="topic">
              {{ topicLabelFull(topic) }}
            </option>
          </select>
        </div>

        <template v-if="simIsRunLifecycle">
          <div class="sd-sim-row">
            <span class="sd-label">{{ t('automation.form.event.sessionKind.label') }}</span>
            <select v-model="simSessionKind" class="sd-sim-select">
              <option v-for="opt in SIM_SESSION_KIND_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div v-if="simTopic === 'run:settled'" class="sd-sim-row">
            <span class="sd-label">{{ t('automation.form.event.reason.label') }}</span>
            <select v-model="simReason" class="sd-sim-select">
              <option v-for="opt in SIM_REASON_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="sd-sim-metadata">
            <span class="sd-label">{{ t('automation.simulate.metadata.label') }}</span>
            <div
              v-for="(row, i) in simMetadataRows"
              :key="`sim-meta-${i}`"
              class="sd-sim-kv"
              data-testid="sim-metadata-row"
            >
              <input
                v-model="row.key"
                class="sd-sim-input"
                :placeholder="t('automation.form.metadata.keyPlaceholder')"
              />
              <span class="sd-kv-eq">=</span>
              <input
                v-model="row.value"
                class="sd-sim-input"
                :placeholder="t('automation.form.metadata.valuePlaceholder')"
              />
              <button
                type="button"
                class="sd-kv-del"
                :aria-label="t('automation.form.metadata.remove')"
                @click="removeSimMetadataRow(i)"
              >
                ✕
              </button>
            </div>
            <button type="button" class="sd-kv-add" @click="addSimMetadataRow">
              + {{ t('automation.form.metadata.add') }}
            </button>
          </div>
        </template>

        <template v-else-if="simTopic === 'pr:operation'">
          <div class="sd-sim-row">
            <span class="sd-label">{{ t('automation.form.event.pr.op.label') }}</span>
            <select v-model="simOperation" class="sd-sim-select">
              <option v-for="opt in SIM_OPERATION_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="sd-sim-row">
            <span class="sd-label">{{ t('automation.form.event.pr.result.label') }}</span>
            <select v-model="simResult" class="sd-sim-select">
              <option v-for="opt in SIM_RESULT_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </template>

        <template v-else-if="simTopic === 'intent:lifecycle'">
          <div class="sd-sim-row">
            <span class="sd-label">{{ t('automation.form.event.intent.label') }}</span>
            <select v-model="simPhase" class="sd-sim-select">
              <option v-for="opt in SIM_PHASE_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </template>

        <button
          type="button"
          class="sd-sim-run"
          data-testid="automation-simulate-run"
          @click="runSimulate"
        >
          {{ t('automation.simulate.run') }}
        </button>

        <div v-if="currentResult" class="sd-sim-result" data-testid="automation-simulate-result">
          <span
            class="sd-sim-verdict"
            :class="currentResult.matched ? 'matched' : 'unmatched'"
            data-testid="automation-simulate-verdict"
          >
            {{
              currentResult.matched
                ? t('automation.simulate.matched')
                : t('automation.simulate.unmatched')
            }}
          </span>
          <ul class="sd-sim-breakdown">
            <li
              v-for="item in currentResult.breakdown"
              :key="item.name"
              class="sd-sim-dim"
              :class="{ pass: item.passed }"
            >
              <span class="sd-sim-dim-mark" aria-hidden="true">{{ item.passed ? '✓' : '✕' }}</span>
              {{ breakdownLabel(item.name) }}
            </li>
          </ul>
        </div>
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
.sd-row--automation {
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

.sd-value.mono {
  font-family: var(--ff-mono, monospace);
  overflow-wrap: anywhere;
}

/* ---- Simulate panel ---- */
.sd-sim-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.sd-sim-select {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 260px;
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text);
  font-size: var(--fs-caption);
  padding: 4px 6px;
}
.sd-sim-metadata {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sd-sim-kv {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.sd-sim-input {
  flex: 1 1 0;
  min-width: 0;
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text);
  font-size: var(--fs-caption);
  padding: 4px 6px;
}
.sd-kv-eq {
  color: var(--c-text-muted);
}
.sd-kv-del,
.sd-kv-add {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 3px 8px;
  cursor: pointer;
}
.sd-kv-add {
  align-self: flex-start;
}
.sd-kv-del:hover {
  color: var(--c-error);
  border-color: var(--c-error);
}
.sd-kv-add:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.sd-sim-run {
  align-self: flex-start;
  background: var(--c-primary);
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  color: #fff;
  font-size: var(--fs-caption);
  padding: 5px 14px;
  cursor: pointer;
}
.sd-sim-run:hover {
  opacity: 0.9;
}
.sd-sim-result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-card);
}
.sd-sim-verdict {
  font-weight: 600;
  font-size: var(--fs-caption);
}
.sd-sim-verdict.matched {
  color: var(--c-success);
}
.sd-sim-verdict.unmatched {
  color: var(--c-error);
}
.sd-sim-breakdown {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sd-sim-dim {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-error);
}
.sd-sim-dim.pass {
  color: var(--c-success);
}
.sd-sim-dim-mark {
  width: 14px;
  flex-shrink: 0;
}
</style>
