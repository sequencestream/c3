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
import { computed } from 'vue'
import { describeCron } from '@ccc/shared/cron'
import type { AgentConfig, Automation, SessionKind, ToolManifestEntry } from '@ccc/shared/protocol'
import { hasRunLifecycleEventFilter } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  automation: Automation | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
  agents: AgentConfig[]
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

// The event trigger is summarized directly from the subscription rows: the raw
// event `type` strings, the union of raw `statuses` values, and the first row's
// metadata conditions (the form writes the same conditions onto every row).
const eventTypeText = computed(
  () => props.automation?.eventFilters?.map((f) => f.type).join(' · ') ?? '—',
)
const statusFilterLabels = computed(() => {
  const seen = new Set<string>()
  for (const f of props.automation?.eventFilters ?? []) {
    for (const s of f.statuses ?? []) seen.add(s)
  }
  return [...seen]
})
const metadataEntries = computed(() => Object.entries(props.automation?.metadata ?? {}))
const sessionKindFilterLabels = computed(
  () => props.automation?.eventSessionKindFilter?.map(sessionKindLabel) ?? [],
)
const isRunLifecycleType = computed(() =>
  hasRunLifecycleEventFilter(props.automation?.eventFilters),
)
const metadataConditionText = computed(() => {
  const filter = props.automation?.eventFilters?.find((f) => f.metadata)?.metadata
  if (!filter?.conditions.length) return ''
  const joiner =
    filter.combinator === 'OR'
      ? ` ${t('automation.form.event.metadataFilter.or')} `
      : ` ${t('automation.form.event.metadataFilter.and')} `
  return filter.conditions.map((c) => `${c.key}=${c.value}`).join(joiner)
})

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
          <span class="sd-label">{{ t('automation.form.event.type.label') }}</span>
          <span class="sd-value mono">{{ eventTypeText }}</span>
        </div>
        <div class="sd-row sd-row--content">
          <span class="sd-label">{{ t('automation.form.event.status.label') }}</span>
          <span v-if="statusFilterLabels.length" class="sd-value mono">{{
            statusFilterLabels.join(' · ')
          }}</span>
          <span v-else class="sd-value sd-value--hint">{{
            t('automation.form.event.status.hint')
          }}</span>
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
        <div v-if="isRunLifecycleType" class="sd-row sd-row--content">
          <span class="sd-label">{{ t('automation.form.event.sessionKind.label') }}</span>
          <span v-if="sessionKindFilterLabels.length" class="sd-value">{{
            sessionKindFilterLabels.join(' · ')
          }}</span>
          <span v-else class="sd-value sd-value--hint">—</span>
        </div>
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
</style>
